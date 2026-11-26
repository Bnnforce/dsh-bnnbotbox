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

/** 诊断写文件（logger 不进控制台时仍可查）。 */
async function diagWrite(event, extra = {}) {
  try {
    const { appendFileSync, mkdirSync } = await import('node:fs');
    const { join } = await import('node:path');
    const home = process.env.DSH_HOME || '/data/user/0/com.dsharnessmobile.shell/files/home/.dsh';
    const dir = join(home, 'data', 'dsh-anti-ai-persona');
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, 'settings-route-diag.log'),
      JSON.stringify({ at: new Date().toISOString(), event, ...extra }) + '\n', 'utf8');
  } catch { /* 诊断失败不影响功能 */ }
}

/** 注入到页面里的全局变量名（客户端从这里取口令）。 */
export const TOKEN_GLOBAL = '__DSH_BNNBOTBOX_TOKEN__';

/** 端点路径。 */
// ★ 2026-11-26 修（真机 404 根因）：DSH 的 client-connection 服务用 **prefix 路由**
//   霸占了整个 `/api` 前缀（dsh-client-connection 里 kind:"prefix", path:"/api"）。
//   webServer 先匹配到它的 prefix，我们注册的 exact 路由永远轮不到 ⇒ 401/404。
//   所以把路径挪出 `/api`。
export const ROUTE_PATH = '/bnnbotbox/config';

/** 同源握手端点：页面拿不到注入的全局变量时，用它换口令（2026-11-26 新增）。 */
export const HANDSHAKE_PATH = '/bnnbotbox/handshake';

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
 * 设置页暴露的字段白名单（2026-11-25 全量开放 + 分组）。
 *
 * 旧版只放 8 项，理由是「调优旋钮放出来只会让人不知道该怎么填」。
 * 但那导致：想改主动说话频率/召回预算/语义召回参数，只能手改 YAML —— 对手机用户不可行。
 *
 * 现在改为**按功能分组全量开放**，每组标清楚「这组管什么」，危险项加约束提示。
 *
 * 字段结构：
 *   key      config 键名
 *   kind     'boolean' | 'string' | 'number' | 'path'
 *   group    分组 id（前端按此分组渲染）
 *   label    中文名
 *   hint     一句话说明
 *   min/max  number 的取值范围（前端做输入约束，后端也校验）
 *   unit     number 的单位后缀
 */
