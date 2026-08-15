#!/usr/bin/env node
/**
 * dsh-windows-notify 接线脚本(幂等,可重复执行)。
 *
 *   node install.mjs [--profile <name>] [--dsh-home <dir>]
 *                    [--uninstall] [--keep-legacy] [--legacy-root <dir>]
 *
 * 安装时:
 *   1. 确保 profile 目录已初始化(缺失时按 web/headless 模板生成 manifest、
 *      cordis.patch.yml、pnpm-workspace.yaml —— 与 dsh 自身 initProfile 一致);
 *   2. 在 <DSH_HOME>/profiles/<profile>/node_modules 下创建指向本包目录的 junction
 *      (与 pnpm file: 依赖的软链接语义一致);
 *   3. 本包 node_modules 缺失时,链接到 <DSH_HOME>/profiles/node_modules
 *      (DSH 内置包扁平回退)—— 保证 @deepseek-ai/* 依赖可以从本包解析;
 *   4. 把 'dsh-windows-notify' 写入 profile package.json 的 dsh.profile.bundles 与 dependencies;
 *   5. [可选,默认开启] 还原旧 apply-patch 补丁:对仍带旧钩子标记的 4 个内置文件,
 *      从 npm registry 拉取同版本 (0.1.0-rc.6) 官方包并还原对应文件(与备份不同,
 *      registry 版本保证 pristine),随后 node --check 校验;--keep-legacy 跳过;
 *   6. 把旧版扩展的 config.json 复制为 $DSH_HOME/dsh-windows-notify/seed-config.json,
 *      插件首启时一次性迁移到 settings 命名空间 dsh-notify。
 *
 * 卸载时按相反顺序清理,并保留用户对 package.json 的其它修改。
 *
 * @module dsh-windows-notify/install
 */
import {
  copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync,
  rmSync, symlinkSync, unlinkSync, writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PKG_DIR = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && typeof args[i + 1] === "string" ? args[i + 1] : fallback;
};
const UNINSTALL = args.includes("--uninstall");
const KEEP_LEGACY = args.includes("--keep-legacy");
const PROFILE = flag("--profile", "web");
const DSH_HOME = flag("--dsh-home", process.env.DSH_HOME || join(homedir(), ".dsh"));
const LEGACY_ROOT = flag("--legacy-root", ""); // 仅在从旧版 apply-patch 扩展迁移时指定
const LEGACY_CONFIG = flag("--legacy-config", resolve(dirname(PKG_DIR), "config.json"));
const PROFILE_DIR = join(DSH_HOME, "profiles", PROFILE);
const LINK_PATH = join(PROFILE_DIR, "node_modules", "dsh-windows-notify");
const FALLBACK_MODULES = join(DSH_HOME, "profiles", "node_modules");
const PKG_MODULES = join(PKG_DIR, "node_modules");
const STATE_DIR = join(DSH_HOME, "dsh-windows-notify");

/** 旧 apply-patch 补丁清单:pkg、文件、旧钩子标记(package.json version 取自 registry 同版本)。 */
const LEGACY_FILES = [
  { pkg: "@deepseek-ai/dsh-host-apiproxy", leaf: "index.js", marker: "fireQuestionToast" },
  { pkg: "@deepseek-ai/dsh-agent-loop", leaf: "index.js", marker: "notifyComplete" },
  { pkg: "@deepseek-ai/dsh-client-connection", leaf: "client.js", marker: "notifyDescribe" },
  { pkg: "@deepseek-ai/dsh-client-ui-settings-general", leaf: "client.js", marker: "NotifySection" },
];
const LEGACY_VERSION = "0.1.0-rc.6";

function isLink(p) {
  try { return lstatSync(p).isSymbolicLink(); } catch { return false; }
}

function ensureJunction(link, target) {
  if (isLink(link)) {
    try {
      if (readlinkSync(link) === target) return "unchanged";
    } catch { /* 悬空或错误链接:重建 */ }
    unlinkSync(link);
  } else if (existsSync(link)) {
    throw new Error(`${link} 已存在且不是链接(真实目录)。如需接管请先手动移走该目录,再重跑本脚本。`);
  }
  mkdirSync(dirname(link), { recursive: true });
  if (!existsSync(target)) mkdirSync(target, { recursive: true }); // junction 目标必须存在(空目录会由 dsh 启动时填充)
  symlinkSync(target, link, "junction");
  return "created";
}

