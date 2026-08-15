// dsh-windows-notify —— 通知引擎(宿主插件内核)。
// 从 apply-patch 时代的 v13 模块移植,改为插件形态:
//   · 配置来自 settings 命名空间 dsh-notify(由 lib/index.js 注入 configProvider);
//   · 状态文件(tray-state.json / 托盘锁)与插件数据目录放在 $DSH_HOME/dsh-windows-notify;
//   · 托盘进程按 webServer 实际端口启动(端口、状态文件、锁文件经 Base64 载荷传递)。
// 关键经验(照旧遵守):
//   · 所有载荷经 Base64 传递(Node spawn 在 Windows 上不转义参数,`&` 会截断命令行);
//   · PowerShell 用绝对路径(宿主 PATH 可能不含 System32);
//   · 不用 detached/unref(本机上 detached+unref 的子进程会被立即杀死);
//   · 所有操作尽力而为(best-effort):任何失败静默吞掉,绝不干扰主流程。
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = path.join(HERE, "..", "assets");
const SCRIPTS = path.join(HERE, "..", "scripts");
const TOAST_SCRIPT = path.join(SCRIPTS, "toast.ps1");
const TRAY_SCRIPT = path.join(SCRIPTS, "tray.ps1");

/** 四套提示音(assets/ 下的 wav,与设置页展示一一对应)。 */
export const SOUND_PRESETS = {
  soft: { id: "soft", label: "柔和（默认）", desc: "叮—咚双音，马林巴音色，平稳舒缓", file: "dsh-notify-soft.wav" },
  brisk: { id: "brisk", label: "轻快", desc: "三连音上行，节奏明快", file: "dsh-notify-brisk.wav" },
  calm: { id: "calm", label: "舒缓", desc: "低八度双音，更慢更长", file: "dsh-notify-calm.wav" },
  crisp: { id: "crisp", label: "清脆", desc: "明亮短促，高音为主", file: "dsh-notify-crisp.wav" },
};

const ENABLED = !["0", "false", "off"].includes(String(process.env.DSH_NOTIFY ?? "").toLowerCase());
const MIN_INTERVAL_MS = Math.max(0, Number(process.env.DSH_NOTIFY_MIN_INTERVAL_MS ?? 2500)) || 2500;
const COMPLETE_MERGE_WINDOW_MS = 5000;
const POWERSHELL = process.env.SystemRoot
  ? path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
  : "C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";

/** 默认配置(settings 命名空间 schema 的镜像,首启时由 schema 默认值兜底)。 */
export function defaultConfig() {
  return {
    sound: "soft",
    soundEnabled: true,
    quietHours: { enabled: false, start: "22:00", end: "08:00" },
    respectSystemDnd: true,
    completeMode: "toast", // "toast" | "badge-only"
    completeMerge: true,
  };
}

/** 把任何半残配置值折叠成默认形状(防御式)。 */
export function normalizeConfig(parsed) {
  const base = defaultConfig();
  if (parsed === null || typeof parsed !== "object") return base;
  if (typeof parsed.sound === "string" && SOUND_PRESETS[parsed.sound] !== void 0) base.sound = parsed.sound;
  if (typeof parsed.soundEnabled === "boolean") base.soundEnabled = parsed.soundEnabled;
  if (parsed.quietHours !== null && typeof parsed.quietHours === "object") {
    if (typeof parsed.quietHours.enabled === "boolean") base.quietHours.enabled = parsed.quietHours.enabled;
    if (typeof parsed.quietHours.start === "string" && /^\d{1,2}:\d{2}$/.test(parsed.quietHours.start)) base.quietHours.start = parsed.quietHours.start;
    if (typeof parsed.quietHours.end === "string" && /^\d{1,2}:\d{2}$/.test(parsed.quietHours.end)) base.quietHours.end = parsed.quietHours.end;
  }
  if (typeof parsed.respectSystemDnd === "boolean") base.respectSystemDnd = parsed.respectSystemDnd;
  if (parsed.completeMode === "toast" || parsed.completeMode === "badge-only") base.completeMode = parsed.completeMode;
  if (typeof parsed.completeMerge === "boolean") base.completeMerge = parsed.completeMerge;
  return base;
}

