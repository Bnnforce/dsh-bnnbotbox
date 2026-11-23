/**
 * R4.0 阶段三 · 注入编排（把各模块结果按图纸 3.1 顺序组装成系统提示段落）。
 *
 * 本文件**不直接读盘业务数据**（除了复用现成的 guideline/overlay/highlights 读取器），
 * 组装逻辑全部走 `fuse.ts`（纯函数，有单测覆盖）。
 */

import { fuse, charLen, CONTEST_HINT, MEMORY_RULES, sortOtherTags } from './fuse.js';
import type { Level, RelationshipLevels } from './types.js';

 /** 各段来源回调（index.ts 注入；全部允许失败 → 空串/空数组，绝不抛）。 */
export interface InjectSources {
  /** 当前对话者画像正文（模块三 `buildProfileText` 结果）。 */
  getProfile: (userId: string) => string;
  /** 错题本摘要（沿用 dsh-anti-ai-persona 2.5.0 的 overlay）。 */
  getOverlay: (groupId: string, persona: string) => string;
  /** 当前关系标签（`relationshipTag()` 结果）。 */
  getRelationshipTag: (groupId: string, userId: string, levels: RelationshipLevels) => string;
  /** 争宠提示（`shouldInjectContest` 为真时返回 `CONTEST_HINT`）。 */
  getContestHint: (groupId: string, userId: string) => string;
  /** 其他在场标签（按 userId 字典序取前 5）。 */
  getOtherTags: (groupId: string, userId: string) => Array<{ userId: string; text: string }>;
  /** 高光（沿用 2.5.0 highlights，**不参与熔断**）。 */
  getHighlights: () => string;
  /** 时间状态（模块一 `timeBlockText`，**绝对最后，永不丢**）。 */
  getTimeState: () => string;
  /**
   * ★ 2026-11-04 双层记忆 · 最近琐事摘要（**参与熔断**）。
   * 返回空串 = 本轮不注入（没有临时事件 / 没有画像 / 不需要记忆法则）。
   *
   * **触发条件（决策点 ③ 方案 A）**：本回调返回非空 ⇔ 注入记忆法则。
   * 判据（由 index.ts 实现）：该 user 有**近 7 天的临时事件** OR 已有画像。
   * 也就是说「有旧账可翻」时才挂法则，纯新用户/纯闲聊不挂，省 token。
   */
  getTempEvents?: (userId: string) => string;
  /**
   * ★ 2026-11-04 生活痕迹「隐藏背景板」（**参与熔断、最先被丢**）。
   * 返回空串 = 本轮不注入（装死窗口 / 配置关闭 / 抽卡失败）。
   * 由 `index.ts` 调 `life-store.ensureDailyMood` + `life-events.lifeBackgroundText` 实现。
   */
  getLifeBackground?: () => string;

  /**
   * ★ 2026-11-08 记忆联想（**独立预算，不挤占 EXTRA_BUDGET**）。
   *
   * 为什么要独立预算（三轮审查发现）：
   *   `EXTRA_BUDGET = 140` 字已被现有 4 段占满（实测 99 字），
   *   若记忆也走那个预算，**永远会被整段丢弃** → 功能静默失效。
   *   所以给它独立的 `MEMORY_RECALL_BUDGET`（220 字），拼接位置在 4 段**之前**。
   *
   * 返回空串 = 本轮不注入（服务未就绪 / 无相关记忆）。
   * 实现见 `index.ts` → `buildMemoryRecall`。
   */
  getMemoryRecall?: () => string;

  // ─────────────────────────────────────────────────────────────────────────
  // ★ 2026-11-05 R4.3：四个可选的「调味段落」。
  //
  // 设计决策（最安全优先）：
  //   · **完全不改 `fuse.ts`** —— 它是最稳的模块（116 checks），动它风险大于收益；
  //   · 这四段走**独立拼接 + 独立预算**（`EXTRA_BUDGET = 140` 字），
  //     拼接位置在 fuse 结果**之前**，保证「时间状态绝对最后」的既有约束不被破坏；
  //   · 全部可选：未传 / 返回空串 = 不注入，现有调用方零影响；
  //   · 超预算时按 **里程碑 > 推进 > 旧事 > 仪式** 顺序丢弃（仪式最短最不重要）。
  // ─────────────────────────────────────────────────────────────────────────

