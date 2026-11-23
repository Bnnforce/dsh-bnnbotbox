/**
 * 碎片生活流 — 主动开口的判定与 Prompt 构造（**纯函数层**）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么需要这个模块（2026-11-07 实测数据）：
 *   她的真实回复里 **96% 是被动回应，只有 4% 是主动开口**。
 *   现有心跳只在「群安静太久」时触发，产出的必然是「群好安静呀」「有人陪我聊聊吗」
 *   —— 这是**群管的做法**，不是人的做法。
 *   真人冒泡的动机是「**我正好遇到件事**」，不是「群太安静了我得说点什么」。
 *
 * 本模块做的是：让她**不定时**说一句自己的生活小事（每天 1-3 次）。
 *   示例：
 *     14:20  刚泡了杯茶，第一泡忘了时间，苦得刚好。
 *     17:05  追着只蝴蝶跑了一会儿，现在有点喘。
 *     22:30  夜里安静得不像话，我还在看书。
 *
 * ⚠️ 与 `life-events.ts` 的**本质区别**（这是本模块存在的唯一理由）：
 *   · `life-events.lifeBackgroundText()` = 「隐藏背景板」，
 *     **明确禁止主动提起**，只在语境合适时自然流露
 *     （原文：「绝对禁止生硬地主动提起（比如"我今天在喝茶"）」）。
 *   · 本模块 = 「主动开口」，**就是要把这件事说出来**。
 *   两者读**同一份** `daily-mood.json`，但生成完全不同的 Prompt，**互斥使用**
 *   （同一素材一天只走一条路，避免同一件事说两遍）。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 纪律（照 `life-events.ts` 的规矩，`开发规则` 四.1 / `审查标准` 一）：
 *   · **纯函数**：无 IO、无 `Date.now()`、无随机源副作用（`now` / `hour` / `random` 全部入参）
 *   · **无魔法数字**：所有阈值来自入参 config
 *   · **单一职责**：给一堆状态 → 返回 `go` / `skip(reason)`
 *   · 便于单测：所有分支都能用纯输入触发
 * ═══════════════════════════════════════════════════════════════════════════
 */
/**
 * 默认参数。
 *
 * ⚠️ 这些值是「**默认**」，不是「写死的魔法数字」——调用方总会传入
 * `resolveConfig` 的结果（见 `config.ts`）。这里单列一份只为：
 *   ① 单测可以不构造完整 config 直接跑；
 *   ② 文档化默认行为。
 */
