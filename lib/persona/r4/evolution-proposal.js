/**
 * evolution-proposal — 自我进化 B 档（建议式）（R8 S8 任务 3，2026-11-26）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 这一档做什么：
 *
 *   她**可以想改自己**，但只能**提建议**，不能自己动手。
 *   提案交给主人，主人一句话决定采纳与否。
 *
 * ── 三条铁律 ───────────────────────────────────────────────────────────────
 *
 *   ① **决策靠算法，不靠 LLM**
 *      调不调、调多少，全部是可计算的偏差；LLM 只负责把结论说人话。
 *      原因：让 LLM 决定「我该变成什么样」= 不可预测、不可复现、无法审计。
 *
 *   ② **绝不自动写人格文件**
 *      本模块只产出「提案对象」，写入由主人确认后的独立流程负责。
 *      函数签名里没有任何 write/fs 调用 —— 可静态验证。
 *
 *   ③ **白名单 + 护栏**
 *      只有白名单内的项可以提；每项都有幅度上限、频率限制、漂移上限。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 */

/**
 * 白名单：允许提建议的项。
 *
 * ⚠️ 不在这个列表里的项，**永远不能**出现在提案里（有测试断言）。
 */
export const WHITELIST = Object.freeze([
  { key: 'replyLength', label: '回复长度倾向', unit: '' },
  { key: 'emojiRate', label: '表情使用频率', unit: '' },
  { key: 'verbalTic', label: '语气词偏好', unit: '' },
  { key: 'catchphrase', label: '口头禅', unit: '' },
  { key: 'proactiveFactor', label: '主动说话频率', unit: '×' },
]);

/** 黑名单：绝对不允许提的（用于显式断言，防将来误加）。 */
export const BLACKLIST = Object.freeze([
  'name', 'identity', 'persona', 'personality', 'coreTrait',
  'relationToOwner', 'values', 'bottomLine', 'roleCard',
]);

/** 护栏参数。 */
export const GUARDS = Object.freeze({
  /** 单次最大调整幅度（相对当前值）。 */
  maxDeltaPerChange: 0.2,
  /** 两次提案的最小间隔（毫秒）：7 天。 */
  minIntervalMs: 7 * 24 * 3600 * 1000,
  /** 相对初始值的累积漂移上限。 */
  maxCumulativeDrift: 0.3,
  /** 一次提案最多包含几项。 */
  maxItemsPerProposal: 2,
});

/** 各项的合法范围。 */
export const BOUNDS = Object.freeze({
  replyLength: [0, 1],
  emojiRate: [0, 1],
  proactiveFactor: [0.5, 1.5],
});

/** 触发建议的偏差阈值（低于此不提）。 */
export const TRIGGER = Object.freeze({
  /** 指标偏离「期望值」多少才提。 */
  styleDeviation: 0.15,
  /** 至少需要几条快照才敢提（数据不足不提）。 */
  minSnapshots: 3,
});

