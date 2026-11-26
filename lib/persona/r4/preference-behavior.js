/**
 * preference-behavior — 偏好 → 行为参数映射（R8 S8 任务 2，2026-11-26）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么需要这个模块：
 *
 *   现状（实测）：记忆沉淀能抽出「群里讨厌长篇大论」这类事实，
 *   但它**躺在文件里，不影响任何行为** —— 学到了等于没学。
 *
 *   本模块建立「学到的偏好 → 可执行的行为参数」的映射。
 *
 * ── 设计铁律 ───────────────────────────────────────────────────────────────
 *
 *   ① **纯函数**：输入 preferences.json，输出行为参数，无 IO、无副作用
 *   ② **不改人格**：只调「表现参数」，不碰性格/身份/价值观
 *   ③ **有边界**：每个参数都有 min/max，偏好再极端也不会越界
 *   ④ **可回退**：没有偏好文件 → 返回全默认值，行为与现在完全一致
 *
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** 行为参数的默认值（= 没有偏好时的行为，与现状一致）。 */
export const DEFAULT_BEHAVIOR = Object.freeze({
  /** 回复长度倾向：0=极简，1=详尽 */
  replyLength: 0.5,
  /** 表情使用频率：0=从不，1=每句都带 */
  emojiRate: 0.5,
  /** 深夜（22:00-06:00）的随意程度：0=保持正式，1=完全放飞 */
  nightCasual: 0.5,
  /** 称呼倾向：0=用全名，1=用最短简称 */
  nameShortness: 0.5,
  /** 提问倾向：0=不主动问，1=爱追问 */
  questionTendency: 0.5,
  /** 主动说话频率系数（乘在配置的频率上）：0.5~1.5 */
  proactiveFactor: 1.0,
});

/** 每个参数的合法范围（防越界）。 */
export const BEHAVIOR_BOUNDS = Object.freeze({
  replyLength: [0, 1],
  emojiRate: [0, 1],
  nightCasual: [0, 1],
  nameShortness: [0, 1],
  questionTendency: [0, 1],
  proactiveFactor: [0.5, 1.5],
});

/**
 * 偏好类型定义：每种偏好如何影响行为参数。
 *
 * 结构：
 *   id       偏好 id
 *   detect   从 preferences 里判断是否命中（纯函数）
 *   effect   命中后对行为参数的增量
 *   reason   人话说明（用于提案/日志）
 */
export const PREFERENCE_RULES = Object.freeze([
  {
    id: 'dislike-long',
    reason: '群里不喜欢长篇大论',
    detect: (p) => p?.dislikeLong === true || Number(p?.avgReplyPreference) < 0.35,
    effect: { replyLength: -0.25 },
  },
  {
    id: 'like-detailed',
    reason: '喜欢她讲得细一点',
    detect: (p) => p?.likeDetailed === true,
    effect: { replyLength: +0.2 },
  },
  {
    id: 'emoji-lover',
    reason: '群里爱用表情',
    detect: (p) => p?.emojiLover === true || Number(p?.groupEmojiRate) > 0.3,
    effect: { emojiRate: +0.25 },
  },
  {
    id: 'emoji-averse',
    reason: '群里很少用表情',
    detect: (p) => p?.emojiAverse === true || Number(p?.groupEmojiRate) < 0.05,
    effect: { emojiRate: -0.2 },
  },
  {
    id: 'night-owl',
    reason: '这个群深夜才活跃',
    detect: (p) => p?.nightOwl === true || Number(p?.nightActiveRatio) > 0.3,
    effect: { nightCasual: +0.3 },
  },
  {
    id: 'prefer-short-name',
    reason: '大家习惯用简称',
    detect: (p) => p?.preferShortName === true,
    effect: { nameShortness: +0.3 },
  },
  {
    id: 'like-questions',
    reason: '群友喜欢被追问',
    detect: (p) => p?.likeQuestions === true,
    effect: { questionTendency: +0.2 },
  },
  {
    id: 'quiet-group',
    reason: '这个群比较安静',
    detect: (p) => Number(p?.dailyAvgMessages) > 0 && Number(p?.dailyAvgMessages) < 20,
    effect: { proactiveFactor: +0.2 },
  },
  {
    id: 'busy-group',
    reason: '这个群很热闹',
    detect: (p) => Number(p?.dailyAvgMessages) > 150,
    effect: { proactiveFactor: -0.2 },
  },
]);

