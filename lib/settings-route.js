/**
 * settings-route — 给 DSH 设置面板用的读/写配置端点（宿主侧）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么需要这一层
 *
 *   DSH 的设置面板**不是**按 Config schema 自动生成表单的 —— 每个插件要自己
 *   写一个客户端页（`dsh.client` + `./client` 导出），注册到 `settings.section`。
 *   客户端只跑在浏览器里，改不了宿主配置，所以必须有一对端点：
 *
 *     GET  /api/bnnbotbox/config   读当前值（只返回白名单字段）
 *     POST /api/bnnbotbox/config   写（走 configEditor.edit，不是手改 YAML）
 *
 *   写路径**绝不**自己读写 cordis.patch.yml：那个文件属于用户，里面有别的
 *   插件、注释和 !!js 表达式。只走 `configEditor.edit(entry, fn)`，由宿主
 *   负责校验、串行化、并拒绝被上层覆盖的值。
 *
 * ── 两个坑（2026-11-24 实测踩过，别再踩）────────────────────────────────
 *
 *   ① **不能用 `ctx.get('webServer')`**：Cordis 的 ReflectService 代理在服务
 *      未声明进 inject 时会直接抛
 *        cannot get property "webServer" without inject
 *      正解是 `ctx.inject(['webServer'], (webCtx) => {...})` —— 子 fiber 在
 *      服务就绪时激活，插件卸载时自动清理。
 *      （曾经写成 ctx.get 的版本：设置页出来了，但端点 404，因为路由根本没注册。）
 *
 *   ② **口令要跨插件重启存活**：保存配置会重启插件，若每次 apply 都重新生成
 *      口令，页面上的旧口令立刻失效 —— 表现为「第一次能存，第二次 403」。
 *      所以口令存在 globalThis 的 symbol 槽里，跟进程同生命周期。
 *
 * ── 鉴权 ──────────────────────────────────────────────────────────────────
 *
 *   口令经 `webserver/index-inject` 事件注入成页面全局变量
 *   （`window.__DSH_BNNBOTBOX_TOKEN__`），客户端读它再放请求头；
 *   另加一层「仅本机回环」检查。缺一即 403，不靠"反正没人知道路径"。
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { randomUUID } from 'node:crypto';

/** 注入到页面里的全局变量名（客户端从这里取口令）。 */
export const TOKEN_GLOBAL = '__DSH_BNNBOTBOX_TOKEN__';

/** 端点路径。 */
export const ROUTE_PATH = '/api/bnnbotbox/config';

const HEADER = 'x-bnn-token';

/**
 * 保存的回执超时。
 *
 * 为什么要有：保存配置会让宿主**重启插件**，而我们的路由挂在插件上 ——
 * 重启一开始，这条 HTTP 响应就可能永远写不回去，浏览器一直等，
 * 表现为「点了保存，按钮停在保存中，没有任何提示」。
 * 超时后先给回执（202），让人知道「已提交、正在重启」，而不是干等。
 */
const SAVE_FEEDBACK_MS = 6000;
const TOKEN_SLOT = Symbol.for('dsh-bnnbotbox.settings-token');

/**
 * 口令：跨插件重启存活（同一宿主进程内不轮换）。
 * 宿主重启会换新的，页面随之刷新 —— 这是可接受的边界。
 */
export function settingsToken() {
  const g = globalThis;
  if (typeof g[TOKEN_SLOT] !== 'string' || !g[TOKEN_SLOT]) g[TOKEN_SLOT] = randomUUID();
  return g[TOKEN_SLOT];
}

/**
 * 设置页暴露的字段白名单（**故意只放常用的 8 项**）。
 *
 * 为什么不把 52 项全放出来：里面大半是调优旋钮
 * （`memoryRecallBudgetChars`、`distillMaxMessages` 之类），
 * 放出来只会让人不知道该怎么填。要改冷门项请直接编辑配置文件。
 */
