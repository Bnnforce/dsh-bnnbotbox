/**
 * 记忆联想 · 第二层「主动惦记」—— **纯逻辑层**
 *
 * 与第一层（被动联想）的区别：
 *   · 第一层：每轮 assemble 把「我记得你是谁」塞进 prompt，**被动**；
 *   · 第二层：后台定时判定「今天该想起谁」，主动写一条 outbox 消息，**主动**。
 *
 * 三条判据（三轮审查确定，全部只用**本地已有数据**，不调模型）：
 *   ① 生日临近  —— `entities/events/birthdays/MM-DD-名.md`
 *   ② 老友久未出现 —— `state/relationships/<gid>.json` 的 `updatedAt` / `messageCount`
 *   ③ 关系跳级  —— 同一份关系文件的 `level`，与 state 里上次记录比较
 *
 * 纪律（`开发规则`）：
 *   · 本文件**零 IO、零 cordis、零全局状态** → 可单测（IO 在 maintenance-tasks / host 层）；
 *   · 所有阈值来自 config，无魔法数字；
 *   · 任何异常都不抛（调用方还有一层 try/catch）。
 *
 * 频率上限：**每天 1 次**（可配 1..3）+ 每小时窗口 + 两次惦记间隔 + 单人冷却，
 * 宁可少说也不刷屏（主动开口过多比不说更伤人格）。
 */

/** 惦记类型。 */
export type CallbackKind = 'birthday' | 'absent' | 'levelup';

/** 第二层配置（全部外置，见 `config.ts` 的 memoryCallback*）。 */
export interface MemoryCallbackConfig {
  enabled: boolean;
  /** 每天最多几次。 */
  dailyMax: number;
  /** 「久未出现」阈值（天）。 */
  minGapDays: number;
  /** 允许惦记的小时窗口 [from, to)。 */
  hoursFrom: number;
  hoursTo: number;
  /** 老友判定：历史消息条数下限。 */
  minMessages: number;
  /** 生日提前几天开始惦记。 */
  birthdayWithinDays: number;
  /** 同一个人多久内不重复惦记（天）。 */
  perUserCooldownDays: number;
  /**
   * 是否把**自己的生日**也交给本层（决策 A：默认 false）。
   *
   * false = 自己的生日交给扩展包 `ext-birthday-auto`（生日当天一次完整自祝），
   *         本层只提醒别人的生日；
   * true  = 生日前 N 天也铺垫自己的生日（会和 ext 的当天祝福叠成两次）。
   */
  ownBirthday: boolean;
  /** 两次惦记之间的最小间隔（毫秒）。 */
  minGapMs: number;
}

/** 默认值（`config.ts` 的 schema 默认与这里保持一致，双保险）。 */
export const MEMORY_CALLBACK_DEFAULTS: MemoryCallbackConfig = {
  enabled: true,
  dailyMax: 1,
  minGapDays: 7,
  hoursFrom: 10,
  hoursTo: 21,
  minMessages: 20,
  birthdayWithinDays: 3,
  perUserCooldownDays: 14,
  minGapMs: 4 * 60 * 60 * 1000,
  ownBirthday: false,
};

/** 硬上限（配大了也夹住，防止误配置导致刷屏）。 */
export const HARD_MAX_DAILY = 3;
/** 两次惦记的最小间隔地板（2 小时）。 */
export const HARD_MIN_GAP_MS = 2 * 60 * 60 * 1000;
/** 生日提前量上限（天）。 */
export const HARD_MAX_BIRTHDAY_DAYS = 7;

