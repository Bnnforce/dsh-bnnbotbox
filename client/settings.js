/**
 * 设置页（客户端）
 *
 * 这是要在浏览器里跑的模块，必须按 DSH 的客户端模块格式写：
 *   window.__ModuleLoader__.load({ id, factory(require) { ... } })
 * 其中 id 必须**等于包名**，React 从模块表里 require，不打包第二份。
 *
 * 做三件事：
 *   ① 向 `settings.section` 注册一页（label 走 locale，不写死中文）
 *   ② 拉 GET /api/bnnbotbox/config 拿白名单字段和当前值
 *   ③ 改完 POST 回去（宿主用 configEditor 保存，不是手改 YAML）
 *
 * ⚠️ 保存会让插件重启：这些字段都不是 volatile，宿主会重建插件实例。
 *    页面要如实提示，不能让人以为"点了就悄悄生效"。
 */
window.__ModuleLoader__.load({
  id: 'dsh-bnnbotbox',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** 从 index.html 注入的全局变量里取口令（见 lib/settings-route.js）。 */
    const TOKEN_GLOBAL = '__DSH_BNNBOTBOX_TOKEN__';
    const API = '/api/bnnbotbox/config';

    function token() {
      return (typeof window !== 'undefined' && window[TOKEN_GLOBAL]) || '';
    }

    async function request(method, patch) {
      const res = await fetch(API, {
        method,
        headers: { 'x-bnn-token': token(), 'content-type': 'application/json' },
        body: patch ? JSON.stringify({ patch }) : undefined,
      });
      let data;
      try {
        data = await res.json();
      } catch {
        throw new Error(`HTTP ${res.status}（响应不是 JSON）`);
      }
      if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`);
      return data;
    }

    // ── 样式（跟随宿主主题变量，不自带配色）────────────────────────────
    const S = {
      wrap: { maxWidth: 720, display: 'flex', flexDirection: 'column', gap: 12 },
      title: { margin: 0, fontSize: 18, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
      intro: { margin: 0, fontSize: 13, color: 'var(--dsw-alias-label-tertiary)', lineHeight: '20px' },
      card: {
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 10,
        padding: '12px 14px',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      },
      row: { display: 'flex', alignItems: 'flex-start', gap: 10 },
      label: { flex: 1, display: 'flex', flexDirection: 'column', gap: 2 },
      name: { fontSize: 14, color: 'var(--dsw-alias-label-primary)' },
      hint: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary)', lineHeight: '17px' },
      input: {
        width: '100%',
        boxSizing: 'border-box',
        padding: '6px 8px',
        fontSize: 13,
        borderRadius: 6,
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary)',
      },
      bar: { display: 'flex', alignItems: 'center', gap: 10, marginTop: 2 },
      btn: {
        padding: '7px 14px',
        fontSize: 13,
        borderRadius: 6,
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-fill-tsp-secondary, transparent)',
        color: 'var(--dsw-alias-label-primary)',
        cursor: 'pointer',
      },
      msg: { fontSize: 13, lineHeight: '18px' },
    };

    function Section() {
      const [state, setState] = React.useState({ loading: true, error: '' });
      const [draft, setDraft] = React.useState({});
      const [saving, setSaving] = React.useState(false);
      const [notice, setNotice] = React.useState(null);
      const alive = React.useRef(true);

      React.useEffect(() => {
        alive.current = true;
        request('GET')
          .then((data) => {
            if (!alive.current) return;
            setState({ loading: false, error: '', fields: data.fields, values: data.values });
            setDraft(data.values || {});
          })
          .catch((err) => {
            if (!alive.current) return;
            setState({ loading: false, error: err.message });
          });
        return () => {
          alive.current = false;
        };
      }, []);

      const set = (key, value) => setDraft((d) => ({ ...d, [key]: value }));

      const changed = Object.keys(draft).filter((k) => {
        const base = state.values ? state.values[k] : undefined;
        return JSON.stringify(draft[k]) !== JSON.stringify(base);
      });

      const save = async () => {
        if (!changed.length) return;
        setSaving(true);
        setNotice(null);
        const patch = {};
        for (const k of changed) patch[k] = draft[k];
        try {
          await request('POST', patch);
          setState((s) => ({ ...s, values: { ...s.values, ...patch } }));
          setNotice({ ok: true, text: '已保存。插件会重启一次使配置生效（当前会话可能短暂中断）。' });
        } catch (err) {
          setNotice({ ok: false, text: `保存失败：${err.message}` });
        } finally {
          setSaving(false);
        }
      };

      if (state.loading) return h('div', { style: S.wrap }, h('p', { style: S.intro }, '读取配置中…'));

      if (state.error) {
        return h('div', { style: S.wrap },
          h('h2', { style: S.title }, 'BnnBot 记忆与人格'),
          h('p', { style: { ...S.intro, color: 'var(--dsw-alias-state-warn-primary, #c60)' } },
            `读不到配置：${state.error}`));
      }

      const rows = (state.fields || []).map((f) => {
        const value = draft[f.key];
        const control = f.kind === 'boolean'
          ? h('input', {
              type: 'checkbox',
              checked: value !== false,
              'aria-label': f.label,
              disabled: saving,
              onChange: (e) => set(f.key, e.target.checked),
              style: { marginTop: 3, cursor: 'pointer' },
            })
          : h('input', {
              type: 'text',
              value: value == null ? '' : String(value),
              'aria-label': f.label,
              disabled: saving,
              onChange: (e) => set(f.key, e.target.value),
              style: { ...S.input, marginTop: 6 },
            });
        return h('div', { key: f.key, style: { ...S.row, flexDirection: f.kind === 'boolean' ? 'row' : 'column' } },
          h('label', { style: S.label },
            h('span', { style: S.name }, f.label),
            h('span', { style: S.hint }, f.hint)),
          control);
      });

      return h('div', { style: S.wrap },
        h('h2', { style: S.title }, 'BnnBot 记忆与人格'),
        h('p', { style: S.intro },
          '这里只放常用的 8 项。其余调优参数（召回预算、沉淀条数等）请直接编辑插件配置。'),
        h('div', { style: S.card }, rows),
        h('div', { style: S.bar },
          h('button', {
            type: 'button',
            style: { ...S.btn, opacity: saving || !changed.length ? 0.55 : 1, cursor: saving || !changed.length ? 'default' : 'pointer' },
            disabled: saving || !changed.length,
            onClick: save,
          }, saving ? '保存中…' : changed.length ? `保存 ${changed.length} 项` : '没有改动'),
          changed.length ? h('button', {
            type: 'button',
            style: S.btn,
            disabled: saving,
            onClick: () => setDraft(state.values || {}),
          }, '撤销') : null),
        notice ? h('p', {
          style: {
            ...S.msg,
            color: notice.ok
              ? 'var(--dsw-alias-state-success-primary, #080)'
              : 'var(--dsw-alias-state-error-primary, #c00)',
          },
        }, notice.text) : null);
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'bnnbotbox',
          order: 30,
          label: () => 'BnnBot 记忆与人格',
        }, Section));
      },
    };
  },
});