export const FIELDS = [
  // ══ 基础 ══════════════════════════════════════════════════════════════
  { key: 'enabled', kind: 'boolean', group: 'basic', label: '总开关',
    hint: '关掉后本插件的记忆与人格功能整体停用（QQ 通道仍然工作）' },
  { key: 'qqbotDataRoot', kind: 'path', group: 'basic', label: 'QQ 数据根',
    hint: 'qqbot 的数据根目录，通常指向 <工作区>/Bot/dshqqbot' },
  { key: 'memorySubdir', kind: 'string', group: 'basic', label: '记忆子目录', source: 'memory',
    hint: '记忆库相对 QQ 数据根的子目录，默认复用现有目录（零迁移）' },
  { key: 'ownerWriteOnly', kind: 'boolean', group: 'basic', label: '写操作仅主人', source: 'memory',
    hint: '开启后群友只能搜/读/列记忆，不能改' },

  // ══ 记忆召回 ══════════════════════════════════════════════════════════
  { key: 'memoryRecallEnabled', kind: 'boolean', group: 'recall', label: '记忆召回',
    hint: '对话前自动捞相关记忆注入上下文' },
  { key: 'memoryRecallSemantic', kind: 'boolean', group: 'recall', label: '语义召回',
    hint: '用本地向量模型按意思找记忆（关掉则退回按字符预算拼文件）' },
  { key: 'memoryRecallSemanticTopK', kind: 'number', group: 'recall', label: '召回条数',
    min: 1, max: 20, step: 1, hint: '每次最多捞几条相关记忆' },
  { key: 'memoryRecallSemanticTauDays', kind: 'number', group: 'recall', label: '时间衰减（天）',
    min: 1, max: 365, step: 1, unit: '天', hint: '多少天前的记忆权重降到 1/e，越大越「念旧」' },
  { key: 'memoryRecallDecay', kind: 'boolean', group: 'recall', label: '记忆衰退',
    hint: '只作用于事件层；人物卡/群卡永不衰退' },
  { key: 'memoryRecallDecayReport', kind: 'boolean', group: 'recall', label: '衰退报告',
    hint: '每天导出一次「被降级的记忆」，方便事后回查' },
  { key: 'memoryRecallBudgetChars', kind: 'number', group: 'recall', label: '召回总预算',
    min: 40, max: 700, step: 10, unit: '字', hint: '注入 prompt 的记忆总字数上限' },
  { key: 'memoryRecallPersonChars', kind: 'number', group: 'recall', label: '人物档案上限',
    min: 20, max: 300, step: 10, unit: '字', hint: '单个群友档案的字数上限' },
  { key: 'memoryRecallGroupChars', kind: 'number', group: 'recall', label: '群档案上限',
    min: 10, max: 200, step: 10, unit: '字', hint: '群档案的字数上限' },
  { key: 'memoryRecallEventsChars', kind: 'number', group: 'recall', label: '事件上限',
    min: 20, max: 300, step: 10, unit: '字', hint: '最近事件的字数上限' },
  { key: 'memoryRecallRecentDays', kind: 'number', group: 'recall', label: '「最近」天数',
    min: 1, max: 30, step: 1, unit: '天', hint: '「最近事件」指多少天内' },
  { key: 'memoryRecallMaxEvents', kind: 'number', group: 'recall', label: '事件条数',
    min: 0, max: 10, step: 1, unit: '条', hint: '最多取几条最近事件' },
  { key: 'memoryRecallMaxPersonFiles', kind: 'number', group: 'recall', label: '最多扫几人',
    min: 1, max: 200, step: 10, unit: '人', hint: '一次最多扫多少个群友档案' },
  { key: 'memoryRecallCacheTtlMin', kind: 'number', group: 'recall', label: '缓存有效期',
    min: 0.1, max: 60, step: 0.5, unit: '分钟', hint: '人物档案缓存的过期时间' },

  // ══ 记忆沉淀 ══════════════════════════════════════════════════════════
  { key: 'distillEnabled', kind: 'boolean', group: 'distill', label: '记忆沉淀', source: 'memory',
    hint: '定时从群聊提炼事实写进人物卡 History（默认关闭，试点用）' },
  { key: 'distillGroupIds', kind: 'string', group: 'distill', label: '沉淀试点群', source: 'memory',
    hint: '群 openid 逗号分隔；留空 = 全部（建议先只填一个群）' },
  { key: 'distillMaxMessages', kind: 'number', group: 'distill', label: '单次处理条数', source: 'memory',
    min: 10, max: 5000, step: 10, unit: '条', hint: '单次单群最多处理多少条消息' },
  { key: 'distillMaxHistory', kind: 'number', group: 'distill', label: 'History 上限', source: 'memory',
    min: 1, max: 100, step: 1, unit: '条', hint: '每人卡 History 段最多保留多少条事实' },
  { key: 'autoCardEnabled', kind: 'boolean', group: 'distill', label: '自动建档', source: 'memory',
    hint: '为缺失的群卡与人物卡建骨架（只写可观测事实，不改已有卡）' },
  { key: 'autoCardGroupEnabled', kind: 'boolean', group: 'distill', label: '也建群卡', source: 'memory',
    hint: '关闭 = 只建人物卡，不建群卡' },
  { key: 'autoCardMinMessages', kind: 'number', group: 'distill', label: '建档门槛', source: 'memory',
    min: 1, max: 200, step: 1, unit: '条', hint: '至少说过多少条话才建人物卡（防给路人建垃圾卡）' },
  { key: 'autoCardMaxPerGroup', kind: 'number', group: 'distill', label: '建卡上限', source: 'memory',
    min: 1, max: 50, step: 1, unit: '张', hint: '每个群一次最多自动新建几篇人物卡' },
  { key: 'autoCardIgnoreNames', kind: 'string', group: 'distill', label: '跳过昵称', source: 'memory',
    hint: '不自动建档的昵称，逗号分隔（服务号/机器人）' },
  { key: 'searchMaxHits', kind: 'number', group: 'recall', label: '搜索命中上限', source: 'memory',
    min: 1, max: 100, step: 1, unit: '条', hint: '搜索最多返回多少条命中（防爆 context）' },
  { key: 'readMaxBytes', kind: 'number', group: 'recall', label: '单文件读取上限', source: 'memory',
    min: 1024, max: 1048576, step: 1024, unit: '字节', hint: '超过就跳过并 warn' },
  { key: 'writeMaxBytesPerEntry', kind: 'number', group: 'distill', label: '单条记忆上限', source: 'memory',
    min: 50, max: 20000, step: 50, unit: '字', hint: '一条记忆最多写多少字' },
  { key: 'writeMaxEntriesPerScope', kind: 'number', group: 'distill', label: '单群记忆上限', source: 'memory',
    min: 10, max: 5000, step: 10, unit: '条', hint: '单个群最多多少条记忆（防无限增长）' },
  { key: 'enableMaintenanceTask', kind: 'boolean', group: 'distill', label: '记忆维护任务', source: 'memory',
    hint: '登记维护任务到任务中心（定期回收站清理）' },
  { key: 'maintenanceEveryMs', kind: 'number', group: 'distill', label: '维护间隔', source: 'memory',
    min: 3600000, max: 86400000, step: 3600000, unit: 'ms', hint: '记忆维护任务的节律（默认 6 小时）' },

  // ══ 主动说话 ══════════════════════════════════════════════════════════
  { key: 'lifeStreamEnabled', kind: 'boolean', group: 'speak', label: '主动说话',
    hint: '按时间窗自己开口（受 QQ 主动消息限制，成功率本来就不高）' },
  { key: 'lifeStreamDailyMax', kind: 'number', group: 'speak', label: '每天最多',
    min: 1, max: 3, step: 1, unit: '次', hint: '一天最多主动开口几次（上限硬夹在 3）' },
  { key: 'lifeStreamMinGapMin', kind: 'number', group: 'speak', label: '最小间隔',
    min: 30, max: 720, step: 10, unit: '分钟', hint: '两次开口之间至少隔多久' },
  { key: 'lifeStreamHoursFrom', kind: 'number', group: 'speak', label: '开口起始时间',
    min: 0, max: 23, step: 1, unit: '点', hint: '每天从几点开始允许主动开口' },
  { key: 'lifeStreamHoursTo', kind: 'number', group: 'speak', label: '开口结束时间',
    min: 1, max: 24, step: 1, unit: '点', hint: '每天到几点为止（不含该点）' },

  // ══ 主动惦记（老友/生日）══════════════════════════════════════════════
  { key: 'memoryCallbackEnabled', kind: 'boolean', group: 'callback', label: '主动惦记',
    hint: '老友久未出现 / 生日临近时主动开口' },
  { key: 'memoryCallbackDailyMax', kind: 'number', group: 'callback', label: '每天最多',
    min: 1, max: 3, step: 1, unit: '次', hint: '一天最多主动惦记几次' },
  { key: 'memoryCallbackMinGapDays', kind: 'number', group: 'callback', label: '久未出现阈值',
    min: 1, max: 60, step: 1, unit: '天', hint: '多久没说话算「老友久未出现」' },
  { key: 'memoryCallbackMinMessages', kind: 'number', group: 'callback', label: '老友判定',
    min: 0, max: 10000, step: 10, unit: '条', hint: '历史消息至少多少条才算老友' },
  { key: 'memoryCallbackHoursFrom', kind: 'number', group: 'callback', label: '惦记起始时间',
    min: 0, max: 23, step: 1, unit: '点', hint: '每天从几点开始允许惦记' },
  { key: 'memoryCallbackHoursTo', kind: 'number', group: 'callback', label: '惦记结束时间',
    min: 1, max: 24, step: 1, unit: '点', hint: '每天到几点为止（不含该点）' },
  { key: 'memoryCallbackOwnBirthday', kind: 'boolean', group: 'callback', label: '自己的生日也提醒',
    hint: '默认关闭：自己的生日交给扩展包自祝，避免同一件事说两次' },

  // ══ 复盘与审判 ════════════════════════════════════════════════════════
  { key: 'reviewEnabled', kind: 'boolean', group: 'review', label: '自动复盘',
    hint: '每天定时回看自己的回复，把「像客服」这类问题记进错题本' },
  { key: 'reviewHour', kind: 'number', group: 'review', label: '复盘时间',
    min: 0, max: 23, step: 1, unit: '点', hint: '每天几点做复盘（建议凌晨低峰）' },
  { key: 'reviewProvider', kind: 'string', group: 'review', label: '复盘模型供应商',
    hint: '留空 = 用默认供应商' },
  { key: 'reviewModel', kind: 'string', group: 'review', label: '复盘模型',
    hint: '留空 = 用默认模型' },
  { key: 'autoJudgeEnabled', kind: 'boolean', group: 'review', label: '自动判官',
    hint: '实时判断自己的回复像不像人话' },
  { key: 'autoJudgeRate', kind: 'number', group: 'review', label: '判官抽样率',
    min: 0, max: 1, step: 0.1, hint: '0 = 不判，1 = 每条都判（越判越贵）' },
  { key: 'autoJudgeMinLength', kind: 'number', group: 'review', label: '判官最小长度',
    min: 0, max: 200, step: 5, unit: '字', hint: '短于这个长度的回复不送判官（省成本）' },

  // ══ 分析 ══════════════════════════════════════════════════════════════
  { key: 'analysisIntervalMin', kind: 'number', group: 'analysis', label: '分析间隔',
    min: 1, max: 720, step: 5, unit: '分钟', hint: '多久跑一次群消息分析' },
  { key: 'maxHistoryDays', kind: 'number', group: 'analysis', label: '历史保留',
    min: 1, max: 90, step: 1, unit: '天', hint: '分析时回看多少天的历史' },
];

