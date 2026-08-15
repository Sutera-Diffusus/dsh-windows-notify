#!/usr/bin/env node
/**
 * 打包脚本:
 *   node pack.mjs
 * 输出到 dist/:
 *   · dsh-windows-notify-<version>.tgz —— 插件包 npm 归档(npm pack,含 files 白名单)
 *   · dsh-windows-notify-plugin-<version>.zip —— 完整源码包(含 install.mjs/README)
 * @module dsh-windows-notify/pack
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PKG_DIR = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(join(PKG_DIR, "package.json"), "utf8"));
const version = manifest.version;
const DIST = join(PKG_DIR, "dist");
mkdirSync(DIST, { recursive: true });

const run = (command, args, cwd = PKG_DIR) => {
  const result = spawnSync(command, args, { cwd, shell: process.platform === "win32", encoding: "utf8" });
  if (result.status !== 0) {
    console.error(`[pack] ${command} ${args.join(" ")} 失败:${String(result.stderr ?? result.error ?? "").trim()}`);
    process.exit(result.status ?? 1);
  }
  return String(result.stdout ?? "").trim();
};

// 1) npm 归档(发布到 registry 用;也适合 `dsh plugin add <tgz>` 的 pnpm 流程)
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const tgzName = `dsh-windows-notify-${version}.tgz`;
const tgzOut = join(DIST, tgzName);
run(npm, ["pack", PKG_DIR, "--silent"], PKG_DIR);
const packed = join(PKG_DIR, tgzName);
if (!existsSync(packed)) {
  console.error("[pack] 未找到 npm pack 产物");
  process.exit(1);
}
rmSync(tgzOut, { force: true });
renameSync(packed, tgzOut); // 跨平台移动(避免依赖 cmd.exe)
console.log(`[pack] npm 归档:${tgzOut}`);

// 2) 完整源码 zip(排除 node_modules 与 dist;Windows 用 bsdtar -a,其余用 zip)
const zipOut = join(DIST, `dsh-windows-notify-plugin-${version}.zip`);
rmSync(zipOut, { force: true });
const parent = dirname(PKG_DIR);
const entry = basename(PKG_DIR);
if (process.platform === "win32") {
  run("tar", ["-a", "-c", "-f", resolve(zipOut), "--exclude=node_modules", "--exclude=dist", "-C", parent, entry]);
} else {
  run("zip", ["-r", resolve(zipOut), entry, "-x", `${entry}/node_modules/*`, `${entry}/dist/*`], parent);
}
console.log(`[pack] 源码包:${zipOut}`);
console.log("[pack] 完成。dist 目录内容可直接上传。");