function removeJunctionIfOwned(link, ownedTargets) {
  if (!isLink(link)) return "skipped";
  let target = null;
  try { target = readlinkSync(link); } catch { /* 悬空链接 */ }
  if (target !== null && ownedTargets.includes(target)) {
    unlinkSync(link);
    return "removed";
  }
  return "skipped";
}

/** 按 web/headless 模板初始化缺失的 profile(与 dsh 的 initProfile 一致)。 */
function ensureProfileInitialized() {
  const manifestPath = join(PROFILE_DIR, "package.json");
  if (existsSync(manifestPath)) return "existing";
  mkdirSync(PROFILE_DIR, { recursive: true });
  const bundles = PROFILE === "headless"
    ? ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless"]
    : ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"];
  const manifest = {
    name: `dsh-profile-${PROFILE}`,
    private: true,
    dependencies: {},
    dsh: { profile: { bundles } },
  };
  writeFileSync(manifestPath, JSON.stringify(manifest, void 0, 2) + "\n");
  const patchPath = join(PROFILE_DIR, "cordis.patch.yml");
  if (!existsSync(patchPath)) {
    writeFileSync(patchPath, [
      "# Your patch layer for this dsh profile, applied after every bundle layer:",
      "# a top-level YAML array of loader patch entries (id-targeted config",
      "# overrides, disables, and insert lists; `!!js` expressions allowed).",
      "[]",
      "",
    ].join("\n"));
  }
  const workspacePath = join(PROFILE_DIR, "pnpm-workspace.yaml");
  if (!existsSync(workspacePath)) {
    writeFileSync(workspacePath, "packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n");
  }
  return `created(${bundles.join(", ")})`;
}

function updateManifest() {
  const manifestPath = join(PROFILE_DIR, "package.json");
  if (!existsSync(manifestPath)) throw new Error(`profile 不存在或未初始化:${PROFILE_DIR}`);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const bundles = manifest.dsh?.profile?.bundles;
  if (!Array.isArray(bundles)) throw new Error(`${manifestPath} 缺少 dsh.profile.bundles 数组,无法接入 bundle`);
  manifest.dependencies = manifest.dependencies || {};
  if (UNINSTALL) {
    delete manifest.dependencies["dsh-windows-notify"];
    const i = bundles.indexOf("dsh-windows-notify");
    if (i >= 0) bundles.splice(i, 1);
  } else {
    manifest.dependencies["dsh-windows-notify"] = "file:" + PKG_DIR.replace(/\\/g, "/");
    if (!bundles.includes("dsh-windows-notify")) bundles.push("dsh-windows-notify");
  }
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  return manifestPath;
}

/**
 * 还原旧 apply-patch 补丁:从 npm registry 拉同版本官方包,用其 lib 文件覆盖
 * 仍带旧钩子标记的内置文件。registry 版本保证 pristine(本地备份均已是补丁态)。
 * @returns 每个文件的处理结果行。
 */
