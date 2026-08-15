#!/usr/bin/env node
/**
 * 发布前校验套件(CI 与本地共用):
 *   1. 全部 JS/MJS 语法(node --check);
 *   2. cordis.patch.yml 结构(bundle 补丁:单条 insert,dsh-notify 行);
 *   3. package.json 插件声明(dsh.bundle / dsh.client / exports / files);
 *   4. 音频资产存在且为 RIFF/WAVE;
 *   5. PowerShell 脚本为 UTF-8 BOM(中文文本硬性要求);
 *   6. 路径泄露扫描:仓库文本文件不得含盘符绝对路径。
 * 任一项失败退出码非 0。
 * @module dsh-windows-notify/test
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const ROOT = dirname(fileURLToPath(import.meta.url));
const failures = [];
const check = (ok, message) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${message}`);
  if (!ok) failures.push(message);
};

// ---- 1. JS/MJS 语法 ----
const JS_FILES = ["lib/index.js", "lib/notify-core.js", "lib/client.js", "install.mjs", "pack.mjs", "test.mjs"];
for (const rel of JS_FILES) {
  const file = join(ROOT, rel);
  check(existsSync(file), `存在 ${rel}`);
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  check(result.status === 0, `node --check ${rel}`);
}

// ---- 2. cordis.patch.yml ----
const patch = yaml.load(readFileSync(join(ROOT, "cordis.patch.yml"), "utf8"));
check(Array.isArray(patch), "cordis.patch.yml 顶层为数组");
if (Array.isArray(patch)) {
  const row = patch?.[0]?.insert?.[0];
  check(patch.length === 1 && patch[0]?.insert?.length === 1, "cordis.patch.yml 恰好一条 insert");
  check(row?.id === "dsh-notify", "行 id 为 dsh-notify");
  check(row?.name === "dsh-windows-notify", "行 name 为 dsh-windows-notify");
}

// ---- 3. package.json ----
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
check(pkg.name === "dsh-windows-notify", "包名 dsh-windows-notify");
check(pkg.dsh?.bundle?.patch === "./cordis.patch.yml", "声明 dsh.bundle.patch");
check(pkg.dsh?.client?.platform === "web", "声明 dsh.client(web)");
check(typeof pkg.exports?.["./client"] === "string" && existsSync(join(ROOT, pkg.exports["./client"])), "exports ./client 指向存在的文件");
check(typeof pkg.exports?.["./cordis.patch.yml"] === "string" && existsSync(join(ROOT, pkg.exports["./cordis.patch.yml"])), "exports ./cordis.patch.yml 指向存在的文件");
check(pkg.version === "1.0.0", "版本 1.0.0");
check(pkg.license === "MIT", "许可证 MIT");

// ---- 4. 音频资产 ----
for (const name of ["dsh-notify-soft.wav", "dsh-notify-brisk.wav", "dsh-notify-calm.wav", "dsh-notify-crisp.wav", "dsh-notify.wav"]) {
  const file = join(ROOT, "assets", name);
  const ok = existsSync(file) && readFileSync(file).subarray(0, 4).toString("ascii") === "RIFF";
  check(ok, `资产 ${name} 为 RIFF/WAVE`);
}

// ---- 5. PowerShell 脚本 UTF-8 BOM ----
for (const rel of ["scripts/toast.ps1", "scripts/tray.ps1", "install.ps1", "uninstall.ps1"]) {
  const bytes = readFileSync(join(ROOT, rel));
  const bom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  check(bom, `${rel} 为 UTF-8 BOM`);
}

// ---- 6. 路径泄露扫描 ----
const TEXT_EXTS = new Set([".js", ".mjs", ".ps1", ".yml", ".yaml", ".json", ".md"]);
const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "docs"]);
const walk = (dir) => {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(path));
    else if (TEXT_EXTS.has(extname(entry.name)) || entry.name === "LICENSE" || entry.name === ".gitignore") out.push(path);
  }
  return out;
};
// 盘符绝对路径:前面不能是字母(排除 https:// 这类 URL 里的 s:/)
const DRIVE_PATH = /(?<![A-Za-z])[A-Za-z]:[\\/]/;
// 合法豁免:系统目录常量(C:\WINDOWS 在所有 Windows 机器上一致,非机器泄露;
// JS 源码里的字面量是双反斜杠转义形式)
const LEGIT_SYSTEM_DIR = /C:[\\/]+WINDOWS/gi;
const leaks = [];
for (const file of walk(ROOT)) {
  if (file.endsWith("test.mjs")) continue; // 扫描器自身的模式除外
  const content = readFileSync(file, "utf8").replace(LEGIT_SYSTEM_DIR, "");
  if (DRIVE_PATH.test(content)) leaks.push(file.replace(ROOT + "\\", ""));
}
check(leaks.length === 0, `无盘符绝对路径泄露${leaks.length > 0 ? `: ${leaks.join(", ")}` : ""}`);

// ---- 汇总 ----
if (failures.length > 0) {
  console.error(`\n${failures.length} 项校验失败`);
  process.exit(1);
}
console.log(`\n全部校验通过(${JS_FILES.length} JS + YAML + JSON + 资产 + 编码 + 路径)`);
