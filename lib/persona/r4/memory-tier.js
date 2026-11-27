/**
 * memory-tier — 冷热记忆分区（R9，2026-11-27）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 定位（Companion-AI 冷热记忆方案启发）：
 *
 *   记忆不能平铺 —— 人脑有热记忆（一直在想）、温记忆（线索唤起）、
 *   冷记忆（硬盘归档，线索触发才翻）。
 *
 * ── 与现有代码的分工（**不重复造轮子**）────────────────────────────────────
 *
 *   现有 semantic-index.js 已有 TIER（pinned/normal/ephemeral），
 *   现有 decay.js 已有时间衰减（computeStrength）。
 *
 *   本模块补的是**热度判定 + 渐进压缩提示**这两块缺口：
 *
 *     ① computeTier：根据「最近提及时间」判断记忆现在处于哪个热区
 *        （热=近期高频，温=近期低频，冷=久未提及）
 *     ② shouldCompress：判断是否该从「细节」折叠成「摘要」
 *        （渐进压缩，不是一刀切删）
 *
 * ── 设计铁律 ───────────────────────────────────────────────────────────────
 *
 *   ① 纯函数，不碰 IO
 *   ② 复用 TIER 语义，不新建存储
 *   ③ 只给「建议」，不直接删/改数据（调用方决定）
 *   ④ 时间阈值可配置，非法值回落默认
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** 热度档位（记忆热区）。 */
export const HEAT = Object.freeze({
  HOT: 'hot',       // 热记忆：一直在上下文
  WARM: 'warm',     // 温记忆：线索唤起
  COLD: 'cold',     // 冷记忆：硬盘归档，线索触发
});

/** 默认时间阈值（毫秒）。 */
export const TIER_DEFAULTS = Object.freeze({
  /** 多少天内算「热」。 */
  hotMs: 7 * 24 * 60 * 60 * 1000,
  /** 多少天内算「温」。 */
  warmMs: 30 * 24 * 60 * 60 * 1000,
  /** 超过多久算「冷」，建议归档。 */
  coldMs: 90 * 24 * 60 * 60 * 1000,
  /** 冷记忆的原文折叠成摘要的字符上限。 */
  summaryChars: 80,
});

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * 判断一条记忆当前属于哪个热区（纯函数）。
 *
 * @param {object} entry  { tier, mentionedAt, strength }
 * @param {number} now
 * @param {object} [cfg]
 * @returns {{heat:'hot'|'warm'|'cold', reason:string}}
 */
export function computeTier(entry, now = Date.now(), cfg = TIER_DEFAULTS) {
  const tier = String(entry?.tier ?? 'normal');
  const at = Number.isFinite(entry?.mentionedAt) ? Number(entry.mentionedAt) : now;
  const dt = Math.max(0, now - at);

  // pinned 永远是热记忆（偏好/生日/称呼，永不降）
  if (tier === 'pinned') {
    return { heat: HEAT.HOT, reason: 'pinned 永久热记忆' };
  }

  // ephemeral 天生是冷记忆（短句/一次性闲聊），快速冷却
  if (tier === 'ephemeral') {
    return { heat: HEAT.COLD, reason: 'ephemeral 天生冷记忆' };
  }

  // normal：按时间分热区
  const hotMs = num(cfg?.hotMs, TIER_DEFAULTS.hotMs);
  const warmMs = num(cfg?.warmMs, TIER_DEFAULTS.warmMs);

  if (dt <= hotMs) return { heat: HEAT.HOT, reason: '近期提及，热记忆' };
  if (dt <= warmMs) return { heat: HEAT.WARM, reason: '近期低频，温记忆' };
  return { heat: HEAT.COLD, reason: '久未提及，冷记忆' };
}

/**
 * 判断一条记忆是否该「渐进压缩」（折叠成摘要，纯函数）。
 *
 * 渐进压缩（不是删除）：
 *   热 → 温：不动
 *   温 → 冷：建议压缩成一句话摘要
 *   冷 → 更久：建议归档（只留索引，原文留底 msg-archive）
 *
 * @param {object} entry  { tier, mentionedAt, body }
 * @param {number} now
 * @param {object} [cfg]
 * @returns {{compress:boolean, archive:boolean, reason:string}}
 */
export function shouldCompress(entry, now = Date.now(), cfg = TIER_DEFAULTS) {
  const tier = String(entry?.tier ?? 'normal');
  const at = Number.isFinite(entry?.mentionedAt) ? Number(entry.mentionedAt) : now;
  const dt = Math.max(0, now - at);

  // pinned 永不压缩（偏好不能折叠，会记错）
  if (tier === 'pinned') {
    return { compress: false, archive: false, reason: 'pinned 永不压缩' };
  }

  const warmMs = num(cfg?.warmMs, TIER_DEFAULTS.warmMs);
  const coldMs = num(cfg?.coldMs, TIER_DEFAULTS.coldMs);

  // 超过 coldMs：建议归档
  if (dt >= coldMs) {
    return { compress: true, archive: true, reason: '超冷记忆，建议归档' };
  }
  // 超过 warmMs：建议压缩成摘要
  if (dt >= warmMs) {
    return { compress: true, archive: false, reason: '温转冷，建议折叠成摘要' };
  }
  return { compress: false, archive: false, reason: '仍温热，无需压缩' };
}

/**
 * 把一条记忆折叠成摘要（纯函数，不删原文，只生成摘要文本）。
 *
 * ⚠️ 这不是删除 —— 原文永远在 msg-archive 留底。
 * 这里只生成「该保留在索引里的短摘要」，调用方决定写哪。
 *
 * @param {string} body 记忆原文
 * @param {object} [cfg]
 * @returns {string} 摘要文本（截断到 summaryChars）
 */
export function summarizeBody(body, cfg = TIER_DEFAULTS) {
  const t = String(body ?? '')
    .split('\n')
    .map((x) => x.replace(/^[-*\s>#]+/, '').trim())
    .filter(Boolean)
    .join('；');
  const cap = Math.max(20, num(cfg?.summaryChars, TIER_DEFAULTS.summaryChars));
  return t.length <= cap ? t : t.slice(0, cap) + '…';
}

/**
 * 批量给一组记忆分热区（纯函数，供展示/统计用）。
 *
 * @param {Array<object>} entries
 * @param {number} now
 * @param {object} [cfg]
 * @returns {{hot:number, warm:number, cold:number, total:number, byId:Map<string,object>}}
 */
export function classifyAll(entries, now = Date.now(), cfg = TIER_DEFAULTS) {
  const list = Array.isArray(entries) ? entries : [];
  const out = { hot: 0, warm: 0, cold: 0, total: list.length, byId: new Map() };
  for (const e of list) {
    const r = computeTier(e, now, cfg);
    out[r.heat] += 1;
    out.byId.set(String(e?.id ?? ''), r);
  }
  return out;
}

export default {
  HEAT, TIER_DEFAULTS,
  computeTier, shouldCompress, summarizeBody, classifyAll,
};
