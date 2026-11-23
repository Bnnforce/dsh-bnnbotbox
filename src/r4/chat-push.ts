/**
 * chat-push — F4 对话推进 / F5 作息仪式（R4.3）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 阶段 D：**实现**（填充阶段 A 的骨架；`pushHint` / `ritualHint` 签名未变）。
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 这两个功能都属于「调味料」，最大的风险是**变成固定台词打卡机器人**。
 * 所以设计上强制四件事：
 *   ① 文案池（多条不同措辞）+ `phrase-cooldown` **3 天**不重复；
 *   ② 严格触发条件（连续轮数 / 当天首次末次 / 时段）；
 *   ③ 只返回一句 **≤30 字** 的软提示：**绝不额外发消息、绝不抢主线内容**；
 *   ④ 入参畸形 / 读盘损坏 / random 抛错等**任何异常一律返回空串**，绝不抛给调用方。
 *
 * —— F4 对话推进（pushHint，追加到输出纪律）——
 *   · 上一次回复已经以问句结尾 → 不追加（本轮不重复追问）
 *   · 连续轮数 = 0 → 不追加（刚开始聊，不急着追问）
 *   · 动态概率：1 轮 60% / 2 轮 40% / >=3 轮不追加（越聊越不需要提醒）
 *   · 命中概率后，从文案池里挑一条**不在冷却中**的，挑到后才 `markUsed`
 *
 * —— F5 作息仪式（ritualHint，追加到时间块）——
 *   · 深夜（`hour === 0 || hour === 1`）且是当天**最后一次**回复 → 困意句
 *   · 清晨（06:00-08:59）且是当天**第一次**回复 → 刚醒句
 *   · 其它时段 → 不追加
 *   · 冷却 key 定稿为 `ritual:night:{文案}` / `ritual:morning:{文案}`（3 天）
 *
 * 安全边界：本文件**不新增定时器、不调用 LLM**；唯一副作用是 `markUsed` 写冷却表，
 * 且 `phrase-cooldown` 自身已保证「读损坏 → 空表、写失败 → 静默」。
 */

import { markUsed, pickUnused } from './phrase-cooldown.js';

/** 同一句文案的冷却天数（R4.3 定稿）。 */
const COOLDOWN_DAYS = 3;

/** 单段提示的硬上限（定稿 ≤30 字）：超了宁可不注入，也**不截半句**。 */
const MAX_HINT_CHARS = 30;

/**
 * F4 文案池（≥5 条不同措辞）。
 *
 * 内容只做三件事：允许「顺口反问一句」、给点具体的问法、提醒别变成客服腔。
 * 措辞刻意不统一（有的提「后来呢」、有的提「你怎么看」），避免模型把提示当固定台词照抄。
 */
export const PUSH_PHRASES: readonly string[] = [
  '[推进] 自然的话可顺口反问一句（问 ta 呢/后来呢）',
  '[推进] 别答完就停，可以反问 ta 怎么想',
  '[推进] 顺着话头问一句，把话递回给 ta',
  '[推进] 想接话就抛个小问题回去（你呢/后来呢）',
  '[推进] 也可以问问 ta 的版本（你怎么看）',
  '[推进] 本轮若自然可反问一句，别每轮都问',
];

/** F5 困意文案池（≥4 条，深夜用）。 */
export const NIGHT_PHRASES: readonly string[] = [
  '[作息] 已经很晚了，说话慢一点、带点困意',
  '[作息] 困得差不多了，回得短一点、别太精神',
  '[作息] 这个点该犯困了，语气软一点',
  '[作息] 夜深了，带点困意，别硬撑',
  '[作息] 快睡觉了，说话可以含糊、慢半拍',
];

/** F5 刚醒文案池（≥4 条，清晨用）。 */
export const MORNING_PHRASES: readonly string[] = [
  '[作息] 刚醒不久，语气松软一点、别太利索',
  '[作息] 早上刚睁眼，带点起床迷糊',
  '[作息] 刚睡醒，话可以短、带点慵懒',
  '[作息] 清早刚起，慢慢来就好',
  '[作息] 一觉醒来没多久，语气还带点软',
];

/** 仪式文案冷却 key 前缀（定稿：`ritual:night:{文案}` / `ritual:morning:{文案}`）。 */
const NIGHT_PREFIX = 'ritual:night:';
const MORNING_PREFIX = 'ritual:morning:';

/** 按码点数长度（中文一个字算 1，避免 `str.length` 把非 BMP 字符算成 2）。 */
function hintLen(text: string): number {
  return [...text].length;
}

/** 取随机源：缺失/非函数 → `Math.random`；便于测试注入确定值。 */
function randomOf(input: { random?: () => number }): () => number {
  return typeof input.random === 'function' ? input.random : Math.random;
}