function clamp(v, lo, hi) {
  const n = Number(v);
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

/** 是否在白名单内。 */
export function isWhitelisted(key) {
  return WHITELIST.some((w) => w.key === key);
}

/** 是否在黑名单内。 */
export function isBlacklisted(key) {
  return BLACKLIST.includes(String(key ?? ''));
}

/**
 * 从 metrics 快照算「风格偏差」（纯算法）。
 *
 * @param {Array<object>} snapshots metrics.jsonl 的历史快照
 * @returns {{avgLen:number, questionRate:number, emojiRate:number, samples:number}}
 */
export function styleTrend(snapshots) {
  const list = (Array.isArray(snapshots) ? snapshots : []).filter((s) => s && s.style);
  if (!list.length) return { avgLen: 0, questionRate: 0, emojiRate: 0, samples: 0 };

  const n = list.length;
  const sum = (k) => list.reduce((a, s) => a + (Number(s.style?.[k]) || 0), 0) / n;
  return {
    avgLen: round2(sum('avgLen')),
    questionRate: round3(sum('questionRate')),
    emojiRate: round3(sum('emojiRate')),
    samples: Number(list[n - 1]?.style?.samples) || 0,
  };
}

/**
 * 算趋势方向（最近 1/3 与最早 1/3 的对比）。
 *
 * @param {Array<object>} snapshots
 * @returns {{avgLen:number, questionRate:number, emojiRate:number, samples:number}}
 */
export function styleDelta(snapshots) {
  const list = (Array.isArray(snapshots) ? snapshots : []).filter((s) => s && s.style);
  if (list.length < TRIGGER.minSnapshots) {
    return { avgLen: 0, questionRate: 0, emojiRate: 0, samples: list.length, enough: false };
  }
  const third = Math.max(1, Math.floor(list.length / 3));
  const early = list.slice(0, third);
  const late = list.slice(-third);
  const mean = (arr, k) => arr.reduce((a, s) => a + (Number(s.style?.[k]) || 0), 0) / arr.length;

  return {
    avgLen: round2(mean(late, 'avgLen') - mean(early, 'avgLen')),
    questionRate: round3(mean(late, 'questionRate') - mean(early, 'questionRate')),
    emojiRate: round3(mean(late, 'emojiRate') - mean(early, 'emojiRate')),
    samples: list.length,
    enough: true,
  };
}

/**
 * 生成进化提案（**纯函数，不写任何文件**）。
 *
 * @param {object} input
 * @param {Array<object>} [input.snapshots]  metrics 历史
 * @param {object} [input.current]            当前行为参数
 * @param {object} [input.baseline]           初始行为参数（算累积漂移）
 * @param {number} [input.lastProposalAt]     上次提案时间
 * @param {number} [input.now]                当前时间
 * @returns {{ok:boolean, reason?:string, proposal?:object}}
 */
export function buildProposal(input = {}) {
  const snapshots = Array.isArray(input.snapshots) ? input.snapshots : [];
  const current = input.current && typeof input.current === 'object' ? input.current : {};
  const baseline = input.baseline && typeof input.baseline === 'object' ? input.baseline : {};
  const now = Number(input.now) || Date.now();

  // ① 数据不足 → 不提
  const delta = styleDelta(snapshots);
  if (!delta.enough) {
    return { ok: false, reason: '数据不足（至少需要 ' + TRIGGER.minSnapshots + ' 条快照）' };
  }

  // ② 频率护栏：距上次提案不足 7 天 → 不提
  const lastAt = Number(input.lastProposalAt) || 0;
  if (lastAt > 0 && now - lastAt < GUARDS.minIntervalMs) {
    const days = Math.ceil((GUARDS.minIntervalMs - (now - lastAt)) / 86400000);
    return { ok: false, reason: `距上次提案不足 7 天（还有 ${days} 天）` };
  }

  // ③ 纯算法判断：哪些项需要调
  const items = [];

  // 3.1 回复长度：如果她最近越来越长，建议缩短
  if (Math.abs(delta.avgLen) > 8) {
    const cur = Number(current.replyLength) || 0.5;
    const dir = delta.avgLen > 0 ? -1 : +1;   // 变长了就缩短
    const target = clamp(cur + dir * GUARDS.maxDeltaPerChange, 0, 1);
    items.push({
      key: 'replyLength',
      label: '回复长度倾向',
      from: round3(cur),
      to: round3(target),
      why: delta.avgLen > 0
        ? `最近平均句长 ${delta.avgLen > 0 ? '+' : ''}${delta.avgLen} 字，有点长了`
        : `最近平均句长 ${delta.avgLen} 字，可以多说一点`,
    });
  }

  // 3.2 表情频率：偏离明显就调
  if (Math.abs(delta.emojiRate) > TRIGGER.styleDeviation) {
    const cur = Number(current.emojiRate) || 0.5;
    const dir = delta.emojiRate > 0 ? +1 : -1;
    const target = clamp(cur + dir * GUARDS.maxDeltaPerChange, 0, 1);
    items.push({
      key: 'emojiRate',
      label: '表情使用频率',
      from: round3(cur),
      to: round3(target),
      why: `表情使用率变化 ${delta.emojiRate > 0 ? '+' : ''}${delta.emojiRate}`,
    });
  }

  // ④ 累积漂移护栏
  const driftCheck = checkDrift(items, baseline);
  if (!driftCheck.ok) {
    return { ok: false, reason: driftCheck.reason };
  }

  // ⑤ 没有可提的 → 不打扰
  if (!items.length) {
    return { ok: false, reason: '状态稳定，没有需要调整的项' };
  }

  // ⑥ 白名单过滤 + 数量上限（双保险）
  const safeItems = items
    .filter((it) => isWhitelisted(it.key) && !isBlacklisted(it.key))
    .slice(0, GUARDS.maxItemsPerProposal);

  if (!safeItems.length) {
    return { ok: false, reason: '没有可提的项（白名单外）' };
  }

  return {
    ok: true,
    proposal: {
      at: now,
      items: safeItems,
      /** 人读的提案正文（LLM 可在此基础上润色，但不改结论） */
      summary: renderProposal(safeItems),
      /** 明确标注：这是建议，不是已生效 */
      pending: true,
      requiresOwnerConfirm: true,
    },
  };
}

/**
 * 累积漂移检查：相对初始值，总漂移不能超过上限。
 *
 * @param {Array<object>} items 提案项
 * @param {object} baseline 初始值
 * @returns {{ok:boolean, reason?:string}}
 */
export function checkDrift(items, baseline) {
  const list = Array.isArray(items) ? items : [];
  const base = baseline && typeof baseline === 'object' ? baseline : {};

  for (const it of list) {
    const b = Number(base[it.key]);
    if (!Number.isFinite(b)) continue;   // 没基线就不判
    const drift = Math.abs(Number(it.to) - b);
    if (drift > GUARDS.maxCumulativeDrift) {
      return {
        ok: false,
        reason: `${it.label}相对初始值漂移 ${round2(drift)}，超过上限 ${GUARDS.maxCumulativeDrift}`,
      };
    }
  }
  return { ok: true };
}

/**
 * 渲染提案正文（人话）。
 *
 * @param {Array<object>} items
 * @returns {string}
 */
export function renderProposal(items) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return '';
  const lines = ['我想稍微调整一下自己：'];
  for (const it of list) {
    lines.push(`· ${it.label}：${it.from} → ${it.to}`);
    lines.push(`  （${it.why}）`);
  }
  lines.push('');
  lines.push('你同意的话我就改，不同意就当没说。');
  return lines.join('\n');
}

function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
function round3(n) { return Math.round((Number(n) || 0) * 1000) / 1000; }

export default {
  WHITELIST, BLACKLIST, GUARDS, BOUNDS, TRIGGER,
  isWhitelisted, isBlacklisted, styleTrend, styleDelta,
  buildProposal, checkDrift, renderProposal,
};
