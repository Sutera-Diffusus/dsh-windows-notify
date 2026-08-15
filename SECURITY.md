# Security Policy

## 支持版本 / Supported Versions

| 版本 | 支持 |
| --- | --- |
| 1.x | ✅ |

## 数据处理 / Data handling

dsh-windows-notify 的设计边界是**本机提醒**,不收集、不上传任何数据:

- **配置**:存于 DSH 托管设置文档(`$DSH_HOME/settings.yaml` 的 `dsh-notify` 节),由 DSH 自身管理;
- **运行状态**:托盘角标计数(`tray-state.json`)与调试日志(`debug.log`)仅写本机 `$DSH_HOME/dsh-windows-notify/`,内容为通知次数与标题片段(≤300 字符),不含凭据;
- **凭据**:插件不读取任何凭据、令牌或环境密钥;
- **网络**:运行期零网络请求。唯一例外是 `install.mjs --legacy-root` 在还原旧版扩展补丁时,从 npm registry 拉取与本地同版本的 `@deepseek-ai/*` 官方包(内容校验后覆盖旧补丁文件);
- **平台边界**:非 Windows 平台所有提醒路径自动跳过。

## 报告漏洞 / Reporting a Vulnerability

发现安全问题请通过 [GitHub Security Advisory](https://github.com/Sutera-Diffusus/dsh-windows-notify/security/advisories/new) 私下报告,或开 Issue 时标注 `security`。请勿公开利用细节;确认后我们会在 30 天内发布修复版本并在 CHANGELOG 中致谢。

## 审计提示 / Audit notes

- Toast 与托盘脚本由 Node 以 Base64 JSON 载荷派生(规避命令行转义问题);载荷内容来自 DSH 会话标题/问题文本,脚本内做长度截断与 XML 转义(`toast.ps1` 的 `To-XmlText`),防止 Toast XML 注入;
- 托盘单实例锁按端口隔离,多实例互不干扰;托盘进程随 DSH 端口看门狗退出。
