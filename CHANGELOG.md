# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 格式,版本遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## [1.1.1] - 2026-08-16

### Fixed

- 设置页按钮改用框架 Button 原语(`@deepseek-ai/dsh-client-ui-primitives`,variant primary/outline):此前手写按钮用了主题系统里不存在的 `--dsw-alias-label-on-accent` 令牌,亮色主题下按钮文字与底色对比度不足、颜色发飘;现在与设置页其他控件完全一致,亮暗主题对比度均由框架保证。

## [1.1.0] - 2026-08-16

### Changed

- 设置页配置传输改走插件自有 HTTP 路由 `GET/POST /api/dsh-notify/config`:DSH rc.6 的 apiproxy 只对白名单命名空间(`WEB_SETTINGS_NAMESPACES`)暴露 settings 描述,第三方命名空间在浏览器侧不可见(此前表现为设置页一直「加载中…」)。配置仍持久化在 `$DSH_HOME/settings.yaml` 的 `dsh-notify` 节并经 schema 校验;宿主零补丁。

## [1.0.2] - 2026-08-16

### Fixed

- 设置页「通知」区段渲染崩溃:`useSyncExternalStore` 的 `subscribe`/`getSnapshot` 之前裸传(丢失 `this`),区段打开即空白;现改为箭头包装(与官方插件同款写法)。

## [1.0.1] - 2026-08-16

### Fixed

- 免打扰时段仅在设置开关 `quietHours.enabled` 打开时生效(此前只要处于 22:00–08:00 时段就静音,即使开关关闭)。
- 设置页「试听」现在是主动动作:忽略静音配置与免打扰时段,点击必定播放。

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