function revertLegacy() {
  if (LEGACY_ROOT === "") {
    return ["未指定 --legacy-root,跳过旧补丁还原(该开关仅在从旧版 apply-patch 扩展迁移时需要)"];
  }
  const results = [];
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const tmp = join(tmpdir(), `dsh-notify-revert-${Date.now()}`);
  mkdirSync(tmp, { recursive: true });
  let anyDone = false;
  try {
    for (const { pkg, leaf, marker } of LEGACY_FILES) {
      const pkgDir = join(LEGACY_ROOT, pkg.split("/").pop());
      const live = join(pkgDir, "lib", leaf);
      if (!existsSync(live)) {
        results.push(`· ${pkg}/${leaf}: 文件不存在,跳过`);
        continue;
      }
      const content = readFileSync(live, "utf8");
      if (!content.includes(marker)) {
        results.push(`· ${pkg}/${leaf}: 无旧钩子标记,已是干净文件`);
        continue;
      }
      const packed = spawnSync(npm, ["pack", `${pkg}@${LEGACY_VERSION}`, "--silent"], {
        cwd: tmp, shell: process.platform === "win32", encoding: "utf8",
      });
      if (packed.status !== 0) {
        results.push(`· ${pkg}/${leaf}: npm pack 失败(${String(packed.stderr ?? packed.error ?? "").trim().slice(0, 200) || "未知原因"}),未还原`);
        continue;
      }
      const tgzName = String(packed.stdout ?? "").trim().split(/\r?\n/).filter(Boolean).pop();
      const extractDir = join(tmp, pkg.replace(/[^A-Za-z0-9]+/g, "-"));
      mkdirSync(extractDir, { recursive: true });
      const untar = spawnSync("tar", ["-xzf", join(tmp, tgzName), "-C", extractDir], {
        shell: process.platform === "win32", encoding: "utf8",
      });
      const pristine = join(extractDir, "package", "lib", leaf);
      if (untar.status !== 0 || !existsSync(pristine)) {
        results.push(`· ${pkg}/${leaf}: 解包失败,未还原`);
        continue;
      }
      const pristineContent = readFileSync(pristine, "utf8");
      if (pristineContent.includes(marker)) {
        results.push(`· ${pkg}/${leaf}: registry 文件仍含标记(意外),未还原`);
        continue;
      }
      writeFileSync(live, pristineContent);
      const check = spawnSync(process.execPath, ["--check", live], { encoding: "utf8" });
      if (check.status !== 0) {
        results.push(`· ${pkg}/${leaf}: 还原后 node --check 失败,请重装 DSH`);
        continue;
      }
      anyDone = true;
      results.push(`· ${pkg}/${leaf}: 已还原为 registry 同版本官方文件(node --check 通过)`);
    }
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* 清理尽力而为 */ }
  }
  if (!anyDone) results.push("· 没有需要还原的旧补丁文件");
  return results;
}

/** 旧版扩展的 config.json → 一次性种子文件(插件首启迁移到 settings 命名空间)。 */
function migrateLegacyConfig() {
  if (!existsSync(LEGACY_CONFIG)) return "无旧配置可迁移";
  try {
    let raw = readFileSync(LEGACY_CONFIG, "utf8");
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") return "旧配置不是对象,跳过";
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(join(STATE_DIR, "seed-config.json"), JSON.stringify(parsed, null, 2), "utf8");
    return "已复制为 seed-config.json(插件首启自动迁移到 settings 命名空间 dsh-notify)";
  } catch (error) {
    return `迁移失败:${String(error?.message ?? error)}`;
  }
}

// ── 执行 ────────────────────────────────────────────────────────────────────
if (UNINSTALL) {
  console.log(`dsh-windows-notify 卸载:profile=${PROFILE}, DSH_HOME=${DSH_HOME}`);
  console.log("· profile 链接:", removeJunctionIfOwned(LINK_PATH, [PKG_DIR]));
  console.log("· 本包依赖链接:", removeJunctionIfOwned(PKG_MODULES, [FALLBACK_MODULES]));
  console.log("· manifest:", updateManifest());
  console.log("");
  console.log("卸载完成。重启 DSH 生效。(settings 里的 dsh-notify 配置保留,重新安装后继续有效)");
} else {
  console.log(`dsh-windows-notify 安装:profile=${PROFILE}, DSH_HOME=${DSH_HOME}`);
  console.log("· profile:", ensureProfileInitialized());
  console.log("· profile 链接:", ensureJunction(LINK_PATH, PKG_DIR), "→", LINK_PATH);
  let depNote;
  if (existsSync(PKG_MODULES)) {
    depNote = "已存在,跳过";
  } else {
    ensureJunction(PKG_MODULES, FALLBACK_MODULES);
    depNote = "已链接 DSH 内置包回退";
  }
  console.log("· 本包依赖解析:", depNote, "→", PKG_MODULES);
  console.log("· manifest:", updateManifest());
  if (KEEP_LEGACY) {
    console.log("· 旧补丁:--keep-legacy,跳过还原(插件运行时会自动让位,不重复提醒)");
  } else {
    console.log("· 旧补丁还原:");
    for (const line of revertLegacy()) console.log(`  ${line}`);
  }
  console.log("· 旧配置:", migrateLegacyConfig());
  console.log("");
  console.log("安装完成。接下来:");
  console.log("  1. 重启 DSH(让插件与设置页「通知」区段进入组合;托盘/提醒从此由插件接管);");
  console.log("  2. 打开 DSH 设置 → 通知,确认配置(旧版配置已自动迁移);");
  console.log("  3. 若要试听提示音,点任意预设旁的「试听」。");
}