/** 把值夹到合法范围。 */
function clamp(key, v) {
  const [lo, hi] = BEHAVIOR_BOUNDS[key] ?? [0, 1];
  const n = Number(v);
  if (!Number.isFinite(n)) return DEFAULT_BEHAVIOR[key];
  return Math.min(hi, Math.max(lo, n));
}

/**
 * 从偏好计算行为参数（纯函数）。
 *
 * @param {object} preferences 偏好对象（可为空/缺字段）
 * @returns {{behavior:object, applied:Array<{id:string, reason:string, effect:object}>}}
 */
export function resolveBehavior(preferences) {
  const p = preferences && typeof preferences === 'object' ? preferences : {};

  // 从默认值出发
  const behavior = { ...DEFAULT_BEHAVIOR };
  const applied = [];

  for (const rule of PREFERENCE_RULES) {
    let hit = false;
    try { hit = rule.detect(p) === true; } catch { hit = false; }
    if (!hit) continue;

    applied.push({ id: rule.id, reason: rule.reason, effect: rule.effect });
    for (const [k, delta] of Object.entries(rule.effect)) {
      if (!(k in behavior)) continue;
      behavior[k] = (Number(behavior[k]) || 0) + Number(delta);
    }
  }

  // 统一夹范围（防叠加越界）
  for (const k of Object.keys(behavior)) behavior[k] = clamp(k, behavior[k]);

  return { behavior, applied };
}

/**
 * 把行为参数翻译成「给模型的提示」（纯函数）。
 *
 * 只在参数**明显偏离默认**时才输出提示，避免每轮废话。
 *
 * @param {object} behavior resolveBehavior 的 behavior
 * @returns {string} 空串表示无需提示
 */
export function renderBehaviorHint(behavior) {
  const b = behavior && typeof behavior === 'object' ? behavior : DEFAULT_BEHAVIOR;
  const parts = [];

  // 回复长度
  const len = Number(b.replyLength);
  if (Number.isFinite(len)) {
    // ★ 2026-11-26：边界用 >= 而非 >
    //   默认 0.5 + likeDetailed 的 +0.2 = 0.7，用 > 会刚好卡在阈值外不提示。
    if (len < 0.3) parts.push('说短点');
    else if (len >= 0.7) parts.push('可以多讲两句');
  }
  // 表情
  const emo = Number(b.emojiRate);
  if (Number.isFinite(emo)) {
    if (emo < 0.25) parts.push('少用表情');
    else if (emo >= 0.7) parts.push('表情随意点');
  }
  // 提问
  const q = Number(b.questionTendency);
  if (Number.isFinite(q) && q >= 0.7) parts.push('可以多问一句');

  return parts.length ? parts.join('，') : '';
}

/**
 * 生成「行为参数 → 人话」的说明（给提案/诊断用）。
 *
 * @param {object} behavior
 * @returns {Array<{key:string, value:number, label:string}>}
 */
export function describeBehavior(behavior) {
  const b = behavior && typeof behavior === 'object' ? behavior : DEFAULT_BEHAVIOR;
  const LABELS = {
    replyLength: '回复长度',
    emojiRate: '表情频率',
    nightCasual: '深夜随意度',
    nameShortness: '称呼简称度',
    questionTendency: '提问倾向',
    proactiveFactor: '主动频率',
  };
  return Object.entries(LABELS).map(([key, label]) => ({
    key, label, value: Number(b[key]) || 0,
  }));
}

export default {
  DEFAULT_BEHAVIOR, BEHAVIOR_BOUNDS, PREFERENCE_RULES,
  resolveBehavior, renderBehaviorHint, describeBehavior,
};
