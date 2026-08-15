// dsh-windows-notify —— DSH Windows 提醒插件(宿主半边,零侵入)。
//
// 挂载点全部走 DSH 原生 seam,不改任何内置包文件:
//   1. `ctx.on("agent/status", ...)`:根 Agent 回合结束(running→idle)时按完成分级
//      (badge-only / 5s 合并摘要 / 即时 Toast)发完成通知,并登记托盘角标;
//   2. 包装 `userQuestions` 服务的 ask():提问时发「需要你的决定」提醒 + 角标 +1,
//      回答/取消后角标 -1(ask 结算时);
//   3. `installSettingsSection`:注册 settings 命名空间 `dsh-notify`
//      (提示音/静音/免打扰时段/系统勿扰跟随/完成模式/合并),保存即生效;
//   4. `ctx.webServer.register`:`/api/dsh-notify/preview` 试听路由;
//   5. 惰性启动托盘进程(端口看门狗,DSH 退出后自行退出)。
//
// 与 apply-patch 旧版共存守卫:若内置 apiproxy/agent-loop 文件里检测到旧钩子标记
// (fireQuestionToast / notifyComplete),对应能力自动让位,避免双份提醒;
// 干净迁移建议直接用 install.mjs(它会还原旧补丁备份)。
import { createRequire } from "node:module";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import z from "@deepseek-ai/schemastery";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { installSettingsSection, settingsNamespace } from "@deepseek-ai/dsh-settings";
import { SOUND_PRESETS, createNotifyCore, defaultConfig, normalizeConfig } from "./notify-core.js";

/** Cordis 插件名(loader 诊断用)。 */
export const name = "dsh-windows-notify";
/** 依赖的服务:提问包装需要 userQuestions(settings 由 installSettingsSection 自行注入)。 */
export const inject = ["userQuestions"];

/** settings 命名空间 dsh-notify 的 schema(默认值 = 出厂配置)。 */
const NotifySchema = z.object({
  sound: z.string().default("soft"),
  soundEnabled: z.boolean().default(true),
  quietHours: z.object({
    enabled: z.boolean().default(false),
    start: z.string().default("22:00"),
    end: z.string().default("08:00"),
  }).default({ enabled: false, start: "22:00", end: "08:00" }),
  respectSystemDnd: z.boolean().default(true),
  completeMode: z.union([z.const("toast"), z.const("badge-only")]).default("toast"),
  completeMerge: z.boolean().default(true),
});

const NS = settingsNamespace("dsh-notify");
const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 解析某内置包入口文件,检测旧 apply-patch 钩子标记是否仍在(共存守卫)。 */
function legacyHookActive(ctx, packageName, marker) {
  try {
    const req = createRequire(ctx.baseUrl ?? import.meta.url);
    const resolved = req.resolve(packageName);
    return readFileSync(resolved, "utf8").includes(marker);
  } catch {
    return false;
  }
}

/** 会话标题(尽力而为)。 */
function sessionTitleOf(session) {
  try {
    const event = session?.events?.findLast?.((item) => item?.type === "session/title");
    const title = event?.data?.title;
    if (typeof title === "string" && title.length > 0) return title;
    return typeof session?.title === "string" && session.title.length > 0 ? session.title : void 0;
  } catch {
    return void 0;
  }
}

/** 最后一条助手消息的开头片段(尽力而为)。 */
function lastAssistantSnippet(session, maxChars) {
  try {
    const events = Array.isArray(session?.events) ? session.events : [];
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (event?.type !== "assistant/message") continue;
      const blocks = event?.data?.content;
      if (!Array.isArray(blocks)) continue;
      for (const block of blocks) {
        if (block?.type === "text" && typeof block.text === "string" && block.text.trim().length > 0) {
          const text = block.text.replace(/\s+/g, " ").trim();
          return text.length > maxChars ? text.slice(0, maxChars) + "…" : text;
        }
      }
    }
  } catch { /* 片段可选 */ }
  return "";
}

