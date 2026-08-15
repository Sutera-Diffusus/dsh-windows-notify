# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 格式,版本遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## [1.0.0] - 2026-08-15

首个公开版本:从 apply-patch 扩展重写为 DSH 原生 profile 插件(零侵入)。

### Added

- 完成提醒:`agent/status`(running→idle)驱动的回合结束 Toast,支持「仅角标」模式与 5 秒合并摘要。
- 决策提醒:包装 `userQuestions.ask()`,提问时 Toast + 托盘角标 +1,回答/取消后 -1。
- 任务栏托盘角标:待查看数量气泡,单击打开 GUI 并清零已完成,端口看门狗随 DSH 退出。
- 四套自制提示音(柔和/轻快/舒缓/清脆)+ 设置页试听路由 `/api/dsh-notify/preview`。
- 打扰控制:免打扰时段(跨午夜)+ 跟随 Windows 专注助手/勿扰。
- 设置页「通知」区段:settings 命名空间 `dsh-notify`,保存即生效。
- 幂等安装器 `install.mjs`(junction + manifest 接线、profile 初始化、旧配置一次性迁移、旧 apply-patch 补丁还原)。
- 打包脚本 `pack.mjs`(npm 归档 + 源码 zip)。
- CI:push/PR 校验(Node 语法/YAML/JSON/资产/PowerShell 解析/路径泄露扫描)+ tag 自动 Release(SHA256SUMS)。
