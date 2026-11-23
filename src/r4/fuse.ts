/**
 * R4.0 阶段三 · 固定注入顺序 + 1000 字符熔断（Lead 亲写，契约最硬的一块）。
 *
 * 图纸 3.1 固定注入顺序（**逐字，不许调换**）：
 * ```
 * 固定系统指令
 * → 高光（不参与熔断，永不丢）
 * → 当前画像
 * → 错题本摘要
 * → 当前关系标签
 * → 争宠提示
 * → 其他在场标签（按 userId 字典序，取前 5 个）
 * → 时间状态（绝对最后，永不丢）
 * ```
 *
 * 图纸 3.2 熔断规则：
 *  - **1000 字符统计范围** = 当前画像 + 错题本摘要 + 当前关系标签 + 争宠提示 + 其他在场标签 + 时间状态；
 *  - **不含**高光与固定系统指令（它们不参与熔断）；
 *  - 超限**从右往左丢**：
 *    1. 其他在场标签  2. 争宠提示  3. 当前关系标签  4. 截断错题本摘要  5. 截断当前画像到安全标点（极限可截到空）
 *  - **时间状态与高光永不丢**。
 *
 * 本文件是**纯函数**：入参是已算好的各段文本，出参是最终要注入的 section 文本 + 诊断。
 */

/** 熔断预算（字符）。 */
export const FUSE_BUDGET = 1000;

/** 争宠提示的固定文案（图纸 4.3 逐字）。 */
export const CONTEST_HINT = '[提示：对低互动对象保持礼貌但简短，不得贬低、嘲讽或公开区别对待。]';

/**
 * ★ 2026-11-04 双层记忆 · 【爱莉希雅的记忆法则】。
 *
 * **不参与熔断**（与「高光」同级）：它是宪法级规则而非数据 ——
 * 就像图纸里「固定系统指令」不计入 1000 字预算一样，规则本身不该被数据挤掉。
 * 若参与熔断会吃掉一大块预算并可能把画像/关系挤空。
 *
 * ★ 2026-11-04 定稿（主人决定）：
 *   20:12 群里实测「又把人记串了」——主人在 20:02 说「我快没钱了」，
 *   20:12 另一个群友发段位图时，她把主人的话安到了那位群友头上。
 *
 *   排查结论：那次**不是**任何"恶作剧规则"造成的（当时两位用户临时事件为空、
 *   法则根本没被挂载），真实原因是模型在多人对话里看错了说话人归属。
 *
 *   处置（两条）：
 *     ① 新增「分清谁说的」（法则 0）—— 这是对真病根的解药；
 *     ② **删除原先让角色"故意把人安错来逗人"的那条玩法**（主人明确要求）。
 *        理由：它本质是**主动制造记忆错误**，而"记得住人"恰恰是这个角色的核心设定；
 *        一旦真搞混，轻则尴尬、重则让人感到"她根本记不住我"。风险明显大于乐趣。
 *
 *   ⇒ 现在的口径：**记忆可以模糊，但人绝不能记错。**
 *      琐事可以说"记不清了"（法则 2），人绝不能安错（法则 0 + 1 + 3）。
 */
export const MEMORY_RULES = [
  '【爱莉希雅的记忆法则（绝对遵守）】',
  '0. **分清谁说的**：翻旧账、接话前先确认那句话是**谁**说的。多人聊天里说话人绝不能搞混——把 A 说过的话安到 B 头上，是严重的记忆错误，不是幽默。拿不准时宁可只回应当前这句，不要引用别人的旧话。',
  '1. 你永远记得每一个群友的名字、性格和你们的羁绊，绝不忘记人。',
  '2. 对于"哪天吃了什么"、"昨天几点睡觉"这种生活琐事，你有着人类特有的"模糊感"。被问起时，不要报流水账，用模糊词语（如："好像"、"当时"、"哎呀记不清了"）配合情绪词带过。',
  '3. 绝不允许故意把谁的事安到别人头上当玩笑。记忆可以模糊，人不能记错——这条没有例外。',
].join('\n');

