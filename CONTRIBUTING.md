# Contributing

感谢关注!这是一个小而精的 Windows 通知插件,欢迎提 Issue 与 PR。

## 开发环境 / Setup

- Node ≥ 18(无第三方运行时依赖;唯一 dev 依赖是 js-yaml 供校验脚本用);
- Windows 10/11(Toast、托盘与音效需要实测);
- 一台可重启的 DSH 实例(插件经 profile bundle 接入,改动后需重启验证)。

```bash
npm ci
node test.mjs   # 校验:语法/YAML/JSON/资产/编码/路径泄露
node pack.mjs   # dist/ 下生成分发产物
```

## 本地安装调试 / Local install

```powershell
.\install.ps1          # junction + manifest 接线
# 重启 DSH;或用另一个端口起一个冒烟实例:
node <dsh>\lib\bin.js web --port 3210
# 冒烟检查:
#   http://127.0.0.1:3210/plugins/dsh-windows-notify/client.js   (200)
#   POST http://127.0.0.1:3210/api/dsh-notify/preview            ({"ok":true} 并播放音效)
.\uninstall.ps1        # 反向清理
```

## 编码规则 / Conventions

- **`.ps1` 必须 UTF-8 BOM**(Windows PowerShell 5.1 会把无 BOM 的中文按 GBK 读);`.bat` 必须纯 ASCII;
- 通知路径全程 best-effort:任何失败静默降级,绝不打断 DSH 主流程;
- 子进程规则:PowerShell 用绝对路径;载荷走 Base64;不用 detached/unref(Windows 上子进程会被立即杀死);
- 新增配置项:同步改 `lib/index.js` 的 `NotifySchema`(默认值)、`lib/notify-core.js` 的 `normalizeConfig`、`lib/client.js` 的设置页 UI,并补 README 配置表。

## 提交规范 / Commits

- 一条提交做一件事;提交信息用 `type: 描述`(如 `fix:`、`feat:`、`docs:`、`ci:`);
- 不要提交 `node_modules/`、`dist/`、日志与任何含本机绝对路径的文件(`node test.mjs` 会拦住路径泄露)。

## 发布流程 / Release

打 `vX.Y.Z` 标签推送后,`.github/workflows/release.yml` 会自动构建、校验并创建 Release(资产 + SHA256SUMS.txt)。
