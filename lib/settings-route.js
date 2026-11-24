/**
 * settings-route — 给 DSH 设置面板用的只读/可写配置端点（宿主侧）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么需要这一层
 *
 *   DSH 的设置面板**不是**按 Config schema 自动生成表单的 —— 每个插件要自己
 *   写一个客户端页（`dsh.client` + `./client` 导出），注册到 `settings.section`
 *   slot 里。客户端只跑在浏览器里，改不了宿主配置，所以必须有一对端点：
 *
 *     GET  /api/bnnbotbox/config   读当前值（只返回白名单字段）
 *     POST /api/bnnbotbox/config   写（走 configEditor.edit，不是手改 YAML）
 *
 *   写路径**绝不**自己读写 cordis.patch.yml：那个文件属于用户，里面有别的
 *   插件、注释和 !!js 表达式。只走 `ctx.get('configEditor').edit(entry, fn)`，
 *   由宿主负责校验、串行化、并拒绝被上层覆盖的值。
 *
 * ── 鉴权 ──────────────────────────────────────────────────────────────────
 *
 *   口令在 apply 时随机生成，通过 `webServer.tapIndex()` 注入进 index.html
 *   （`window.__DSH_BNN_TOKEN__`），客户端页面读它再放请求头。
 *   另加一层：只接受本机回环地址来源。
 *   两道都不成立就 403，不靠"反正没人知道路径"。
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { randomUUID } from 'node:crypto';

/** 注入到页面里的全局变量名（客户端从这里取口令）。 */
export const TOKEN_GLOBAL = '__DSH_BNNBOTBOX_TOKEN__';

const HEADER = 'x-bnn-token';

/**
 * 设置页暴露的字段白名单（**故意只放常用的 8 项**）。
 *
 * 为什么不把 52 项全放出来：里面大半是调优旋钮
 * （`memoryRecallBudgetChars`、`distillMaxMessages` 之类），
 * 放出来只会让人不知道该怎么填。要改冷门项请直接编辑配置文件。
 */
export const FIELDS = [
  {
    key: 'enabled',
    kind: 'boolean',
    label: '总开关',
    hint: '关掉后本插件的记忆与人格功能整体停用（QQ 通道仍然工作）',
  },
  {
    key: 'autoCardEnabled',
    kind: 'boolean',
    label: '自动建档',
    hint: '按群消息/成员台账，为缺失的群卡与人物卡建骨架（只写可观测事实，不改已有卡）',
  },
  {
    key: 'memoryRecallEnabled',
    kind: 'boolean',
    label: '记忆召回',
    hint: '对话前自动捞相关记忆注入上下文',
  },
  {
    key: 'distillEnabled',
    kind: 'boolean',
    label: '记忆沉淀',
    hint: '定时从群聊提炼事实写进人物卡 History（慢工，建议先只开一个群试点）',
  },
  {
    key: 'lifeStreamEnabled',
    kind: 'boolean',
    label: '主动说话',
    hint: '按时间窗自己开口（受 QQ 主动消息限制，成功率本来就不高）',
  },
  {
    key: 'ownerWriteOnly',
    kind: 'boolean',
    label: '写操作仅主人',
    hint: '开启后群友只能搜/读/列记忆，不能改',
  },
  {
    key: 'memorySubdir',
    kind: 'string',
    label: '记忆目录',
    hint: '相对 qqbotDataRoot 的子目录；默认复用现有目录，别乱改',
  },
  {
    key: 'qqbotDataRoot',
    kind: 'string',
    label: 'QQ 数据根',
    hint: 'qqbot 的数据根目录；应指向 <工作区>/Bot/dshqqbot',
  },
];

const FIELDS_BY_KEY = new Map(FIELDS.map((f) => [f.key, f]));

/** 只返回白名单里的字段，并按 FIELDS 的顺序排列。 */
export function pickFields(resolved) {
  const out = {};
  for (const f of FIELDS) {
    const v = resolved?.[f.key];
    out[f.key] = v === undefined ? null : v;
  }
  return out;
}