function minutesOf(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

/** 是否处于免打扰时段(支持跨午夜窗口)。 */
export function inQuietHours(quietHours) {
  try {
    const start = minutesOf(quietHours.start);
    const end = minutesOf(quietHours.end);
    if (start === end) return false;
    const now = new Date();
    const current = now.getHours() * 60 + now.getMinutes();
    if (start < end) return current >= start && current < end;
    return current >= start || current < end; // 跨午夜
  } catch {
    return false;
  }
}

function soundPathFor(name) {
  const preset = SOUND_PRESETS[name] ?? SOUND_PRESETS.soft;
  const file = path.join(ASSETS, preset.file);
  return existsSync(file) ? file : path.join(ASSETS, "dsh-notify.wav");
}

/**
 * 创建一套通知内核。所有副作用(托盘进程、Toast 进程、状态文件)都收敛在这里。
 * @param {{ stateDir: string, portProvider: () => number, configProvider: () => object, logger?: { info/warn } }} options
 *   stateDir —— 状态文件目录($DSH_HOME/dsh-windows-notify);
 *   portProvider —— 当前 webServer 端口(托盘打开 GUI 与看门狗用);
 *   configProvider —— 当前已解析的 settings 配置(热加载后自动读到新值)。
 */
export function createNotifyCore({ stateDir, portProvider, configProvider, logger = null }) {
  const TRAY_STATE_FILE = path.join(stateDir, "tray-state.json");
  const LOG_FILE = path.join(stateDir, "debug.log");
  let lastAt = 0;
  let trayStarted = false;
  let completeBuffer = [];
  let completeTimer = null;

  const log = (message) => {
    try {
      appendFileSync(LOG_FILE, `${new Date().toISOString()} notify ${message}\n`);
    } catch { /* 日志失败不影响提醒 */ }
  };
  const warn = (message) => {
    if (logger?.warn !== void 0) {
      try { logger.warn(`dsh-windows-notify: ${message}`); } catch { /* 忽略 */ }
    }
  };

  // ---------- 托盘角标状态 ----------
  function readTrayState() {
    try {
      let raw = readFileSync(TRAY_STATE_FILE, "utf8");
      if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1); // 兼容托盘端写回的 BOM
      const parsed = JSON.parse(raw);
      return {
        pending: typeof parsed.pending === "number" ? Math.max(0, parsed.pending) : 0,
        completed: Array.isArray(parsed.completed) ? parsed.completed.slice(0, 10) : [],
      };
    } catch {
      return { pending: 0, completed: [] };
    }
  }
  function writeTrayState(state) {
    try {
      writeFileSync(TRAY_STATE_FILE, JSON.stringify(state), "utf8");
    } catch { /* 状态文件写入失败不影响提醒 */ }
  }

  /** 懒启动托盘进程(随 DSH 运行;主机退出后它按端口看门狗自行退出)。 */
  function ensureTray() {
    if (trayStarted || process.platform !== "win32") return;
    trayStarted = true;
    try {
      const port = Math.max(1, Math.min(65535, Number(portProvider()) || 3080));
      const payload = {
        stateFile: TRAY_STATE_FILE,
        port,
        url: `http://127.0.0.1:${port}`,
        lockFile: path.join(stateDir, `tray-${port}.lock`),
      };
      const payloadB64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
      const child = spawn(POWERSHELL, [
        "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
        "-WindowStyle", "Hidden", "-File", TRAY_SCRIPT,
        "-PayloadB64", payloadB64,
      ], {
        // 注意:不要用 detached/unref —— 本机上 detached+unref 的子进程会被立即杀死
        stdio: "ignore",
        windowsHide: true,
      });
      child.once("error", () => {
        trayStarted = false; // 启动失败,下次再试
      });
      log(`tray spawn ok pid=${child.pid ?? "?"} port=${port}`);
    } catch (error) {
      trayStarted = false;
      warn(`tray 启动失败:${String(error?.message ?? error)}`);
    }
  }

  /**
   * 弹一个 Windows 级 Toast 提醒并播放提示音(受配置控制)。
   * @param {{title?: string, message?: string, detail?: string, sound?: string, soundOn?: boolean, ignoreQuiet?: boolean}} options
   */
  function notifyWindows({ title = "DeepSeek Harness", message = "", detail = void 0, sound = void 0, soundOn = void 0, ignoreQuiet = false } = {}) {
    if (process.platform !== "win32" || !ENABLED) return;
    ensureTray();
    const now = Date.now();
    if (now - lastAt < MIN_INTERVAL_MS) return; // 节流,避免连环弹窗
    lastAt = now;
    try {
      const config = normalizeConfig(configProvider?.() ?? {});
      const enabled = soundOn === void 0 ? config.soundEnabled : soundOn;
      const soundName = sound ?? config.sound;
      const soundPath = process.env.DSH_NOTIFY_SOUND ?? soundPathFor(soundName);
      // 免打扰时段仅在开关 enabled 时生效(明确的试听等主动操作可 ignoreQuiet 绕过)
      const quietHours = config.quietHours ?? {};
      const quiet = !ignoreQuiet && quietHours.enabled === true && inQuietHours(quietHours) ? "badge-only" : "none";
      const payload = {
        line1: String(title).slice(0, 200),
        line2: String(message).slice(0, 300),
        line3: detail !== void 0 && String(detail).length > 0 ? String(detail).slice(0, 300) : "",
        sound: enabled ? soundPath : "",
        mute: !enabled,
        quiet,
        respectSystemDnd: config.respectSystemDnd === true,
        actions: [],
        logFile: LOG_FILE,
      };
      const payloadB64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
      const child = spawn(POWERSHELL, [
        "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
        "-WindowStyle", "Hidden", "-File", TOAST_SCRIPT,
        "-PayloadB64", payloadB64,
      ], {
        stdio: "ignore",
        windowsHide: true,
      });
      child.once("error", (error) => log(`spawn error: ${String(error?.message ?? error)}`));
      log(`spawn ok pid=${child.pid ?? "?"} quiet=${quiet}`);
    } catch (error) {
      log(`notifyWindows threw: ${String(error?.message ?? error)}`);
      /* 尽力而为:通知失败不影响主流程 */
    }
  }

  // ---------- 完成通知(分级 / 合并摘要) ----------
  function queueComplete(item) {
    completeBuffer.push(item);
    if (completeBuffer.length > 20) completeBuffer = completeBuffer.slice(-20);
    if (completeTimer !== null) clearTimeout(completeTimer);
    completeTimer = setTimeout(flushComplete, COMPLETE_MERGE_WINDOW_MS);
  }
  function flushComplete() {
    completeTimer = null;
    const items = completeBuffer.splice(0);
    if (items.length === 0) return;
    if (items.length === 1) {
      notifyWindows({ title: "DSH 任务完成 ✅", message: items[0].line2, detail: items[0].line3 });
      return;
    }
    const titles = items.map((item) => item.itemTitle).filter((t) => t.length > 0);
    notifyWindows({
      title: `DSH 任务完成 ✅（${items.length}）`,
      message: `${items.length} 个任务已完成`,
      detail: titles.length > 0 ? titles.join(" / ").slice(0, 160) : "点击托盘图标或回到界面查看",
    });
  }

  /**
   * 完成通知入口(由 agent/status → idle 转换触发):
   * - completeMode=badge-only → 只累计角标,不弹窗不响铃;
   * - completeMerge=true → 5 秒窗口内合并为一条摘要;
   * - 其余走即时 Toast。
   */
  function notifyComplete(itemTitle, line2, line3) {
    const config = normalizeConfig(configProvider?.() ?? {});
    if (config.completeMode === "badge-only") return;
    if (config.completeMerge) {
      queueComplete({ itemTitle: String(itemTitle ?? ""), line2: String(line2 ?? ""), line3: String(line3 ?? "") });
      return;
    }
    notifyWindows({ title: "DSH 任务完成 ✅", message: String(line2 ?? ""), detail: String(line3 ?? "") });
  }

  /** 试听:强制播放指定预设(忽略静音配置与免打扰时段——这是用户的主动试听动作)。 */
  function previewSound(name) {
    const preset = SOUND_PRESETS[name] ?? SOUND_PRESETS.soft;
    notifyWindows({
      title: "DSH 提示音试听",
      message: `${preset.label} · ${preset.desc}`,
      sound: preset.id,
      soundOn: true,
      ignoreQuiet: true,
    });
  }

  /** 待回复决策数增减(提问 +1,回答/取消 -1)。 */
  function updateTrayPending(delta) {
    const state = readTrayState();
    state.pending = Math.max(0, state.pending + (typeof delta === "number" ? delta : 0));
    writeTrayState(state);
    ensureTray();
  }

  /** 任务完成但尚未查看:按会话去重登记。 */
  function addTrayCompleted(sessionId, title) {
    const state = readTrayState();
    state.completed = state.completed.filter((entry) => entry.sessionId !== sessionId);
    state.completed.push({ sessionId: String(sessionId ?? ""), title: String(title ?? "").slice(0, 60) });
    state.completed = state.completed.slice(-10);
    writeTrayState(state);
    ensureTray();
  }

  /** 点击托盘图标后:已完成未查看清零(托盘脚本自己写文件,这里仅为内核侧 API 对齐保留)。 */
  function clearTrayCompleted() {
    const state = readTrayState();
    state.completed = [];
    writeTrayState(state);
  }

  return {
    notifyWindows,
    notifyComplete,
    previewSound,
    updateTrayPending,
    addTrayCompleted,
    clearTrayCompleted,
    ensureTray,
    readTrayState,
    writeTrayState,
  };
}