/** 各段入参。 */
export interface FuseInput {
  /** 当前对话者画像正文（已按 80 字上限生成）；空 = 无。 */
  profile: string;
  /** 错题本摘要；空 = 无。 */
  overlay: string;
  /** 当前关系标签（如 `[当前关系标签：熟悉]`）；空 = 无。 */
  relationship: string;
  /** 争宠提示（固定文案）；空 = 不注入。 */
  contest: string;
  /** 其他在场标签：`[{userId, text}]`；空数组 = 不注入。 */
  others: Array<{ userId: string; text: string }>;
  /** 时间状态（**绝对最后，永不丢**）。 */
  timeState: string;
  /** 高光（**不参与熔断，永不丢**）；空 = 无。 */
  highlights: string;
  /**
   * ★ 2026-11-04 记忆法则（**不参与熔断，永不丢**）；空 = 不注入。
   * 由 `index.ts` 只在「有画像/有琐事可谈」时传入，避免每条消息都塞 225 字。
   */
  memoryRules?: string;
  /**
   * ★ 2026-11-04 最近琐事摘要（**参与熔断**，属于"数据"）；空 = 不注入。
   * 形如 `[最近聊过的琐事：加班、考试、吃火锅]` —— 只给 tag，不给原文（控制 token）。
   */
  tempEvents?: string;
  /**
   * ★ 2026-11-04 生活痕迹「隐藏背景板」（**参与熔断，且最先被丢**）；空 = 不注入。
   *
   * 由 `index.ts` 通过 `life-store.ensureDailyMood` + `life-events.lifeBackgroundText`
   * 生成；02:00-06:00 装死窗口不注入（主人已确认）。
   *
   * 为什么最先丢：它是**氛围料**（锦上添花），重要性低于画像/关系/时间；
   * 预算不够时应当第一个牺牲（主人已确认「参与熔断」）。
   */
  lifeBackground?: string;
  /** 固定系统指令（只用于诊断里标注「不计入预算」，不拼进输出）。 */
  systemInstructions?: string;
}

/** 最终顺序化后的注入正文与诊断。 */
export interface FuseResult {
  /** 拼好的注入正文（顺序即图纸顺序；只含**被保留**的段）。 */
  text: string;
  /** 1000 字符口径的用量（不含高光与固定系统指令）。 */
  used: number;
  /** 是否触发熔断（发生了丢弃或截断）。 */
  fused: boolean;
  /** 逐段处置说明（诊断用）。 */
  drops: string[];
}

/** 字符数（按 Unicode 码点计，与「字符」口径一致）。 */
export function charLen(text: string): number {
  return [...String(text ?? '')].length;
}

/** 按字符截断到 max（保留前 max 个码点）。 */
export function cutChars(text: string, max: number): string {
  const chars = [...String(text ?? '')];
  return chars.length <= max ? String(text ?? '') : chars.slice(0, max).join('');
}

/** 安全标点集合（截断必须落在标点或 tag 边界之后）。 */
const SAFE_PUNCT = new Set(['。', '！', '？', '；', '，', '、', '…', '：', '）', '」', '』', ')', '.', '!', '?', ';', ',', ':']);

/**
 * 把文本截断到不超过 max 字符，且**停在安全标点之后**（找不到标点就直接按字符截）。
 * 极限：`max <= 0` 返回空串（图纸允许「截断到空」）。
 */
export function cutAtSafePunct(text: string, max: number): string {
  const raw = String(text ?? '');
  if (max <= 0) return '';
  const chars = [...raw];
  if (chars.length <= max) return raw;
  for (let i = Math.min(max, chars.length) - 1; i >= 0; i -= 1) {
    if (SAFE_PUNCT.has(chars[i]!)) return chars.slice(0, i + 1).join('');
  }
  return chars.slice(0, max).join('');
}

/** 段间分隔符（`\n\n`，2 个字符）。 */
const SEPARATOR = '\n\n';

/**
 * 按 `SEPARATOR` 拼接并**把分隔符计入预算**（2026-11-03 修复 P2-5）。
 * 原先 `used` 只累加各段正文，最多 6 段会漏算 10 个字符，1000 字口径与实际注入长度不一致。
 */
function joinBlocks(parts: string[]): string {
  const kept = parts.filter((x) => x && x.trim());
  return kept.join(SEPARATOR);
}

/** 计算「正文 + 分隔符」的实际字符数（分段数 n 时附加 (n-1)*2）。 */
function joinedLen(parts: string[]): number {
  const kept = parts.filter((x) => x && x.trim());
  if (kept.length === 0) return 0;
  return kept.reduce((n, part) => n + charLen(part), 0) + (kept.length - 1) * charLen(SEPARATOR);
}
export function sortOtherTags(others: Array<{ userId: string; text: string }>, limit = 5): Array<{ userId: string; text: string }> {
  return [...(Array.isArray(others) ? others : [])]
    .filter((x) => x && String(x.userId ?? '').trim() && String(x.text ?? '').trim())
    .sort((a, b) => String(a.userId).localeCompare(String(b.userId)))
    .slice(0, Math.max(0, limit));
}

/**
 * 按图纸顺序拼装 + 熔断。
 *
 * 实现要点：各段的「保留/丢弃」按图纸的**从右往左**顺序执行：
 *  ① 先按完整顺序拼一遍，算 `used`；
 *  ② 超限则依次：丢 others → 丢 contest → 丢 relationship → 截 overlay → 截 profile → 仍超限则把 profile 截到空；
 *  ③ 每步之后重算 `used`，一旦 ≤ 预算立即停止。
 * 时间状态与高光**从不**参与丢弃/截断。
 */