/** 一段文案是否可用：非空且不超长（**不截断** —— 超长直接不注入）。 */
function usable(text: unknown): text is string {
  return typeof text === 'string' && text.length > 0 && hintLen(text) <= MAX_HINT_CHARS;
}

/**
 * 仪式取句：用**带前缀的 key** 参与冷却（定稿 key 形状），返回时剥掉前缀。
 *
 * 为什么不直接拿文案去冷却：`pickUnused` 的过滤键就是候选本身，
 * 而仪式要求 key 带 `ritual:night:` / `ritual:morning:` 前缀，
 * 所以传给 `pickUnused` 的候选必须是 key；展示给模型的永远是剥掉前缀的纯文案。
 */
function takeRitual(
  prefix: string,
  pool: readonly string[],
  root: string,
  now: number,
  random: () => number,
): string {
  const keyed = pool.map((phrase) => `${prefix}${phrase}`);
  const pickedKey = pickUnused(keyed, COOLDOWN_DAYS, root, now, random);
  if (!pickedKey || !pickedKey.startsWith(prefix)) return '';
  const phrase = pickedKey.slice(prefix.length);
  if (!usable(phrase)) return '';
  markUsed(pickedKey, root, now);
  return phrase;
}

export interface PushInput {
  root: string;
  now: number;
  /** 上一次回复是否以问句结尾（由调用方用 reply-detect 算出）。 */
  lastWasQuestion: boolean;
  /** 本会话连续对话轮数。 */
  consecutiveTurns: number;
  random?: () => number;
}

/**
 * F4：对话推进提示。
 * @returns 追加到【输出纪律】段尾的一句；空串 = 本轮不追加
 */
export function pushHint(input: PushInput): string {
  try {
    if (!input) return '';
    const { root, now } = input;
    // 入参体检：路径/时间戳非法时直接放弃（不读盘、不写盘）。
    if (typeof root !== 'string' || !root) return '';
    if (typeof now !== 'number' || !Number.isFinite(now)) return '';
    // 上一轮已经问过 → 本轮闭嘴（这条是「不像打卡机器人」的关键）。
    if (input.lastWasQuestion === true) return '';

    const turns = input.consecutiveTurns;
    if (typeof turns !== 'number' || !Number.isFinite(turns) || turns < 1) return '';

    // 动态概率：越往后越不需要提醒；>=3 轮完全不管。
    let probability: number;
    if (turns === 1) probability = 0.6;
    else if (turns === 2) probability = 0.4;
    else return '';

    const random = randomOf(input);
    const roll = random();
    // 随机源给出非法值（NaN / 非数字）→ 当没抽中（fail-closed）。
    if (typeof roll !== 'number' || !(roll < probability)) return '';

    const picked = pickUnused([...PUSH_PHRASES], COOLDOWN_DAYS, root, now, random);
    if (!usable(picked)) return '';
    markUsed(picked, root, now);
    return picked;
  } catch {
    // 红线：绝不抛到调用方（最多这轮不追加）。
    return '';
  }
}

export interface RitualInput {
  root: string;
  groupId: string;
  now: number;
  /** 当天是否第一次回复 / 最后一次回复（由调用方按 ritual-state 判定）。 */
  isFirstToday: boolean;
  isLastToday: boolean;
  /** 当前小时（0-23，Asia/Shanghai）。 */
  hour: number;
  random?: () => number;
}

/**
 * F5：作息仪式提示。
 * @returns 追加到时间块尾部的一句；空串 = 本轮不追加
 *
 * `groupId` 语义上保留：仪式文案是**通用语气修饰**，冷却表不分群/分人
 * （见 `phrase-cooldown` 设计），因此这里不参与挑句，仅保留给未来按群灰度用。
 */
export function ritualHint(input: RitualInput): string {
  try {
    if (!input) return '';
    const { root, now, hour } = input;
    if (typeof root !== 'string' || !root) return '';
    if (typeof now !== 'number' || !Number.isFinite(now)) return '';
    if (typeof hour !== 'number' || !Number.isFinite(hour)) return '';

    const random = randomOf(input);

    // 深夜：定稿按小时判定 0/1 点，且必须是当天最后一次回复。
    if ((hour === 0 || hour === 1) && input.isLastToday === true) {
      return takeRitual(NIGHT_PREFIX, NIGHT_PHRASES, root, now, random);
    }
    // 清晨：06:00-08:59，且必须是当天第一次回复。
    if (hour >= 6 && hour < 9 && input.isFirstToday === true) {
      return takeRitual(MORNING_PREFIX, MORNING_PHRASES, root, now, random);
    }
    return '';
  } catch {
    return '';
  }
}