/** 分组元信息（前端按此渲染分节标题与说明）。 */
export const GROUPS = [
  { id: 'basic', label: '基础', desc: '总开关与数据位置' },
  { id: 'recall', label: '记忆召回', desc: '对话前如何挑记忆注入' },
  { id: 'distill', label: '记忆沉淀', desc: '把群聊变成长期记忆' },
  { id: 'speak', label: '主动说话', desc: '她自己什么时候开口' },
  { id: 'callback', label: '主动惦记', desc: '老友与生日提醒' },
  { id: 'review', label: '复盘与判官', desc: '自我检查像不像人话' },
  { id: 'analysis', label: '分析', desc: '群消息分析频率' },
];

const FIELDS_BY_KEY = new Map(FIELDS.map((f) => [f.key, f]));

/** 只返回白名单里的字段，并按 FIELDS 的顺序排列。 */
export function pickFields(resolved) {
  const out = {};
  const mem = resolved?.memory && typeof resolved.memory === 'object' ? resolved.memory : {};
  for (const f of FIELDS) {
    // memory 来源的字段优先从 config.memory 取，取不到再回落顶层（兼容老配置）
    const v = f.source === 'memory'
      ? (mem[f.key] !== undefined ? mem[f.key] : resolved?.[f.key])
      : resolved?.[f.key];
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
    } else if (field.kind === 'number') {
      // 前端 input 的值天然是字符串，也允许直接传 number
      const raw = typeof v === 'number' ? v : Number(String(v).trim());
      if (!Number.isFinite(raw)) return { ok: false, error: `${field.label} 必须是数字` };
      if (field.min !== undefined && raw < field.min) return { ok: false, error: `${field.label} 不能小于 ${field.min}` };
      if (field.max !== undefined && raw > field.max) return { ok: false, error: `${field.label} 不能大于 ${field.max}` };
      patch[k] = raw;
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
/**
 * 判断请求是否来自「本机同源的页面」。
 *
 * 为什么需要这个（2026-11-26）：
 *   设置页靠 HTML 注入的 window.__DSH_BNNBOTBOX_TOKEN__ 取口令。实测在某些宿主上
 *   注入没生效（页面显示「读不到配置：缺少有效令牌」），而端点本身是好的。
 *   于是加一条同源握手兜底：只要请求带着浏览器的同源标记，就把口令交给它。
 *
 * 安全性说明（诚实交代边界）：
 *   · 仍然要求 loopback（非本机一律拒绝）
 *   · 要求 sec-fetch-site 为 same-origin/none，或 Referer 指向本机页面
 *   · 恶意 App 理论上可以伪造这些头。但在 Android 上它本来就能直接改
 *     /sdcard 上的配置文件，所以这道锁的主要价值是「防误触/防跨站」，
 *     不是「防本机恶意程序」—— 那需要的是文件权限，不是 HTTP 令牌。
 */
export function isSameOriginPage(req) {
  const site = String(req?.headers?.['sec-fetch-site'] ?? '').toLowerCase();
  if (site === 'same-origin' || site === 'none') return true;
  const ref = String(req?.headers?.referer ?? '');
  if (!ref) return false;
  return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\//.test(ref);
}

/** 握手 handler：本机同源页面可用它换取口令。 */
export function createHandshakeHandler({ token }) {
  return async function handler(req, res) {
    if (!isLoopback(req.socket?.remoteAddress)) {
      return reply(res, 403, { ok: false, error: '仅限本机访问' });
    }
    if (!isSameOriginPage(req)) {
      return reply(res, 403, { ok: false, error: '仅限本机页面调用' });
    }
    return reply(res, 200, { ok: true, token });
  };
}

export function createHandler({ readResolved, save, token }) {
  return async function handler(req, res) {
    try {
      if (!isLoopback(req.socket?.remoteAddress)) return reply(res, 403, { ok: false, error: '仅限本机访问' });
      if (String(req.headers[HEADER] || '') !== token) return reply(res, 403, { ok: false, error: '缺少有效令牌' });

      if (req.method === 'GET') {
        return reply(res, 200, { ok: true, fields: FIELDS, groups: GROUPS, values: pickFields(readResolved()) });
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
      // ★ 2026-11-25：字段有两个来源 —— persona（写顶层）与 memory（写 config.memory）。
      //   index.js 里 memory 读 config.memory（有则用，否则回落 config），
      //   所以 memory 字段必须写进 config.memory 才不会污染 persona 命名空间。
      const task = save((current) => {
        const next = { ...current };
        const memoryPatch = {};
        for (const [k, v] of Object.entries(clean.patch)) {
          const field = FIELDS_BY_KEY.get(k);
          if (field && field.source === 'memory') memoryPatch[k] = v;
          else next[k] = v;
        }
        if (Object.keys(memoryPatch).length) {
          next.memory = { ...(current.memory ?? {}), ...memoryPatch };
        }
        return next;
      });
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

  // ★ 2026-11-26：注入监听挂**外层 ctx**（官方 dsh-client-ui-settings-account 同样写法）。
  //   原来挂在 inject 回调的 webCtx 上，实测注入没生效 —— 页面报「缺少有效令牌」。
  try {
    if (typeof ctx?.on === 'function') {
      ctx.on('webserver/index-inject', (table) => {
        if (!Array.isArray(table)) return;
        table.push({ kind: 'global', name: TOKEN_GLOBAL, value: token });
      });
    }
  } catch { /* 注入是尽力而为，失败有握手兜底 */ }

  const mount = (webCtx) => {
    // ★ 2026-11-26：幂等保护。
    //   webServer.register 对重复 path 会抛 "duplicate exact route"。
    //   插件热重载 / inject 回调被调用两次时，第二次会抛错 ⇒ 整段挂载失败 ⇒ 404。
    if (installed) {
      diagWrite('mount-skipped', { route: ROUTE_PATH });
      return;
    }
    // 先确认 webServer 真的可用（不然 register 抛 TypeError 会被下面 catch 吞掉）
    if (!webCtx || typeof webCtx.webServer?.register !== 'function') {
      diagWrite('mount-failed-no-webServer', {
        hasWebCtx: Boolean(webCtx),
        hasWebServer: Boolean(webCtx?.webServer),
        registerType: typeof webCtx?.webServer?.register,
        keys: webCtx ? Object.keys(webCtx).slice(0, 20) : [],
      });
      logger?.warn?.('[bnnbotbox] 设置端点挂载失败：webServer.register 不可用');
      return;
    }
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
        // ★ 2026-11-26 修（404 真根因）：
        //   cordis 的 effect(execute) 会**立即执行** execute，并收集它的返回值当清理函数。
        //   我原来写反了：先 register，再把 offRoute 当清理函数传进去 ⇒
        //   effect 立即执行 offRoute() ⇒ **注册完立刻把路由删掉** ⇒ exactHas=false ⇒ 404。
        //   官方写法（dsh-client-modules:624）是 register 放在 effect 回调里：
        //     webCtx.effect(() => webCtx.webServer.register({...}), "label")
        webCtx.effect(() => {
          const off1 = webCtx.webServer.register({ kind: 'exact', path: ROUTE_PATH, handler });
          const off2 = webCtx.webServer.register({
            kind: 'exact',
            path: HANDSHAKE_PATH,
            handler: createHandshakeHandler({ token }),
          });
          return () => {
            off1?.();
            off2?.();
          };
        }, 'bnnbotbox: settings routes');
      installed = true;
      logger?.info?.(`[bnnbotbox] 设置端点已挂载：${ROUTE_PATH}`);
      diagWrite('mounted', {
        route: ROUTE_PATH,
        handshake: HANDSHAKE_PATH,
        // ★ 验证路由是否真的进了这个 webServer 实例的 exact 表
        exactHas: typeof webCtx.webServer?.exact?.has === 'function' ? webCtx.webServer.exact.has(ROUTE_PATH) : 'no-exact-table',
        exactSize: typeof webCtx.webServer?.exact?.size === 'number' ? webCtx.webServer.exact.size : -1,
        wsKeys: Object.keys(webCtx.webServer || {}).slice(0, 15),
        hasFallback: Boolean(webCtx.webServer?.fallback),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger?.warn?.(`[bnnbotbox] 设置端点挂载失败: ${message}`);
      diagWrite('mount-failed', { error: message, stack: (err instanceof Error ? err.stack : '').slice(0, 500) });
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