/** 归一化配置：非法值一律回落默认，数值夹在硬边界内。 */
export function clampMemoryCallbackConfig(raw?: Partial<MemoryCallbackConfig> | undefined): MemoryCallbackConfig {
  const d = MEMORY_CALLBACK_DEFAULTS;
  const num = (v: unknown, fallback: number, min: number, max: number): number => {
    const n = typeof v === 'number' ? v : Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.round(n)));
  };
  return {
    enabled: raw?.enabled !== false,
    dailyMax: num(raw?.dailyMax, d.dailyMax, 1, HARD_MAX_DAILY),
    minGapDays: num(raw?.minGapDays, d.minGapDays, 1, 60),
    hoursFrom: num(raw?.hoursFrom, d.hoursFrom, 0, 23),
    hoursTo: num(raw?.hoursTo, d.hoursTo, 1, 24),
    minMessages: num(raw?.minMessages, d.minMessages, 0, 10_000),
    birthdayWithinDays: num(raw?.birthdayWithinDays, d.birthdayWithinDays, 0, HARD_MAX_BIRTHDAY_DAYS),
    perUserCooldownDays: num(raw?.perUserCooldownDays, d.perUserCooldownDays, 1, 365),
    ownBirthday: raw?.ownBirthday === true,
    minGapMs: num(raw?.minGapMs, d.minGapMs, HARD_MIN_GAP_MS, 24 * 60 * 60 * 1000),
  };
}

/** 关系文件里的一行（只取判定需要的字段）。 */
export interface RelationshipEntry {
  userId: string;
  /** 关系等级（`L1`..`L4`；缺失 = 未知）。 */
  level?: string;
  /** 最后一次互动时间（毫秒；缺失 = 0）。 */
  updatedAt?: number;
  /** 历史消息条数。 */
  messageCount?: number;
}

/** 生日条目（由 host 从记忆库解析）。 */
export interface BirthdayEntry {
  name: string;
  month: number;
  day: number;
}

/** 候选「该想起的人」。 */
export interface CallbackCandidate {
  kind: CallbackKind;
  /** openid（生日条目可能没有对应 openid → 空串）。 */
  userId: string;
  name: string;
  /** 触发理由（给 prompt 用，如「12 天没说话」）。 */
  reason: string;
  /** 越小越优先。 */
  priority: number;
}

/** 惦记状态（落盘 `state/memory-callback.json`）。 */
export interface MemoryCallbackState {
  /** 本地日期（YYYY-MM-DD），用于跨天重置。 */
  date: string;
  /** 今天已惦记次数。 */
  todayCount: number;
  /** 上次惦记时间（毫秒）。 */
  lastAt: number;
  /** `${groupId}:${userId}:${kind}` → 上次动机时间（毫秒）。 */
  used: Record<string, number>;
  /** `${groupId}:${userId}` → 上次记录的等级（跳级判定基线）。 */
  levels: Record<string, string>;
}

export const EMPTY_CALLBACK_STATE: MemoryCallbackState = {
  date: '',
  todayCount: 0,
  lastAt: 0,
  used: {},
  levels: {},
};

/** 状态文件里 used/levels 的上限（防止无限膨胀）。 */
const STATE_ENTRY_MAX = 500;

/** 严格半开区间：`from <= hour < to`（与 life-stream 的口径一致）。 */
export function isHourInWindow(hour: number, from: number, to: number): boolean {
  const h = Number.isFinite(hour) ? Math.floor(hour) : 0;
  const f = Math.min(23, Math.max(0, Math.floor(Number(from) || 0)));
  const t = Math.min(24, Math.max(1, Math.floor(Number(to) || 24)));
  if (f === t) return false;
  if (f < t) return h >= f && h < t;
  // 跨午夜窗口（如 22..6）
  return h >= f || h < t;
}

/**
 * 距下一次「月-日」还有几天（0 = 今天，1 = 明天）。
 *
 * 只做**日历差**，不处理闰年 2-29（返回 365 内的最近值，够用）。
 */
export function daysUntilMonthDay(month: number, day: number, today: { year: number; month: number; day: number }): number {
  const m = Math.floor(Number(month));
  const d = Math.floor(Number(day));
  if (!(m >= 1 && m <= 12) || !(d >= 1 && d <= 31)) return Number.POSITIVE_INFINITY;
  const base = Date.UTC(today.year, today.month - 1, today.day);
  const target = Date.UTC(today.year, m - 1, d);
  const dayMs = 24 * 60 * 60 * 1000;
  let diff = Math.round((target - base) / dayMs);
  if (diff < 0) {
    // 已过 → 算到明年
    diff = Math.round((Date.UTC(today.year + 1, m - 1, d) - base) / dayMs);
  }
  return diff;
}

