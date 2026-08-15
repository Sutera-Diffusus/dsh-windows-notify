/**
 * dsh-windows-notify 客户端插件:DSH 设置页「通知」区段。
 *
 * 与 DSH 设置页同源的视觉语言(DSW token + 内联样式,无需构建步骤):
 *   1. 提示音:开关 + 四套预设(柔和/轻快/舒缓/清脆),每套可试听(宿主播放);
 *   2. 打扰控制:免打扰时段(起止时间)+ 跟随系统勿扰;
 *   3. 任务完成通知:弹窗+提示音 / 仅角标,合并同类通知(5 秒摘要)。
 *
 * 配置传输走插件自有 HTTP 路由 /api/dsh-notify/config:
 *   DSH rc.6 的 apiproxy 只对白名单命名空间暴露 settings.describe,
 *   第三方命名空间在浏览器侧不可见;宿主侧仍把配置持久化在
 *   $DSH_HOME/settings.yaml 的 dsh-notify 节(schema 校验),保存即生效。
 */
window.__ModuleLoader__.load({
  id: "dsh-windows-notify",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    let react = require("react");
    let react_jsx_runtime = require("react/jsx-runtime");

    // ── 四套提示音(与宿主 SOUND_PRESETS 对齐;客户端打包不能跨插件导入值)────
    const SOUNDS = [
      { id: "soft", label: "柔和（默认）", desc: "叮—咚双音，马林巴音色，平稳舒缓" },
      { id: "brisk", label: "轻快", desc: "三连音上行，节奏明快" },
      { id: "calm", label: "舒缓", desc: "低八度双音，更慢更长" },
      { id: "crisp", label: "清脆", desc: "明亮短促，高音为主" },
    ];

    // ── 视觉语言(与 DSH 设置页同源的 DSW token)─────────────────────────────
    const style = {
      root: { boxSizing: "border-box", flexDirection: "column", gap: 10, padding: 20, display: "flex", overflow: "auto", height: "100%" },
      hint: { margin: 0, color: "var(--dsw-alias-label-secondary)", fontSize: 12, lineHeight: "18px" },
      error: { color: "var(--dsw-alias-state-error-primary)", fontSize: 12, lineHeight: "18px", display: "flex", alignItems: "center", gap: 8 },
      group: { flexDirection: "column", gap: 6, display: "flex" },
      groupTitle: { color: "var(--dsw-alias-label-secondary)", fontSize: 11, fontWeight: 600, lineHeight: "16px", letterSpacing: ".02em", padding: "0 2px" },
      divider: { height: 1, background: "var(--dsw-alias-interactive-bg-hover)", margin: "2px 0", border: "none" },
      toggle: { boxSizing: "border-box", alignItems: "center", justifyContent: "space-between", gap: 12, background: "var(--dsw-alias-interactive-bg-hover)", borderRadius: 12, padding: "10px 16px", display: "flex" },
      toggleLabel: { color: "var(--dsw-alias-label-primary)", fontSize: 14, lineHeight: "22px" },
      toggleHint: { color: "var(--dsw-alias-label-secondary)", fontSize: 12, lineHeight: "18px" },
      list: { flexDirection: "column", gap: 8, display: "flex" },
      row: { boxSizing: "border-box", alignItems: "center", gap: 12, border: "1px solid transparent", borderRadius: 12, padding: "8px 12px", display: "flex", cursor: "pointer", background: "transparent" },
      rowSelected: { borderColor: "var(--dsw-alias-brand-primary)", background: "var(--dsw-alias-interactive-bg-hover)" },
      dot: { flex: "none", border: "1.5px solid var(--dsw-alias-label-tertiary)", borderRadius: "50%", width: 14, height: 14, boxSizing: "border-box" },
      dotSelected: { borderColor: "var(--dsw-alias-brand-primary)", background: "var(--dsw-alias-brand-primary)" },
      body: { flex: 1, minWidth: 0, flexDirection: "column", display: "flex" },
      label: { color: "var(--dsw-alias-label-primary)", fontSize: 14, lineHeight: "22px" },
      desc: { color: "var(--dsw-alias-label-secondary)", fontSize: 12, lineHeight: "18px" },
      current: { flex: "none", color: "var(--dsw-alias-brand-primary)", fontSize: 11, lineHeight: "16px" },
      timeRow: { alignItems: "center", gap: 8, padding: "2px 0 0 30px", display: "flex" },
      timeLabel: { color: "var(--dsw-alias-label-secondary)", fontSize: 12, lineHeight: "18px" },
      timeInput: { width: 72, height: 28, boxSizing: "border-box", border: "1px solid var(--dsw-alias-border-l2)", background: "var(--dsw-alias-bg-layer-3)", color: "var(--dsw-alias-label-primary)", borderRadius: 8, padding: "0 8px", fontSize: 12, textAlign: "center", fontFamily: "inherit" },
      btn: { height: 28, boxSizing: "border-box", borderRadius: 8, padding: "0 12px", fontSize: 12, fontWeight: 500, fontFamily: "inherit", cursor: "pointer", border: "1px solid transparent", background: "var(--dsw-alias-brand-primary)", color: "var(--dsw-alias-label-on-accent, #fff)" },
      btnOutline: { height: 28, boxSizing: "border-box", borderRadius: 8, padding: "0 12px", fontSize: 12, fontWeight: 500, fontFamily: "inherit", cursor: "pointer", border: "1px solid var(--dsw-alias-border-l2)", background: "transparent", color: "var(--dsw-alias-label-secondary)" },
    };

    const TIME_PATTERN = /^\d{1,2}:\d{2}$/;

    /** 经插件自有路由读写配置(apiproxy 不暴露第三方 settings 命名空间)。 */
    async function fetchConfig() {
      const res = await fetch("/api/dsh-notify/config");
      const data = await res.json();
      if (!data || data.ok !== true) throw new Error(data?.error ?? `配置读取失败(${res.status})`);
      return data;
    }

    async function patchConfig(patch) {
      const res = await fetch("/api/dsh-notify/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ patch }),
      });
      const data = await res.json();
      if (!data || data.ok !== true) throw new Error(data?.error ?? `配置保存失败(${res.status})`);
      return data;
    }

    /** 试听:POST /api/dsh-notify/preview → 宿主播放对应提示音。 */
    async function previewSound(soundId) {
      try {
        await fetch("/api/dsh-notify/preview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sound: soundId }),
        });
      } catch { /* 试听失败静默 */ }
    }

    function SwitchRow(props) {
      const { label, hint, checked, onToggle } = props;
      return react_jsx_runtime.jsxs("div", { style: style.toggle, children: [
        react_jsx_runtime.jsxs("div", { style: style.body, children: [
          react_jsx_runtime.jsx("div", { style: style.toggleLabel, children: label }),
          hint !== void 0 && hint !== null ? react_jsx_runtime.jsx("div", { style: style.toggleHint, children: hint }) : null,
        ] }),
        react_jsx_runtime.jsx("button", { type: "button", style: checked ? style.btn : style.btnOutline, onClick: onToggle, children: checked ? "开启" : "关闭" }),
      ] });
    }

    function ModeRow(props) {
      const { label, selected, onSelect } = props;
      return react_jsx_runtime.jsxs("div", {
        style: selected ? { ...style.row, ...style.rowSelected } : style.row,
        onClick: onSelect,
        children: [
          react_jsx_runtime.jsx("span", { style: selected ? { ...style.dot, ...style.dotSelected } : style.dot, role: "radio", "aria-checked": selected }),
          react_jsx_runtime.jsx("div", { style: style.body, children: react_jsx_runtime.jsx("div", { style: style.label, children: label }) }),
        ],
      });
    }

    function NotifySection() {
      const [config, setConfig] = react.useState(null);
      const [error, setError] = react.useState(null);
      const [busy, setBusy] = react.useState(false);

      const load = react.useCallback(() => {
        setError(null);
        fetchConfig().then((data) => setConfig(data.config), (reason) => {
          setError(reason instanceof Error ? reason.message : String(reason));
        });
      }, []);

      react.useEffect(() => { load(); }, [load]);

      const update = async (field, value) => {
        if (busy) return;
        setError(null);
        setBusy(true);
        try {
          const data = await patchConfig({ [field]: value });
          setConfig(data.config);
        } catch (reason) {
          setError(reason instanceof Error ? reason.message : String(reason));
        } finally {
          setBusy(false);
        }
      };

      return react_jsx_runtime.jsxs("div", { style: style.root, children: [
        react_jsx_runtime.jsx("p", { style: style.hint, children: "任务完成或需要决策时的 Windows 弹窗提醒与提示音设置。" }),
        error !== null ? react_jsx_runtime.jsxs("div", { style: style.error, role: "alert", children: [
          error,
          react_jsx_runtime.jsx("button", { type: "button", style: style.btnOutline, onClick: load, children: "重试" }),
        ] }) : null,
        config === null ? react_jsx_runtime.jsx("p", { style: style.hint, children: "加载中…" }) : react_jsx_runtime.jsxs(react_jsx_runtime.Fragment, { children: [
          // ── 提示音 ──
          react_jsx_runtime.jsxs("div", { style: style.group, children: [
            react_jsx_runtime.jsx("div", { style: style.groupTitle, children: "提示音" }),
            react_jsx_runtime.jsx(SwitchRow, {
              label: "提示音",
              checked: config.soundEnabled !== false,
              onToggle: () => update("soundEnabled", config.soundEnabled === false),
            }),
            react_jsx_runtime.jsx("div", { style: style.list, children: SOUNDS.map((sound) => {
              const selected = sound.id === config.sound;
              return react_jsx_runtime.jsxs("div", {
                key: sound.id,
                style: selected ? { ...style.row, ...style.rowSelected } : style.row,
                onClick: () => update("sound", sound.id),
                children: [
                  react_jsx_runtime.jsx("span", { style: selected ? { ...style.dot, ...style.dotSelected } : style.dot, role: "radio", "aria-checked": selected }),
                  react_jsx_runtime.jsxs("div", { style: style.body, children: [
                    react_jsx_runtime.jsx("div", { style: style.label, children: sound.label }),
                    react_jsx_runtime.jsx("div", { style: style.desc, children: sound.desc }),
                  ] }),
                  selected ? react_jsx_runtime.jsx("span", { style: style.current, children: "当前" }) : null,
                  react_jsx_runtime.jsx("button", {
                    type: "button",
                    style: style.btnOutline,
                    onClick: (event) => { event.stopPropagation(); previewSound(sound.id); },
                    children: "试听",
                  }),
                ],
              });
            }) }),
          ] }),
          react_jsx_runtime.jsx("hr", { style: style.divider }),
          // ── 打扰控制 ──
          react_jsx_runtime.jsxs("div", { style: style.group, children: [
            react_jsx_runtime.jsx("div", { style: style.groupTitle, children: "打扰控制" }),
            react_jsx_runtime.jsx(SwitchRow, {
              label: "免打扰时段",
              hint: "时段内仅累计任务栏角标，不弹窗、不响铃。",
              checked: config.quietHours.enabled === true,
              onToggle: () => update("quietHours", { enabled: config.quietHours.enabled !== true, start: config.quietHours.start, end: config.quietHours.end }),
            }),
            config.quietHours.enabled === true ? react_jsx_runtime.jsxs("div", { style: style.timeRow, children: [
              react_jsx_runtime.jsx("span", { style: style.timeLabel, children: "开始" }),
              react_jsx_runtime.jsx("input", {
                style: style.timeInput,
                type: "text",
                defaultValue: config.quietHours.start,
                onBlur: (event) => {
                  if (TIME_PATTERN.test(event.target.value)) update("quietHours", { enabled: true, start: event.target.value, end: config.quietHours.end });
                },
              }),
              react_jsx_runtime.jsx("span", { style: style.timeLabel, children: "结束" }),
              react_jsx_runtime.jsx("input", {
                style: style.timeInput,
                type: "text",
                defaultValue: config.quietHours.end,
                onBlur: (event) => {
                  if (TIME_PATTERN.test(event.target.value)) update("quietHours", { enabled: true, start: config.quietHours.start, end: event.target.value });
                },
              }),
            ] }) : null,
            react_jsx_runtime.jsx(SwitchRow, {
              label: "跟随系统勿扰",
              hint: "Windows 专注助手/勿扰开启时自动静音。",
              checked: config.respectSystemDnd === true,
              onToggle: () => update("respectSystemDnd", config.respectSystemDnd !== true),
            }),
          ] }),
          react_jsx_runtime.jsx("hr", { style: style.divider }),
          // ── 任务完成通知 ──
          react_jsx_runtime.jsxs("div", { style: style.group, children: [
            react_jsx_runtime.jsx("div", { style: style.groupTitle, children: "任务完成通知" }),
            react_jsx_runtime.jsx(ModeRow, {
              label: "弹窗 + 提示音",
              selected: config.completeMode !== "badge-only",
              onSelect: () => update("completeMode", "toast"),
            }),
            react_jsx_runtime.jsx(ModeRow, {
              label: "仅角标",
              selected: config.completeMode === "badge-only",
              onSelect: () => update("completeMode", "badge-only"),
            }),
            react_jsx_runtime.jsx(SwitchRow, {
              label: "合并同类通知",
              hint: "5 秒内的多个完成合并为一条摘要。",
              checked: config.completeMerge === true,
              onToggle: () => update("completeMerge", config.completeMerge !== true),
            }),
          ] }),
        ] }),
      ] });
    }

    // ── 插件入口:把「通知」区段挂进设置页 ────────────────────────────────────
    const inject = ["slots"];

    function apply(ctx) {
      ctx.slots.inject("settings.section", () => ctx.slots.register({
        name: "settings.section",
        id: "notify",
        order: 80,
        label: "通知",
      }, NotifySection));
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