export const FIELDS = [
  { key: 'enabled', kind: 'boolean', label: '总开关', hint: '关掉后本插件的记忆与人格功能整体停用（QQ 通道仍然工作）' },
  { key: 'autoCardEnabled', kind: 'boolean', label: '自动建档', hint: '按群消息/成员台账，为缺失的群卡与人物卡建骨架（只写可观测事实，不改已有卡）' },
  { key: 'memoryRecallEnabled', kind: 'boolean', label: '记忆召回', hint: '对话前自动捞相关记忆注入上下文' },
  { key: 'distillEnabled', kind: 'boolean', label: '记忆沉淀', hint: '定时从群聊提炼事实写进人物卡 History（慢工，建议先只开一个群试点）' },
  { key: 'lifeStreamEnabled', kind: 'boolean', label: '主动说话', hint: '按时间窗自己开口（受 QQ 主动消息限制，成功率本来就不高）' },
  { key: 'ownerWriteOnly', kind: 'boolean', label: '写操作仅主人', hint: '开启后群友只能搜/读/列记忆，不能改' },
  { key: 'memorySubdir', kind: 'string', label: '记忆目录', hint: '相对 qqbotDataRoot 的子目录；默认复用现有目录，别乱改' },
  { key: 'qqbotDataRoot', kind: 'string', label: 'QQ 数据根', hint: 'qqbot 的数据根目录；应指向 <工作区>/Bot/dshqqbot' },
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
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
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
 * 造一个 HTTP handler（导出来是为了能脱离 Cordis 单测）。
 *
 * @param {object} deps
 * @param {() => object} deps.readResolved 取当前**已解析**的配置（含默认值）
 * @param {(fn: (current: object) => object) => Promise<void>} deps.save 保存函数
 * @param {string} deps.token 口令
 */
export function createHandler({ readResolved, save, token }) {
  return async function handler(req, res) {
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

      const raw = await readBody(req);
      let parsed;
      try {
        parsed = JSON.parse(raw || '{}');
      } catch {
        return reply(res, 400, { ok: false, error: '请求体不是合法 JSON' });
      }
      const clean = sanitizePatch(parsed?.patch ?? parsed);
      if (!clean.ok) return reply(res, 400, { ok: false, error: clean.error });
      if (Object.keys(clean.patch).length === 0) return reply(res, 400, { ok: false, error: '没有要改的字段' });

      // 保存会让宿主重启插件 ⇒ 响应可能与拆插件赛跑。
      // 赢就回 200；超时先回 202（已提交、正在重启），绝不让人干等。
      const task = save((current) => ({ ...current, ...clean.patch }));
      const outcome = await Promise.race([
        task.then(() => 'done', (err) => ({ err })),
        new Promise((r) => setTimeout(() => r('pending'), SAVE_FEEDBACK_MS)),
      ]);

      if (outcome && typeof outcome === 'object' && 'err' in outcome) {
        const e = outcome.err;
        return reply(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) });
      }
      if (outcome === 'pending') {
        // 不让未处理的 rejection 冒出来
        Promise.resolve(task).catch(() => {});
        return reply(res, 202, {
          ok: true,
          pending: true,
          saved: clean.patch,
          note: '已提交，插件正在重启以应用配置',
        });
      }
      return reply(res, 200, { ok: true, saved: clean.patch });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // 宿主会拒绝被更高层覆盖的值 —— 如实回报，不假装保存成功
      return reply(res, 500, { ok: false, error: message });
    }
  };
}

/**
 * 安装设置端点（**必须走 ctx.inject**，见文件头坑①）。
 *
 * @param {object} ctx       插件 ctx
 * @param {() => object} readResolved 取当前已解析配置
 * @param {object} [logger]  可选日志
 * @returns {() => void} 仅供测试/手动清理；正常情况下子 fiber 自动清理
 */
export function installSettingsRoute(ctx, readResolved, logger) {
  const token = settingsToken();
  let installed = false;

  const mount = (webCtx) => {
    try {
      const entry = ctx?.fiber?.entry;
      // 同理：configEditor 没声明进 inject，ctx.get 会抛 —— 兜住并给出人话。
      const editor = () => {
        try {
          return typeof webCtx.get === 'function' ? webCtx.get('configEditor') : undefined;
        } catch {
          return undefined;
        }
      };

      const save = async (change) => {
        const ed = editor();
        if (entry === undefined || !ed) {
          throw new Error('这个 profile 不支持保存配置（没有 configEditor）');
        }
        await ed.edit(entry, change);
      };

      const handler = createHandler({ readResolved, save, token });
      const offRoute = webCtx.webServer.register({ kind: 'exact', path: ROUTE_PATH, handler });

      // 口令注入页面（DSH 的正规机制，不是 tapIndex 那种 HTML 替换）
      webCtx.on('webserver/index-inject', (table) => {
        if (!Array.isArray(table)) return;
        table.push({ kind: 'global', name: TOKEN_GLOBAL, value: token });
      });

      // 路由与子 fiber 同生命周期
      if (typeof webCtx.effect === 'function') webCtx.effect(() => offRoute);
      installed = true;
      logger?.info?.(`[bnnbotbox] 设置端点已挂载：${ROUTE_PATH}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger?.warn?.(`[bnnbotbox] 设置端点挂载失败: ${message}`);
    }
  };

  try {
    if (typeof ctx?.inject !== 'function') {
      logger?.warn?.('[bnnbotbox] 当前宿主没有 ctx.inject，设置端点跳过');
      return () => {};
    }
    ctx.inject(['webServer'], mount);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger?.warn?.(`[bnnbotbox] 设置端点 inject 失败: ${message}`);
  }

  return () => {
    if (!installed) return;
    installed = false;
  };
}