/** 等级排序（`L1` < `L2` < ...；解析不到 → 0 = 未知，**不参与跳级判定**）。 */
export function levelRank(level: unknown): number {
  const m = /^L(\d+)$/iu.exec(String(level ?? '').trim());
  return m ? Number(m[1]) : 0;
}

/** 生成候选清单（**不做频率判定**，纯事实）。 */
export function detectCandidates(input: {
  groupId: string;
  relationships: RelationshipEntry[];
  birthdays: BirthdayEntry[];
  /** 已知的「显示名」查询（生日条目可反查；查询失败用空串 → 跳过）。 */
  nameOf?: (userId: string) => string;
  today: { year: number; month: number; day: number };
  now: number;
  config: MemoryCallbackConfig;
  /**
   * 当前人格自己的名字（用于**是否把自己的生日交给本层**）。
   *
   * ★ 2026-11-08 决策 A（主人选定）：自己的生日**默认不归本层管** ——
   *   扩展包 `ext-birthday-auto` 已经在生日当天做一次完整的第一人称自祝
   *   （含许愿、@全体），本层再在前几天铺垫会造成「同一件事说两次」。
   *   所以这里连同 `ownBirthday` 一起判断：`ownBirthday=false` 且命中自己 → 直接跳过。
   *   想改回「前 3 天也铺垫」只需把配置 `ownBirthday` 设 true，不用改代码。
   */
  selfName?: string;
}): CallbackCandidate[] {
  const cfg = input.config;
  const out: CallbackCandidate[] = [];
  const dayMs = 24 * 60 * 60 * 1000;
  const selfName = String(input.selfName ?? '').trim();

  // ① 生日临近（优先级最高：错过就是一年）
  for (const b of input.birthdays ?? []) {
    const days = daysUntilMonthDay(b.month, b.day, input.today);
    if (!(days <= cfg.birthdayWithinDays)) continue;
    const name = String(b.name || '').trim();
    // ★ 决策 A：自己的生日交给 ext-birthday-auto（当天一次），本层不铺垫
    if (!cfg.ownBirthday && selfName && name && name === selfName) continue;
    const reason = days === 0 ? '今天生日' : days === 1 ? '明天生日' : `${days} 天后生日`;
    // 生日文件名只有昵称、没有 openid → userId 留空（冷却 key 用昵称）
    out.push({ kind: 'birthday', userId: '', name, reason, priority: 0 });
  }

  // ② 关系跳级需要 state 里的历史等级 → 见 `detectLevelJumps`（本函数不处理）

  // ③ 老友久未出现
  for (const r of input.relationships ?? []) {
    const uid = String(r.userId ?? '');
    if (!uid) continue;
    const updated = Number(r.updatedAt ?? 0);
    if (!(updated > 0)) continue; // 从未互动过（不是「老友」）
    const gapDays = Math.floor((Number(input.now) - updated) / dayMs);
    if (gapDays < cfg.minGapDays) continue;
    const count = Number(r.messageCount ?? 0);
    if (count < cfg.minMessages) continue;
    const name = input.nameOf ? String(input.nameOf(uid) ?? '') : '';
    out.push({ kind: 'absent', userId: uid, name, reason: `${gapDays} 天没说话（聊过 ${count} 条）`, priority: 2 });
  }

  return out;
}

/** 跳级候选（需要 state 的历史等级，故独立成函数）。 */
export function detectLevelJumps(input: {
  groupId: string;
  relationships: RelationshipEntry[];
  levels: Record<string, string>;
  nameOf?: (userId: string) => string;
}): CallbackCandidate[] {
  const out: CallbackCandidate[] = [];
  for (const r of input.relationships ?? []) {
    const uid = String(r.userId ?? '');
    if (!uid) continue;
    const cur = levelRank(r.level);
    const prev = levelRank(input.levels[`${input.groupId}:${uid}`]);
    if (prev <= 0 || cur <= 0 || cur <= prev) continue;
    const name = input.nameOf ? String(input.nameOf(uid) ?? '') : '';
    out.push({ kind: 'levelup', userId: uid, name, reason: `关系从 L${prev} 升到 L${cur}`, priority: 1 });
  }
  return out;
}