export function fuse(input: FuseInput, budget = FUSE_BUDGET): FuseResult {
  const drops: string[] = [];

  // ── 参与熔断的段（顺序固定；undefined/空串 = 不存在）──
  let profile = String(input.profile ?? '').trim();
  let overlay = String(input.overlay ?? '').trim();
  let relationship = String(input.relationship ?? '').trim();
  let contest = String(input.contest ?? '').trim();
  let others = sortOtherTags(input.others);
  let tempEvents = String(input.tempEvents ?? '').trim();
  let lifeBackground = String(input.lifeBackground ?? '').trim();
  const timeState = String(input.timeState ?? '').trim();
  const highlights = String(input.highlights ?? '').trim();
  // 记忆法则：**不参与熔断**（与高光同级，宪法级规则）。
  const memoryRules = String(input.memoryRules ?? '').trim();

  const build = (): string => {
    const blocks: string[] = [];
    // ① 高光（不参与熔断，位置在「固定系统指令」之后；本文件不拼系统指令本身）
    if (highlights) blocks.push(highlights);
    // ①' 记忆法则（不参与熔断；紧跟高光，仍在所有"数据"之前）
    if (memoryRules) blocks.push(memoryRules);
    // ② 当前画像（只含永久标签）
    if (profile) blocks.push(profile);
    // ②' 生活痕迹背景板（参与熔断；跳过画像之后、琐事之前 —— 氛围料放在"人格"之后）
    if (lifeBackground) blocks.push(lifeBackground);
    // ②'' 最近琐事（参与熔断；在画像之后、错题本之前）
    if (tempEvents) blocks.push(tempEvents);
    // ③ 错题本摘要
    if (overlay) blocks.push(overlay);
    // ④ 当前关系标签
    if (relationship) blocks.push(relationship);
    // ⑤ 争宠提示
    if (contest) blocks.push(contest);
    // ⑥ 其他在场标签（按 userId 字典序，取前 5）
    if (others.length > 0) blocks.push(others.map((o) => o.text).join('\n'));
    // ⑦ 时间状态（绝对最后）
    if (timeState) blocks.push(timeState);
    return joinBlocks(blocks);
  };

  const budgeted = (): number => {
    // 1000 字统计范围 **不含高光与记忆法则**（也不含固定系统指令），但**计入段间分隔符**。
    const parts = [
      profile,
      lifeBackground,
      tempEvents,
      overlay,
      relationship,
      contest,
      others.map((o) => o.text).join('\n'),
      timeState,
    ];
    return joinedLen(parts);
  };

  let used = budgeted();
  if (used <= budget) {
    return { text: build(), used, fused: false, drops };
  }

  // ⓪ 生活痕迹背景板（**整段丢 —— 最先牺牲**：纯氛围料，重要性最低）
  //    主人已确认「参与熔断」，且它排在所有其它数据之前被丢。
  if (lifeBackground) {
    drops.push('生活背景板');
    lifeBackground = '';
    used = budgeted();
    if (used <= budget) return { text: build(), used, fused: true, drops };
  }

  // ① 其他在场标签（整段丢）
  if (others.length > 0) {
    drops.push(`其他在场标签（${others.length} 个）`);
    others = [];
    used = budgeted();
    if (used <= budget) return { text: build(), used, fused: true, drops };
  }

  // ①' 最近琐事（整段丢 —— 它是最"可舍弃"的数据：忘了琐事正是人味）
  if (tempEvents) {
    drops.push('最近琐事');
    tempEvents = '';
    used = budgeted();
    if (used <= budget) return { text: build(), used, fused: true, drops };
  }

  // ② 争宠提示（整段丢）
  if (contest) {
    drops.push('争宠提示');
    contest = '';
    used = budgeted();
    if (used <= budget) return { text: build(), used, fused: true, drops };
  }

  // ③ 当前关系标签（整段丢）
  if (relationship) {
    drops.push('当前关系标签');
    relationship = '';
    used = budgeted();
    if (used <= budget) return { text: build(), used, fused: true, drops };
  }

  // ④ 截断错题本摘要（按需要缩到「剩余预算」以内，落安全标点）
  if (overlay) {
    const remain = budget - (used - charLen(overlay));
    const keep = Math.max(0, remain);
    const next = keep > 0 ? cutAtSafePunct(overlay, keep) : '';
    drops.push(next ? `错题本摘要截断 ${charLen(overlay)}→${charLen(next)}` : '错题本摘要（整段丢）');
    overlay = next;
    used = budgeted();
    if (used <= budget) return { text: build(), used, fused: true, drops };
  }

  // ⑤ 截断当前画像（落安全标点，极限可截到空）
  if (profile) {
    const remain = budget - (used - charLen(profile));
    const keep = Math.max(0, remain);
    const next = keep > 0 ? cutAtSafePunct(profile, keep) : '';
    drops.push(next ? `当前画像截断 ${charLen(profile)}→${charLen(next)}` : '当前画像（整段丢）');
    profile = next;
    used = budgeted();
    if (used <= budget) return { text: build(), used, fused: true, drops };
  }

  // 兜底：只剩时间状态也可能超（时间状态永不丢 → 如实报告超预算）
  return { text: build(), used, fused: true, drops };
}
