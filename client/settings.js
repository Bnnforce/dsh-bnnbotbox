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

    /**
     * 上一次保存的结果，**存在模块级**。
     *
     * 因为保存会让宿主重启插件，客户端模块随之重新求值、组件重新挂载 ——
     * 只放在 useState 里的话，提示会在重启那一刻被清掉，
     * 表现为「点了保存，提示一闪就没了」。
     */
    let lastResult = null;

    function token() {
      return (typeof window !== 'undefined' && window[TOKEN_GLOBAL]) || '';
    }

    async function request(method, patch) {
      /*
       * 保存会让宿主重启插件 ⇒ 响应可能永远回不来。
       * 所以自己带超时：超时也当作「已提交」，而不是让人对着「保存中…」干等。
       */
      const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = ctrl ? setTimeout(() => ctrl.abort(), 15000) : null;
      let res;
      try {
        res = await fetch(API, {
          method,
          headers: { 'x-bnn-token': token(), 'content-type': 'application/json' },
          body: patch ? JSON.stringify({ patch }) : undefined,
          signal: ctrl ? ctrl.signal : undefined,
        });
      } catch (err) {
        if (err && err.name === 'AbortError') {
          return { ok: true, pending: true, saved: patch, note: '已提交，插件正在重启（本地等待超时）' };
        }
        throw err;
      } finally {
        if (timer) clearTimeout(timer);
      }
      let data;
      try {
        data = await res.json();
      } catch {
        throw new Error(`HTTP ${res.status}（响应不是 JSON）`);
      }
      // 202 = 已提交、插件正在重启：这是成功，不是错误
      if (res.status === 202 && data && data.ok) return data;
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
      /*
       * 提示横幅：必须放在按钮上方。
       * 放按钮下面时，手机上它会落到视口外 —— 实测用户点了保存、
       * 提示其实出现了但没看见，于是以为「没有提示」。
       */
      notice: {
        padding: '10px 12px',
        borderRadius: 8,
        fontSize: 13,
        lineHeight: '19px',
        borderLeft: '3px solid currentColor',
      },
    };

    function Section() {
      const [state, setState] = React.useState({ loading: true, error: '' });
      const [draft, setDraft] = React.useState({});
      const [saving, setSaving] = React.useState(false);
      const [notice, setNotice] = React.useState(() => lastResult);
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
          const r = await request('POST', patch);
          setState((s) => ({ ...s, values: { ...s.values, ...patch } }));
          lastResult = {
            ok: true,
            at: Date.now(),
            text: r && r.pending
              ? '已提交，插件正在重启以应用配置。几秒后刷新这个页面即可看到新值。'
              : '已保存。插件会重启一次使配置生效（当前会话可能短暂中断）。',
          };
          setNotice(lastResult);
        } catch (err) {
          lastResult = { ok: false, at: Date.now(), text: `保存失败：${err.message}` };
          setNotice(lastResult);
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

      /** 单个字段的控件。按 kind 决定用 checkbox / number / text。 */
      const renderControl = (f) => {
        const value = draft[f.key];
        if (f.kind === 'boolean') {
          return h('input', {
            type: 'checkbox',
            checked: value !== false,
            'aria-label': f.label,
            disabled: saving,
            onChange: (e) => set(f.key, e.target.checked),
            style: { marginTop: 3, cursor: 'pointer' },
          });
        }
        if (f.kind === 'number') {
          return h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 } },
            h('input', {
              type: 'number',
              value: value == null ? '' : value,
              min: f.min,
              max: f.max,
              step: f.step || 1,
              'aria-label': f.label,
              disabled: saving,
              onChange: (e) => set(f.key, e.target.value === '' ? '' : Number(e.target.value)),
              style: { ...S.input, marginTop: 0, flex: '0 0 140px' },
            }),
            h('span', { style: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' } },
              (f.min !== undefined && f.max !== undefined ? `${f.min} ~ ${f.max}` : '')
              + (f.unit ? ` ${f.unit}` : '')));
        }
        return h('input', {
          type: 'text',
          value: value == null ? '' : String(value),
          'aria-label': f.label,
          disabled: saving,
          onChange: (e) => set(f.key, e.target.value),
          style: { ...S.input, marginTop: 6 },
        });
      };

      /** 单个字段一行。 */
      const renderField = (f) => {
        const isBool = f.kind === 'boolean';
        return h('div', {
          key: f.key,
          style: { ...S.row, flexDirection: isBool ? 'row' : 'column' },
        },
          h('label', { style: S.label },
            h('span', { style: S.name }, f.label),
            h('span', { style: S.hint }, f.hint)),
          renderControl(f));
      };

      /** 按 group 把字段分组渲染。 */
      const renderGroups = () => {
        const groups = state.groups || [];
        const fields = state.fields || [];
        const out = [];
        for (const g of groups) {
          const members = fields.filter((f) => f.group === g.id);
          if (!members.length) continue;
          out.push(h('div', { key: 'g-' + g.id, style: { marginBottom: 6 } },
            h('h3', {
              style: {
                margin: '0 0 2px', fontSize: 14, fontWeight: 600,
                color: 'var(--dsw-alias-label-primary)',
              },
            }, g.label),
            g.desc ? h('p', {
              style: { margin: '0 0 10px', fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' },
            }, g.desc) : null,
            h('div', { style: S.card }, members.map(renderField))));
        }
        const orphans = fields.filter((f) => !groups.some((g) => g.id === f.group));
        if (orphans.length) {
          out.push(h('div', { key: 'g-other', style: { marginBottom: 6 } },
            h('h3', { style: { margin: '0 0 10px', fontSize: 14, fontWeight: 600 } }, '其它'),
            h('div', { style: S.card }, orphans.map(renderField))));
        }
        return out;
      };

      return h('div', { style: S.wrap },
        h('h2', { style: S.title }, 'BnnBot 记忆与人格'),
        h('p', { style: S.intro },
          '按功能分组。改完点保存，插件会重启一次使配置生效（当前会话可能短暂中断）。'),
        ...renderGroups(),
        notice ? h('div', {
          style: {
            ...S.notice,
            color: notice.ok
              ? 'var(--dsw-alias-state-success-primary, #0a7)'
              : 'var(--dsw-alias-state-error-primary, #c00)',
            background: notice.ok
              ? 'color-mix(in srgb, currentColor 10%, transparent)'
              : 'color-mix(in srgb, currentColor 12%, transparent)',
          },
          role: 'status',
          'aria-live': 'polite',
        }, notice.text) : null,

        h('div', { style: S.bar },
          h('button', {
            type: 'button',
            style: { ...S.btn, opacity: saving || !changed.length ? 0.55 : 1, cursor: saving || !changed.length ? 'default' : 'pointer' },
            disabled: saving || !changed.length,
            onClick: save,
          }, saving ? '保存中…' : changed.length ? `保存 ${changed.length} 项` : (notice && notice.ok ? '✓ 已保存' : '没有改动')),
          changed.length ? h('button', {
            type: 'button',
            style: S.btn,
            disabled: saving,
            onClick: () => setDraft(state.values || {}),
          }, '撤销') : null),
        );
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