/** 判定结果。 */
export interface CallbackDecision {
  ok: boolean;
  /** 不发的理由（诊断用；ok=true 时为空）。 */
  reason: string;
  candidate?: CallbackCandidate;
}

/**
 * 频率闸门 + 选人。
 *
 * 闸门顺序（先便宜后贵；任一不过立刻返回，**不产生副作用**）：
 *   ① enabled ② 小时窗口 ③ 当天配额 ④ 两次惦记间隔 ⑤ 有候选 ⑥ 单人冷却
 */
export function pickCallback(input: {
  groupId: string;
  candidates: CallbackCandidate[];
  state: MemoryCallbackState;
  now: number;
  hour: number;
  config: MemoryCallbackConfig;
}): CallbackDecision {
  const cfg = input.config;
  if (!cfg.enabled) return { ok: false, reason: 'disabled' };
  if (!isHourInWindow(input.hour, cfg.hoursFrom, cfg.hoursTo)) return { ok: false, reason: 'hour' };
  if (Number(input.state.todayCount) >= cfg.dailyMax) return { ok: false, reason: 'quota' };
  const lastAt = Number(input.state.lastAt ?? 0);
  if (lastAt > 0 && Number(input.now) - lastAt < cfg.minGapMs) return { ok: false, reason: 'gap' };

  const list = (input.candidates ?? []).filter((c) => c && (c.name || c.userId));
  if (!list.length) return { ok: false, reason: 'no-candidate' };

  const cooldownMs = cfg.perUserCooldownDays * 24 * 60 * 60 * 1000;
  const usable = list
    .filter((c) => {
      const key = `${input.groupId}:${c.userId || c.name}:${c.kind}`;
      const at = Number(input.state.used?.[key] ?? 0);
      return !(at > 0 && Number(input.now) - at < cooldownMs);
    })
    .sort((a, b) => (a.priority !== b.priority ? a.priority - b.priority : 0));
  if (!usable.length) return { ok: false, reason: 'cooldown' };

  return { ok: true, reason: '', candidate: usable[0] };
}

/** 生成「惦记」prompt（给 outbox 桥用；**只描述场景，不替模型写台词**）。 */
export function buildCallbackPrompt(input: {
  candidate: CallbackCandidate;
  /** 最近群聊（可为空；只用于避免话题撞车）。 */
  recentChat?: string;
  /** 当前本地时间文本（如 `11-08 15:20`）。 */
  timeText?: string;
  /**
   * 当前人格自己的名字。
   *
   * 生日档案里**可能记着 bot 自己的生日**（实测主群 21 条生日，其中一条是
   * 「11-11-爱莉希雅」）。这种情况不能按「想起某个群友」来写 —— 会变成
   * 她对着自己喊生日。→ 换成「自己的生日快到了」这套说法。
   */
  selfName?: string;
}): string {
  const c = input.candidate;
  if (!c) return '';
  const name = String(c.name || '').trim();
  const selfName = String(input.selfName ?? '').trim();
  const isSelf = Boolean(selfName) && Boolean(name) && name === selfName;
  if (isSelf && c.kind === 'birthday') {
    return [
      '[主动想到一件事]',
      input.timeText ? `现在是 ${input.timeText}。` : '',
      `你自己的生日快到了（${c.reason}）。`,
      '在群里自然地提一句 —— 是随口想到自己的生日，不是在报日程。',
      '要求：',
      '· 不邀请任何人、不暗示礼物或庆祝、不撒娇要祝福；',
      '· 不说「我生日快到了你们准备了吗」这类讨要的话；',
      '· 语气轻松、可以带一点自我调侃或期待，符合平时的说话习惯；',
      '· 一句话，20-40 字，不刷表情；',
      '· 实在想不出说什么就沉默（输出空）。',
    ].filter(Boolean).join('\n');
  }

  const who = name || '一个群友';
  const lines = [
    '[主动想起某个人]',
    input.timeText ? `现在是 ${input.timeText}。` : '',
    `你忽然想起${who}：${c.reason}。`,
    '在群里自然地提一句 —— 像随口想到，不是特意找他。',
    '要求：',
    '· 不要 @ 他，也不要点名喊他过来；',
    '· 不说「好久不见」「想你了」「最近怎么样」这类客套话，也不解释「怎么突然想起」；',
    '· 可以提他上次说过的小事、他的习惯、或者一句你俩之间才有的话；',
    '· 一句话，20-40 字，语气日常，不刷表情；',
    '· 实在想不出说什么就沉默（输出空）。',
  ];
  if (input.recentChat) lines.push(`（最近群里的话，别重复：${String(input.recentChat).slice(0, 120)}）`);
  return lines.filter(Boolean).join('\n');
}