/** 校验并规范化客户端提交的补丁：未知键直接拒绝（不静默丢弃，免得以为存上了）。 */
export function sanitizePatch(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: '请求体必须是对象' };
  }
  const patch = {};
  for (const [k, v] of Object.entries(input)) {
    const field = FIELDS_BY_KEY.get(k);
    if (!field) return { ok: false, error: `不支持的字段：${k}` };
    if (field.kind === 'boolean') {
      if (typeof v !== 'boolean') return { ok: false, error: `${field.label} 必须是布尔值` };
      patch[k] = v;
    } else {
      if (typeof v !== 'string') return { ok: false, error: `${field.label} 必须是字符串` };
      patch[k] = v.trim();
    }
  }
  return { ok: true, patch };
}

/** 是否是本机回环来源（IPv4/IPv6 都认）。 */
export function isLoopback(address) {
  const a = String(address || '');
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

function reply(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(text);
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * 安装设置端点。
 *
 * @param {object} ctx       插件 ctx（需要 webServer + configEditor 可选）
 * @param {() => object} readResolved 取当前**已解析**的配置（含默认值）
 * @returns {() => void} 清理函数（卸载路由与 index 注入）
 */
export function installSettingsRoute(ctx, readResolved) {
  const server = ctx?.get?.('webServer') ?? ctx?.webServer;
  if (!server || typeof server.register !== 'function') return () => {};

  const token = randomUUID();
  const disposers = [];

  const handler = async (req, res) => {
    try {
      if (!isLoopback(req.socket?.remoteAddress)) return reply(res, 403, { ok: false, error: '仅限本机访问' });
      if (String(req.headers[HEADER] || '') !== token) return reply(res, 403, { ok: false, error: '缺少有效令牌' });

      if (req.method === 'GET') {
        return reply(res, 200, { ok: true, fields: FIELDS, values: pickFields(readResolved()) });
      }
      if (req.method !== 'POST') {
        res.setHeader('allow', 'GET, POST');
        return reply(res, 405, { ok: false, error: '只支持 GET / POST' });
      }

      // ── 写入 ──
      const raw = await readBody(req);
      let parsed;
      try {
        parsed = JSON.parse(raw || '{}');
      } catch {
        return reply(res, 400, { ok: false, error: '请求体不是合法 JSON' });
      }
      const clean = sanitizePatch(parsed?.patch ?? parsed);
      if (!clean.ok) return reply(res, 400, { ok: false, error: clean.error });
      if (Object.keys(clean.patch).length === 0) {
        return reply(res, 400, { ok: false, error: '没有要改的字段' });
      }

      const entry = ctx?.fiber?.entry;
      const editor = ctx?.get?.('configEditor') ?? ctx?.configEditor;
      if (entry === undefined || !editor) {
        return reply(res, 503, {
          ok: false,
          error: '这个 profile 不支持保存配置（没有 configEditor）',
        });
      }

      await editor.edit(entry, (current) => ({ ...current, ...clean.patch }));
      return reply(res, 200, { ok: true, saved: clean.patch });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // 宿主会拒绝被更高层覆盖的值 —— 如实回报，不假装保存成功
      return reply(res, 500, { ok: false, error: message });
    }
  };

  try {
    disposers.push(server.register({ kind: 'exact', path: '/api/bnnbotbox/config', handler }));
  } catch {
    return () => {}; // 路由冲突（重复安装）→ 静默放弃，不拖垮插件
  }

  try {
    if (typeof server.tapIndex === 'function') {
      disposers.push(server.tapIndex((html) => {
        const script = `<script>window.${TOKEN_GLOBAL}=${JSON.stringify(token)}</script>`;
        return String(html).includes('</head>')
          ? String(html).replace('</head>', `${script}</head>`)
          : `${script}${html}`;
      }));
    }
  } catch {
    /* 注入失败不致命：设置页会显示"没有令牌" */
  }

  return () => {
    for (const d of disposers) {
      try {
        if (typeof d === 'function') d();
      } catch {
        /* ignore */
      }
    }
  };
}