  /** F1 记忆关联：几天前说过的旧事（可接可不接）。 */
  getRecallHint?: (groupId: string, userId: string) => string;
  /** F3 关系里程碑：可引用的关系事实（不是等级播报）。 */
  getMilestoneHint?: (groupId: string, userId: string) => string;
  /** F4 对话推进：答完可自然反问。 */
  getPushHint?: (groupId: string, userId: string) => string;
  /** F5 作息仪式：深夜困意 / 清晨刚醒。 */
  getRitualHint?: (groupId: string, userId: string) => string;

  /**
   * ★ 2026-11-09 R4.1：新人识别（这个人刚来，别装熟）。
   *
   * 为什么**不**塞进上面那 140 字的 `EXTRA_BUDGET`：
   *   实测 4 段已占 99 字，只剩 41 字余量，而那段余量是给 4 段波动的缓冲。
   *   占满后按「里程碑 > 推进 > 旧事 > 仪式」丢弃 —— 新人识别优先级本来就低，
   *   挤进去等于「有老熟人特征时新人提示必被丢掉」。
   *   所以照记忆联想的先例走**独立预算** `NEWCOMER_BUDGET`。
   *
   * 返回空串 = 不是新人 / 功能关闭 → 不注入。
   */
  getNewcomerHint?: (groupId: string, userId: string) => string;

  /**
   * ★ 2026-11-16 P3：情绪底色（**独立预算 MOOD_TINT_BUDGET = 90 字**）。
   *
   * 为什么独立预算：`EXTRA_BUDGET`(140) 已被 4 段占满（实测 99 字），
   *   挤进去必然被整段丢弃 → 静默失效（与记忆联想同一个坑）。
   *
   * 返回空串 = 样本不足 / 中性 / 关闭 → 不注入。
   */
  getMoodTint?: () => string;
}

export interface InjectInput {
  groupId: string;
  userId: string;
  persona: string;
  levels: RelationshipLevels;
  sources: InjectSources;
  /**
   * ★ 2026-11-05 参数解耦：熔断预算（字符）。由 `config.inject_config.fuse_budget` 传入。
   * 缺省不传 → `fuse()` 内部回落 `FUSE_BUDGET`（1000，与旧行为一致）。
   */
  fuseBudget?: number;
}

export interface InjectOutput {
  /** 注入正文（含高光，顺序符合图纸 3.1）。 */
  text: string;
  /** 1000 字口径用量（不含高光）。 */
  used: number;
  fused: boolean;
  drops: string[];
  /** 逐段是否在场（诊断用；便于测试断言「某段被丢」）。 */
  present: {
    highlights: boolean;
    profile: boolean;
    overlay: boolean;
    relationship: boolean;
    contest: boolean;
    others: number;
    timeState: boolean;
    /** ★ 2026-11-04：记忆法则是否注入（= 有旧账可翻）。 */
    memoryRules: boolean;
    /** ★ 2026-11-04：最近琐事摘要是否在场（未熔断）。 */
    tempEvents: boolean;
    /** ★ 2026-11-04：生活背景板是否在场（未熔断）。 */
    lifeBackground: boolean;
    /** ★ 2026-11-05 R4.3：记忆关联旧事是否在场。 */
    /** ★ 2026-11-08 记忆联想是否在场。 */
  memoryRecall: boolean;
  /** ★ 2026-11-09 R4.1：新人提示是否在场。 */
  newcomer: boolean;
  /** ★ 2026-11-16 P3：情绪底色是否在场。 */
  moodTint: boolean;
  recallHint: boolean;
    /** ★ 2026-11-05 R4.3：关系事实是否在场。 */
    milestoneHint: boolean;
    /** ★ 2026-11-05 R4.3：对话推进提示是否在场。 */
    pushHint: boolean;
    /** ★ 2026-11-05 R4.3：作息仪式提示是否在场。 */
    ritualHint: boolean;
  };
}