/** 目标是武装态自动续跑(goal 轮次未跑完)→ 跳过完成提醒,与旧钩子语义一致。 */
function isAutoContinuing(ctx, agent) {
  try {
    const goal = ctx?.get?.("goals")?.get?.(agent);
    return goal !== void 0 && goal.phase === "active" && goal.activation === "armed" && (goal.maxGoalRounds === void 0 || goal.roundsStarted < goal.maxGoalRounds);
  } catch {
    return false;
  }
}

/**
 * 包装 userQuestions.ask:提问时提醒 + 角标 +1,结算(回答/取消/报错)后角标 -1。
 * 仅当旧 apiproxy 钩子不存在时才包装(避免双份提醒)。返回还原函数。
 */
function wrapUserQuestions(ctx, core) {
  const service = ctx.get("userQuestions");
  if (service === void 0 || typeof service.ask !== "function" || service.ask.__dshNotifyWrapped === true) return null;
  const original = service.ask;
  const wrapped = async function (request) {
    const questions = Array.isArray(request?.questions) ? request.questions : [];
    const first = questions[0];
    if (first !== void 0) {
      try {
        const single = questions.length === 1;
        const options = single && first.multiSelect !== true ? first.options ?? [] : [];
        const isPlanReview = first.intent?.kind === "plan-review";
        let title = isPlanReview ? "DSH 计划等待审批 📋" : "DSH 需要你的决定 ❓";
        const session = request?.agent?.session;
        const sessionTitle = sessionTitleOf(session);
        if (sessionTitle !== void 0) title += ` · ${sessionTitle}`;
        const question = typeof first.question === "string" && first.question.length > 0 ? first.question : "等待你的回复，任务才会继续";
        const labels = options.map((option) => option.label).filter((label) => typeof label === "string" && label.length > 0);
        core.updateTrayPending(1);
        core.notifyWindows({
          title,
          message: question.length > 120 ? question.slice(0, 117) + "…" : question,
          detail: labels.length > 0 ? "选项：" + labels.join(" / ").slice(0, 160) : single ? "开放题，请到界面里回答" : "包含多个问题，请到界面里回答",
        });
      } catch { /* 提醒尽力而为 */ }
    }
    try {
      return await original.call(this, request);
    } finally {
      try { core.updateTrayPending(-1); } catch { /* 角标结算尽力而为 */ }
    }
  };
  wrapped.__dshNotifyWrapped = true;
  service.ask = wrapped;
  return () => {
    if (service.ask === wrapped) service.ask = original;
  };
}