export const LIFE_STREAM_DEFAULTS = {
    enabled: true,
    dailyMax: 3,
    minGapMs: 90 * 60 * 1000,
    hoursFrom: 8,
    hoursTo: 24,
    busyWindowMs: 5 * 60 * 1000,
    deadWindowMs: 3 * 60 * 60 * 1000,
};
// ── 硬上限（防止配置写炸）────────────────────────────────────────────────
/** 每日上限的绝对天花板：无论如何配，一天不超过 3 次。 */
export const HARD_MAX_DAILY = 3;
/** 间隔的绝对地板：再短也至少 30 分钟。 */
export const HARD_MIN_GAP_MS = 30 * 60 * 1000;
/** 间隔的绝对天花板：再长也不超过 12 小时（否则一天最多说一次）。 */
export const HARD_MAX_GAP_MS = 12 * 60 * 60 * 1000;
/** 把配置夹到合法区间（**纯函数**）。配置写错时不会静默失效。 */
export function clampLifeStreamConfig(input) {
    const src = input ?? {};
    const num = (v, fallback) => {
        const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
        return Number.isFinite(n) ? n : fallback;
    };
    const dailyMax = Math.min(HARD_MAX_DAILY, Math.max(1, Math.round(num(src.dailyMax, LIFE_STREAM_DEFAULTS.dailyMax))));
    const minGapMs = Math.min(HARD_MAX_GAP_MS, Math.max(HARD_MIN_GAP_MS, Math.round(num(src.minGapMs, LIFE_STREAM_DEFAULTS.minGapMs))));
    const hoursFrom = Math.min(23, Math.max(0, Math.round(num(src.hoursFrom, LIFE_STREAM_DEFAULTS.hoursFrom))));
    const hoursTo = Math.min(24, Math.max(1, Math.round(num(src.hoursTo, LIFE_STREAM_DEFAULTS.hoursTo))));
    const busyWindowMs = Math.max(60_000, Math.round(num(src.busyWindowMs, LIFE_STREAM_DEFAULTS.busyWindowMs)));
    const deadWindowMs = Math.max(busyWindowMs, // ⚠️ dead 必须 >= busy，否则「busy 和 dead 之间」变成无法开口的死区
    Math.round(num(src.deadWindowMs, LIFE_STREAM_DEFAULTS.deadWindowMs)));
    return {
        enabled: src.enabled !== false,
        dailyMax,
        minGapMs,
        hoursFrom,
        hoursTo,
        busyWindowMs,
        deadWindowMs,
    };
}
/** 判断 `hour` 是否落在 `[from, to)` 内（**严格半开区间**，`开发规则` 四.3 / `审查标准` 三）。 */
export function isHourInWindow(hour, hoursFrom, hoursTo) {
    const h = Number.isFinite(hour) ? Math.min(23, Math.max(0, Math.floor(hour))) : 0;
    const from = Math.min(23, Math.max(0, hoursFrom));
    const to = Math.min(24, Math.max(1, hoursTo));
    if (from === to)
        return false; // 零宽窗口 = 永不开口（显式意图，不做特判）
    if (from < to)
        return h >= from && h < to; // 常规：如 [8, 24)
    return h >= from || h < to; // 跨零：如 [22, 6)
}
/**
 * 判定这一轮要不要主动开口。
 *
 * **判定顺序即优先级**（越前越硬，短路返回）：
 *   1. 总开关     → `disabled`
 *   2. 时段       → `night`        （深夜开口最容易打扰）
 *   3. 每日配额   → `quota`
 *   4. 最小间隔   → `gap`
 *   5. 素材存在   → `no-material`
 *   6. 素材未用   → `material-used`
 *   7. 群刚活跃   → `busy`
 *   8. 群死寂太久 → `dead`
 *   全部通过      → `go`
 *
 * 为什么「时段/配额」排在「素材」之前：
 *   素材每次都要读盘，而开关/时段/配额是**纯内存判断**——
 *   先做便宜的硬闸门，能少读几次盘（虽然本机 IO 不是瓶颈，但逻辑更清晰）。
 */
export function decideLifeStream(input) {
    const cfg = input.config ?? LIFE_STREAM_DEFAULTS;
    // ① 总开关
    if (cfg.enabled === false)
        return { ok: false, reason: 'disabled' };
    // ② 时段（严格半开区间）
    if (!isHourInWindow(input.hour, cfg.hoursFrom, cfg.hoursTo))
        return { ok: false, reason: 'night' };
    // ③ 每日配额（再夹一次，防止调用方传了没 clamp 过的 config）
    const max = Math.min(HARD_MAX_DAILY, Math.max(1, Math.round(cfg.dailyMax)));
    const todayCount = Number.isFinite(input.todayCount) ? Math.max(0, Math.floor(input.todayCount)) : 0;
    if (todayCount >= max)
        return { ok: false, reason: 'quota' };
    // ④ 最小间隔
    const gap = Math.min(HARD_MAX_GAP_MS, Math.max(HARD_MIN_GAP_MS, Math.round(cfg.minGapMs)));
    const lastAt = Number.isFinite(input.lastAt) ? Number(input.lastAt) : 0;
    if (lastAt > 0 && input.now - lastAt < gap)
        return { ok: false, reason: 'gap' };
    // ⑤ 素材存在
    const material = String(input.material ?? '').trim();
    if (!material)
        return { ok: false, reason: 'no-material' };
    // ⑥ 素材未被用过
    if (input.materialUsed)
        return { ok: false, reason: 'material-used' };
    // ⑦⑧ 群活跃度（`-1` = 读不到 → 跳过这两道，不因此永久静音）
    const idle = Number.isFinite(input.groupIdleMs) ? Number(input.groupIdleMs) : -1;
    if (idle >= 0) {
        if (idle < cfg.busyWindowMs)
            return { ok: false, reason: 'busy' };
        if (idle > cfg.deadWindowMs)
            return { ok: false, reason: 'dead' };
    }
    return { ok: true, reason: 'go', material };
}
/**
 * 构造「主动开口」的 Prompt。
 *
 * ⚠️ 与 `life-events.buildLifeBackgroundText()` **完全相反**：
 *   那个函数写的是「绝对禁止主动提起」；本函数写的是「**本轮就是要主动提起**」。
 *   两者读同一份素材，**一天只走一条路**（`usedMaterials` 互斥，见 `index.ts`）。
 *
 * 硬约束逐条对应 `角色卡` 里明令禁止的模式：
 *   · 禁止「群好安静」→ 群管腔
 *   · 禁止打卡报备「我今天在喝茶」→ 人设卡 §2.1
 *   · 禁止追问、禁止求回应 → 冒泡不是找话头
 *
 * @param input.material   素材原文（如「在院子里晒太阳」）
 * @param input.slotLabel  时段中文名（如「下午」）
 * @param input.recentChat 最近几条群聊（**只作语感参考，明令禁止接话**）
 */