// ── 状态机（纯函数，读写由宿主负责）──────────────────────────────────────

/** 归一化落盘状态（脏数据一律回落空）。 */
export function normalizeCallbackState(raw: unknown): MemoryCallbackState {
  const r = (raw ?? {}) as Partial<MemoryCallbackState>;
  const used: Record<string, number> = {};
  const levels: Record<string, string> = {};
  if (r.used && typeof r.used === 'object') {
    for (const [k, v] of Object.entries(r.used)) {
      if (typeof k === 'string' && typeof v === 'number' && Number.isFinite(v)) used[k] = v;
    }
  }
  if (r.levels && typeof r.levels === 'object') {
    for (const [k, v] of Object.entries(r.levels)) {
      if (typeof k === 'string' && typeof v === 'string' && v) levels[k] = v;
    }
  }
  return {
    date: typeof r.date === 'string' ? r.date : '',
    todayCount: Number.isFinite(Number(r.todayCount)) ? Math.max(0, Math.floor(Number(r.todayCount))) : 0,
    lastAt: Number.isFinite(Number(r.lastAt)) ? Math.max(0, Math.floor(Number(r.lastAt))) : 0,
    used: capEntries(used, STATE_ENTRY_MAX),
    levels: capEntries(levels, STATE_ENTRY_MAX),
  };
}

/** 超过上限时丢最早的一半（值必须可比较数字/字符串；这里按插入序简单裁）。 */
function capEntries<T>(obj: Record<string, T>, max: number): Record<string, T> {
  const keys = Object.keys(obj);
  if (keys.length <= max) return obj;
  const keep = keys.slice(keys.length - max);
  const out: Record<string, T> = {};
  for (const k of keep) out[k] = obj[k] as T;
  return out;
}

/** 跨天重置（只清 todayCount，保留 used/levels 冷却基线）。 */
export function resetIfNewDay(state: MemoryCallbackState, today: string): MemoryCallbackState {
  if (state.date === today) return state;
  return { ...state, date: today, todayCount: 0 };
}

/** 记录一次惦记（调用方在**成功写入 outbox 之后**调，防重复）。 */
export function markCallback(
  state: MemoryCallbackState,
  input: { groupId: string; candidate: CallbackCandidate; now: number },
): MemoryCallbackState {
  const c = input.candidate;
  const key = `${input.groupId}:${c.userId || c.name}:${c.kind}`;
  return {
    ...state,
    todayCount: Math.max(0, Number(state.todayCount) || 0) + 1,
    lastAt: Number(input.now),
    used: { ...state.used, [key]: Number(input.now) },
  };
}

/**
 * 用当前关系快照刷新等级基线。
 *
 * ⚠️ 必须在 `detectLevelJumps` **之后**调用，否则跳级信息当场丢失。
 */
export function recordLevels(
  state: MemoryCallbackState,
  input: { groupId: string; relationships: RelationshipEntry[] },
): MemoryCallbackState {
  const levels = { ...state.levels };
  for (const r of input.relationships ?? []) {
    const uid = String(r.userId ?? '');
    const lv = String(r.level ?? '').trim();
    if (!uid || !lv) continue;
    levels[`${input.groupId}:${uid}`] = lv;
  }
  return { ...state, levels: capEntries(levels, STATE_ENTRY_MAX) };
}