/** 安全取：任何回调抛错都降级为空值（红线 0.1：绝不阻塞主聊天）。 */
function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

/**
 * 按图纸 3.1 顺序取各段并熔断。
 *
 * 注意：**高光**与**固定系统指令**不参与熔断（图纸 3.2），因此高光原样拼在正文开头
 * （本函数不拼固定系统指令 —— 那是宿主 persona section 的职责，本函数的输出作为
 * 一个独立 section 追加在 sections **最末尾**，与 2.5.0 的「灵魂锚点」同一位置策略）。
 */
export function buildInjection(input: InjectInput): InjectOutput {
  const { groupId, userId, persona, levels, sources } = input;
  const profile = safe(() => String(sources.getProfile(userId) ?? '').trim(), '');
  const overlay = safe(() => String(sources.getOverlay(groupId, persona) ?? '').trim(), '');
  const relationship = safe(() => String(sources.getRelationshipTag(groupId, userId, levels) ?? '').trim(), '');
  const contest = safe(() => String(sources.getContestHint(groupId, userId) ?? '').trim(), '');
  const others = safe(() => sortOtherTags(sources.getOtherTags(groupId, userId), 5), []);
  const timeState = safe(() => String(sources.getTimeState() ?? '').trim(), '');
  const highlights = safe(() => String(sources.getHighlights() ?? '').trim(), '');
  // ★ 2026-11-04 双层记忆：琐事摘要是「触发开关」—— 非空 ⇔ 挂记忆法则。
  const tempEvents = safe(() => String(sources.getTempEvents?.(userId) ?? '').trim(), '');
  // 触发条件（决策点 ③ 方案 A）：有旧账可翻才挂法则；纯新用户/纯闲聊不挂。
  const memoryRules = tempEvents ? MEMORY_RULES : '';
  // ★ 2026-11-04 生活痕迹：隐藏背景板（参与熔断、最先被丢）。
  const lifeBackground = safe(() => String(sources.getLifeBackground?.() ?? '').trim(), '');
  // ★ 2026-11-05 R4.3：四个可选调味段落（不改 fuse.ts，见 InjectSources 上的设计说明）。
  const recallHint = safe(() => String(sources.getRecallHint?.(groupId, userId) ?? '').trim(), '');
  const milestoneHint = safe(() => String(sources.getMilestoneHint?.(groupId, userId) ?? '').trim(), '');
  const pushHint = safe(() => String(sources.getPushHint?.(groupId, userId) ?? '').trim(), '');
  const ritualHint = safe(() => String(sources.getRitualHint?.(groupId, userId) ?? '').trim(), '');

  /**
   * ★ 2026-11-05 参数解耦：预算由配置传入（`inject_config.fuse_budget`）。
   * 不传（undefined）→ 不覆盖 `fuse()` 的默认参数，行为与旧版一致。
   */
  const fuseArgs: Parameters<typeof fuse>[0] = {
    profile,
    lifeBackground,
    tempEvents,
    memoryRules,
    overlay,
    relationship,
    contest,
    others,
    timeState,
    highlights,
  };
  const budget = input.fuseBudget;
  const result = (typeof budget === 'number' && Number.isFinite(budget) && budget > 0)
    ? fuse(fuseArgs, budget)
    : fuse(fuseArgs);

  /**
   * ★ 2026-11-05 R4.3：调味段落独立预算拼接。
   *
   * 为什么不塞进 `fuse()`：fuse 有 116 个断言保护，改动风险大；而这四段都是「可选调味料」，
   * 本身就该有更短的预算。这里 **140 字**封顶，超了按顺序**整段跳过**（不截半句）。
   *
   * 顺序即优先级：里程碑 > 推进 > 旧事 > 仪式。
   * 放 `result.text` **之前** ⇒ 「时间状态绝对最后」的约束不变。
   */
  // ── 【2026-11-08 新增】记忆联想：**独立预算**，不挤占 EXTRA_BUDGET ──
  //
  // 三轮审查结论：EXTRA_BUDGET（140 字）已被现有 4 段占满（实测 99 字），
  // 记忆若也挤进去会**整段被丢弃** → 功能静默失效。
  // 所以给它独立预算，且拼接在 4 段**之前**（记忆比调味料更重要）。
  const MEMORY_RECALL_BUDGET = 280;
  let memoryRecallText = '';
  try {
    const raw = String(sources.getMemoryRecall?.() ?? '').trim();
    if (raw) {
      // 二次裁剪（实现方应已裁剪，这里兜底）
      if (charLen(raw) > MEMORY_RECALL_BUDGET) {
        memoryRecallText = clipByLen(raw, MEMORY_RECALL_BUDGET);
      } else {
        memoryRecallText = raw;
      }
    }
  } catch { /* 记忆联想失败 → 不注入，绝不影响主链 */ }

  // ── 【2026-11-09 新增】R4.1 新人识别：**独立预算**，同样不挤占 EXTRA_BUDGET ──
  //
  // 为什么不塞进 140：实测 4 段已占 99 字、只剩 41 字余量；占满后按
  // 「里程碑 > 推进 > 旧事 > 仪式」丢弃 —— 新人提示优先级最低，挤进去等于永远被丢。
  const NEWCOMER_BUDGET = 120;
  let newcomerText = '';
  try {
    const raw = String(sources.getNewcomerHint?.(groupId, userId) ?? '').trim();
    if (raw) {
      newcomerText = charLen(raw) > NEWCOMER_BUDGET ? clipByLen(raw, NEWCOMER_BUDGET) : raw;
    }
  } catch { /* 新人识别失败 → 不注入，绝不影响主链 */ }

  // ── 【2026-11-16 新增】P3 情绪底色：**独立预算**（不挤占 EXTRA_BUDGET）──
  const MOOD_TINT_BUDGET = 90;
  let moodTintText = "";
  try {
    const raw = String(sources.getMoodTint?.() ?? "").trim();
    if (raw) moodTintText = charLen(raw) > MOOD_TINT_BUDGET ? "" : raw;
  } catch { /* 情绪底色失败 → 不注入，绝不影响主链 */ }

  const EXTRA_BUDGET = 140;
  let extraText = '';
  for (const seg of [milestoneHint, pushHint, recallHint, ritualHint]) {
    if (!seg) continue;
    const next = extraText ? `${extraText}\n${seg}` : seg;
    if (charLen(next) > EXTRA_BUDGET) continue;
    extraText = next;
  }
  const includedInExtra = (seg: string): boolean => Boolean(seg) && extraText.includes(seg);

  return {
    // 拼接顺序（重要）：记忆联想 > 4 段调味料 > fuse 结果 > 时间状态
    text: joinRecallAndExtra(memoryRecallText, newcomerText, extraText, result.text, moodTintText),
    used: result.used,
    fused: result.fused,
    drops: result.drops,
    present: {
      highlights: Boolean(highlights),
      profile: Boolean(profile),
      overlay: Boolean(overlay),
      relationship: Boolean(relationship),
      contest: Boolean(contest),
      others: Array.isArray(others) ? others.length : 0,
      timeState: Boolean(timeState),
      memoryRules: Boolean(memoryRules),
      tempEvents: Boolean(tempEvents),
      lifeBackground: Boolean(lifeBackground),
      memoryRecall: Boolean(memoryRecallText),
      newcomer: Boolean(newcomerText),
      moodTint: Boolean(moodTintText),
      recallHint: includedInExtra(recallHint),
      milestoneHint: includedInExtra(milestoneHint),
      pushHint: includedInExtra(pushHint),
      ritualHint: includedInExtra(ritualHint),
    },
  };
}