export function buildLifeStreamPrompt(input) {
    const material = String(input.material ?? '').trim();
    if (!material)
        return ''; // 空素材 → 空 prompt（调用方据此不发）
    const slotLabel = String(input.slotLabel ?? '').trim() || '现在';
    const recent = String(input.recentChat ?? '').trim();
    return [
        '【你此刻的生活（本轮要主动提起）】',
        material,
        '',
        '【最近群聊（只作语感参考，不要接话）】',
        recent || '（群里这会儿没人说话）',
        '',
        '【本轮任务】',
        `现在是${slotLabel}。把上面那件小事，随口说一句发到群里。`,
        '',
        '【硬约束】',
        '- 只输出一句话，最多两句，不超过 25 字。',
        '- 直接说你自己的事。不要先评论群（不写"群里好安静""没人说话呀"）。',
        '- 不要问别人在干嘛、不要求回应。说完就完了。',
        '- 不要报备式打卡（不写"我今天在喝茶"）。要带一个具体细节。',
        '- 语气贴合当前人格。不要客服腔、不解释、不写标签、不写"（这条是主动冒泡）"。',
        '',
        '只输出消息正文。',
    ].join('\n');
}
/**
 * 从模型输出里剥掉可能出现的元信息前缀/包裹，得到**可发出去的正文**。
 *
 * 模型偶尔会不听话地加 `[生活流]`、`（主动冒泡）`、引号包裹等。
 * 这里做**本地强校验**（`开发规则` 五.1 / `审查标准` 四：绝不盲信模型输出）。
 *
 * @returns 清洗后的正文；空串表示「这条不能用」（调用方丢弃）
 */
export function sanitizeLifeStreamOutput(raw) {
    let text = String(raw ?? '').trim();
    if (!text)
        return '';
    // ① 剥掉常见标签前缀（中英文方括号/圆括号都算）
    text = text
        .replace(/^\s*[【\[(（]\s*(?:生活流|主动冒泡|心跳|主动开口|life[- ]?stream)\s*[】\])）]\s*[：:，,。.、\-—]?\s*/iu, '')
        .replace(/^\s*[（(]\s*(?:这条|本条)?\s*(?:是)?\s*(?:主动|心跳)?(?:冒泡|开口)\s*[）)]\s*/u, '');
    // ② 剥掉整句被引号包裹的情况：`"xxx"` / `「xxx」` / `'xxx'`
    const quoted = text.match(/^["'“「『]([^"'”」』]+)["'”」』]$/u);
    if (quoted && typeof quoted[1] === 'string')
        text = quoted[1].trim();
    // ③ 去掉开头的「消息：」「回复：」等元信息
    text = text.replace(/^\s*(?:消息|回复|正文|内容)\s*[：:]\s*/u, '');
    // ④ 压掉多余空白（含首尾）
    text = text.replace(/\s+/gu, ' ').trim();
    return text;
}
/** 时段 id → 中文标签（供 prompt 里显示「现在是下午」）。 */
export const LIFE_STREAM_SLOT_LABELS = {
    late_night: '凌晨',
    morning: '早上',
    afternoon: '下午',
    evening: '晚上',
};
/** 取时段中文标签；未知 slot → 空串（调用方自行兜底）。 */
export function slotLabelOf(slotId) {
    const id = String(slotId ?? '').trim();
    return LIFE_STREAM_SLOT_LABELS[id] ?? '';
}