export async function apply(ctx, config) {
  const STATE_DIR = path.join(resolveDshHome(), "dsh-windows-notify");

  // ---- 旧 apply-patch 钩子共存守卫:有旧钩子就让位,不重复提醒 ----
  const legacyQuestions = legacyHookActive(ctx, "@deepseek-ai/dsh-host-apiproxy", "fireQuestionToast");
  const legacyComplete = legacyHookActive(ctx, "@deepseek-ai/dsh-agent-loop", "notifyComplete");
  if (legacyQuestions || legacyComplete) {
    ctx.logger.warn(
      `dsh-windows-notify: 检测到旧版 apply-patch 钩子(${[legacyQuestions ? "提问提醒" : "", legacyComplete ? "完成提醒" : ""].filter(Boolean).join("、")})仍在内置包里,对应能力由旧钩子接管;建议运行 install.mjs(自动还原旧备份)后重启,切换到插件独占模式`,
    );
  }

  // ---- settings 命名空间:配置权威源,浏览器保存 → 宿主热加载 ----
  let getConfig = () => ({ ...defaultConfig(), ...(config ?? {}) });
  installSettingsSection(ctx, NS, NotifySchema, config ?? {}, {
    setSource: (source) => {
      getConfig = source;
    },
    onChange: () => {
      // 内核每次通知都经 configProvider 读取最新配置,这里无需额外动作
    },
  });

  // ---- 通知内核(状态文件与托盘锁都落在 $DSH_HOME/dsh-windows-notify) ----
  const core = createNotifyCore({
    stateDir: STATE_DIR,
    portProvider: () => {
      try { return ctx.get("webServer")?.port ?? 3080; } catch { return 3080; }
    },
    configProvider: () => normalizeConfig(getConfig()),
    logger: ctx.logger,
  });

  // ---- 一次性迁移:apply-patch 时代的 config.json → settings 命名空间 ----
  ctx.inject(["settings"], async (sctx) => {
    const seedPath = path.join(STATE_DIR, "seed-config.json");
    try {
      if (!existsSync(seedPath)) return;
      let raw = readFileSync(seedPath, "utf8");
      if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
      const seed = normalizeConfig(JSON.parse(raw));
      if (sctx.settings.section(NS) === void 0) await sctx.settings.replace(NS, seed);
      unlinkSync(seedPath); // 只迁移一次
      ctx.logger.info("dsh-windows-notify: 已把旧版配置迁移到 settings 命名空间 dsh-notify");
    } catch { /* 迁移失败不影响运行 */ }
  });

  // ---- 完成提醒:根 Agent 回合结束(running→idle) ----
  if (!legacyComplete) {
    const lastStatus = new Map();
    ctx.on("agent/status", ({ agent, status }) => {
      try {
        const previous = lastStatus.get(agent) ?? "idle";
        lastStatus.set(agent, status);
        if (status !== "idle" || previous === "idle") return;
        // 只有根 Agent 结束回合才提醒;子代理的完成不打扰
        const agents = ctx.get("agents");
        if (agents !== void 0 && !agents.roots().includes(agent)) return;
        // goal 自动续跑时不提醒(下一轮马上开始),与旧钩子语义一致
        if (isAutoContinuing(ctx, agent)) return;
        const title = sessionTitleOf(agent.session);
        const snippet = lastAssistantSnippet(agent.session, 100);
        core.addTrayCompleted(agent.id, title ?? "");
        core.notifyComplete(
          title,
          title !== void 0 ? `会话：${title}` : "回合结束，可以回来查看结果了",
          snippet,
        );
      } catch (error) {
        ctx.logger.warn(`dsh-windows-notify: 完成提醒失败:${String(error?.message ?? error)}`);
      }
    });
  }

  // ---- 提问提醒:包装 userQuestions(有旧钩子时让位) ----
  if (!legacyQuestions) {
    const restoreAsk = wrapUserQuestions(ctx, core);
    if (restoreAsk !== null) ctx.effect(() => restoreAsk, "dsh-windows-notify: userQuestions 包装还原");
  }

  // ---- 试听路由:设置页「试听」按钮 → 宿主播放 ----
  // 注意:必须走 inject —— apply 运行时刻 webserver 的 fiber 可能尚未创建
  // (激活顺序由服务可用性驱动),直接 ctx.get("webServer") 会拿到 undefined。
  ctx.inject(["webServer"], (wctx) => {
    const webServer = wctx.get("webServer");
    const disposeRoute = webServer.register({
      kind: "exact",
      path: "/api/dsh-notify/preview",
      handler: async (req, res) => {
        try {
          let body = "";
          for await (const chunk of req) body += chunk;
          const parsed = body.length > 0 ? JSON.parse(body) : {};
          const soundName = typeof parsed?.sound === "string" ? parsed.sound : "soft";
          if (SOUND_PRESETS[soundName] === void 0) {
            res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ ok: false, error: `未知提示音: ${soundName}` }));
            return;
          }
          core.previewSound(soundName);
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: true }));
        } catch (error) {
          res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false, error: String(error?.message ?? error) }));
        }
      },
    });
    wctx.effect(() => disposeRoute, "dsh-windows-notify: preview 路由");
  });

  ctx.logger.info(`dsh-windows-notify: 已挂载(提问提醒=${legacyQuestions ? "旧钩子" : "插件"}, 完成提醒=${legacyComplete ? "旧钩子" : "插件"})`);
}