/** 关系等级 → 中文标签（`L0`→高信任…）。 */
export function relationshipTagOf(level: Level | undefined, levels: RelationshipLevels): string {
  const name = level && levels[level] ? levels[level] : levels.L2;
  return `[当前关系标签：${name}]`;
}

/** 其他在场标签的单条文本（阶段三按字典序取前 5 后逐条渲染）。 */
export function otherTagText(userId: string, level: Level | undefined, levels: RelationshipLevels): string {
  const name = level && levels[level] ? levels[level] : levels.L2;
  return `[${userId}：${name}]`;
}

/** 组装后的 section 名称（与 2.5.0 的 `anti-ai-persona:anchors:<gid>` 区分，避免冲突）。 */
export function r4SectionName(groupId: string): string {
  return `dsh-anti-ai-persona:r4:${groupId}`;
}

/** 诊断文本（进日志或单元测试断言用，不含正文内容）。 */
export function describeInjection(out: InjectOutput): string {
  const parts = [
    `used=${out.used}`,
    `fused=${out.fused ? 'true' : 'false'}`,
    `highlights=${out.present.highlights ? 'y' : 'n'}`,
    `profile=${out.present.profile ? 'y' : 'n'}`,
    `overlay=${out.present.overlay ? 'y' : 'n'}`,
    `relation=${out.present.relationship ? 'y' : 'n'}`,
    `contest=${out.present.contest ? 'y' : 'n'}`,
    `others=${out.present.others}`,
    `time=${out.present.timeState ? 'y' : 'n'}`,
    `mem=${out.present.memoryRules ? 'y' : 'n'}`,
    `temp=${out.present.tempEvents ? 'y' : 'n'}`,
    `memRecall=${out.present.memoryRecall ? 'y' : 'n'}`,
    `recall=${out.present.recallHint ? 'y' : 'n'}`,
    `milestone=${out.present.milestoneHint ? 'y' : 'n'}`,
    `push=${out.present.pushHint ? 'y' : 'n'}`,
    `ritual=${out.present.ritualHint ? 'y' : 'n'}`,
  ];
  if (out.drops.length > 0) parts.push(`drops=${out.drops.join('|')}`);
  return `[r4] 注入 ${parts.join(' ')}`;
}

/** 按字符数截断（优先在「；」处断，避免半句）。 */
function clipByLen(input: string, max: number): string {
  const s0 = String(input ?? '');
  const limit = Math.max(0, Math.floor(Number(max) || 0));
  if (!s0 || limit <= 0) return '';
  if (charLen(s0) <= limit) return s0;
  // 已在 business 侧用「；」分段；这里简单按码点切
  let out = '';
  let n = 0;
  for (const ch of s0) {
    if (n >= limit) break;
    out += ch;
    n += 1;
  }
  return out;
}

/**
 * 四级拼接：记忆联想 → 新人提示 → 4 段调味料 → fuse 结果。空段自动跳过。
 *
 * 顺序依据：
 *   · 记忆联想最重要（她记得谁），排最前；
 *   · **新人提示紧接着** —— 它是"语气分寸"级别的约束，必须比调味料更早被人看到；
 *   · 4 段调味料（里程碑/推进/旧事/仪式）是可选修饰；
 *   · fuse 结果与时间状态保持既有顺序（「时间状态绝对最后」的红线不变）。
 */
function joinRecallAndExtra(recall: string, newcomer: string, extra: string, fused: string, moodTint = ''): string {
  const parts = [
    String(recall ?? '').trim(),
    String(newcomer ?? '').trim(),
    String(extra ?? '').trim(),
    String(moodTint ?? '').trim(),   // P3：情绪底色在 fuse 结果之前（时间状态仍绝对最后）
    String(fused ?? ''),
  ].filter(Boolean);
  return parts.join('\n');
}

/** 导出这些常量供 index/测试使用（避免重复定义字面量）。 */
export { CONTEST_HINT, charLen };
