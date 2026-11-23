/**
 * R4.0 模块四：关系网与争宠（`src/r4/relationship.ts`）。
 *
 * 图纸：方案.txt「模块四：关系网与争宠」4.1–4.3 + 1.1 `relationship_config` + 1.2
 * `relationships/{groupId}.json` Schema。契约：`contracts.ts` 同名函数（签名逐字对齐）。
 *
 * 纪律：
 *  - 全部**纯函数**：无 IO、无 `Date.now()`、无随机；`now` 一律入参，返回新对象（深拷贝）；
 *  - 模块之间不互相 import；这里只 import `types.ts` 的**类型**（`import type`，运行时被擦除），
 *    因此本文件可被 Node 24 直接用 `import('./relationship.ts')` 执行（不需要先构建）；
 *  - 自然日一律按 `Asia/Shanghai` 用 `Intl.DateTimeFormat` 取 `YYYY-MM-DD` 后做 UTC 归一相减，
 *    **绝不用毫秒除法**（Android 系统时区可能不是 +8，且毫秒差 24h ≠ 自然日）。
 */

import type {
  Level,
  LevelBound,
  RelationshipConfig,
  RelationshipEntry,
  RecentlyMessage,
  ScoreKind,
} from './types.js';
// ★ 2026-11-05（重构任务 A）：复用 time.ts 的缓存格式化器（原来本文件自建 FORMATTERS Map）
// ★ 2026-11-05（重构阶段 2 / 批次 D）：时区与「一天毫秒数」也统一到 time.ts，本文件不再各写一份。
import { zonedTime, DEFAULT_TIME_ZONE, DAY_MS } from './time.js';

/** 图纸固定时区（与 `elysia.json` 的 `timezone` 默认值一致）—— 定义已归一到 `time.ts`。 */
export { DEFAULT_TIME_ZONE };

/** 本文件内部沿用的旧名，值与 `time.ts` 的 `DAY_MS` 同一个。 */
const MS_PER_DAY = DAY_MS;
/** 计分类型顺序（与 types.ts 的 `SCORE_KINDS` 一致；本模块不运行时 import，故本地声明）。 */
const SCORE_KINDS: readonly ScoreKind[] = ['reply', 'mention', 'bot'];
/** 分数从低到高：遍历时按 L3 → L2 → L1 → L0 命中半开区间。 */
const LEVEL_ASC: readonly Level[] = ['L3', 'L2', 'L1', 'L0'];
/** 兜底用（从高到低找「minInclusive 不大于 score」的最高档）。 */
const LEVEL_DESC: readonly Level[] = ['L0', 'L1', 'L2', 'L3'];
/** 临时态度文案（图纸 4.2 逐字）。 */
export const TEMP_ATTITUDE_COLD = '冷淡';

/** 图纸 1.1 的默认等级区间（仅作坏配置时的兜底，正常路径永远用入参 bounds）。 */
export const DEFAULT_LEVEL_BOUNDS: Record<Level, LevelBound> = {
  L3: { minInclusive: -100, maxExclusive: -5 },
  L2: { minInclusive: -5, maxExclusive: 10 },
  L1: { minInclusive: 10, maxExclusive: 25 },
  L0: { minInclusive: 25, maxInclusive: 100 },
};

/* ─────────────────────────── 小工具（纯） ─────────────────────────── */

function num(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** 钳制到 `[-100, 100]`；非有限数按 0（防御坏数据，绝不抛错）。 */
function clampScore(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(-100, Math.min(100, n));
}

/** 深拷贝一条记录（`scoreCooldowns` 也复制；缺键补 0，坏值归 0）。保证不改入参。 */
function cloneEntry(entry: RelationshipEntry): RelationshipEntry {
  const src = (entry?.scoreCooldowns ?? {}) as Record<string, unknown>;
  const scoreCooldowns = { reply: 0, mention: 0, bot: 0 } as Record<ScoreKind, number>;
  for (const kind of SCORE_KINDS) scoreCooldowns[kind] = num(src[kind], 0);
  return {
    level: entry?.level ?? 'L2',
    score: clampScore(entry?.score),
    lastDecayAt: num(entry?.lastDecayAt, 0),
    updatedAt: num(entry?.updatedAt, 0),
    scoreCooldowns,
    temporaryAttitude: entry?.temporaryAttitude ?? '',
    temporaryAttitudeExpiresAt: num(entry?.temporaryAttitudeExpiresAt, 0),
    // ★ 2026-11-05 修（F3 统计被计分抹掉的 bug）：R4.3 给 RelationshipEntry 加了
    //   `firstMetAt` / `messageCount`（都是可选字段），但 `cloneEntry` 当初没跟上 ——
    //   `applyScore` → `applyDecay` / `scoreEvent` 全都过 `cloneEntry`，于是**每次计分都会
    //   把这两个统计字段清零回 0**：首见时间丢失、累计消息数永远长不大，
    //   F3「关系里程碑」拿到的是烂数据（实测：普通消息后 count=1，再来一条 @bot 计分后变 0）。
    //   `state.ts#relationshipEntryOf` 已经做了保留，只有这里漏了。
    //   条件展开：字段缺省时**不写**（保持 undefined），不要凭空造 0。
    ...(Number.isFinite(entry?.firstMetAt) ? { firstMetAt: Number(entry!.firstMetAt) } : {}),
    ...(Number.isFinite(entry?.messageCount) ? { messageCount: Number(entry!.messageCount) } : {}),
  };
}

/* ─────────────────────────── 时区 / 自然日 ─────────────────────────── */

/**
 * WallClock：本地「墙上时间」的六个分量。
 *
 * ★ 2026-11-05（重构任务 A）：**不再自己持有 `Intl.DateTimeFormat` 缓存**。
 *   原先这里有一份私有 `FORMATTERS` Map（和 `time.ts` 的 `FORMATTER_CACHE` 重复造），
 *   现在统一走 `time.ts` 的 `zonedTime()` —— 它已经缓存格式化器、已处理非法时区回退、
 *   并且（本次）新增了 `second` 分量，正好覆盖这里对秒的需求。
 *
 *   `withTime=false` 时 `hour/minute/second` 视为 0（只关心年月日），
 *   这样调用方（`dayKey`）拿到的字段语义与旧实现一致。
 */
interface WallClock {
  y: number;
  m: number;
  d: number;
  hour: number;
  minute: number;
  second: number;
}

function wallClock(ms: number, timeZone: string, withTime: boolean): WallClock {
  // 共享 time.ts 的缓存格式化器；非法时区在那里已回退 Asia/Shanghai（不抛）
  const t = zonedTime(ms, timeZone || DEFAULT_TIME_ZONE);
  if (!withTime) {
    // 只取年月日时，把时间分量归零 —— 与旧实现（withTime=false → 只 format 年月日）语义一致
    return { y: Number(t.date.slice(0, 4)), m: Number(t.date.slice(5, 7)), d: Number(t.date.slice(8, 10)), hour: 0, minute: 0, second: 0 };
  }
  return {
    y: Number(t.date.slice(0, 4)),
    m: Number(t.date.slice(5, 7)),
    d: Number(t.date.slice(8, 10)),
    hour: t.hour,
    minute: t.minute,
    second: t.second,
  };
}

function pad(value: number, width: number): string {
  const s = String(Math.trunc(Math.abs(value)));
  return s.padStart(width, '0');
}

/**
 * 取某毫秒时间戳在 `timeZone` 下的**自然日**键 `YYYY-MM-DD`（默认 Asia/Shanghai）。
 * 这是「跨天」的唯一判据（图纸 4.1）。
 */
export function dayKey(ms: number, timeZone: string = DEFAULT_TIME_ZONE): string {
  const w = wallClock(num(ms, 0), timeZone, false);
  if (!Number.isFinite(w.y) || !Number.isFinite(w.m) || !Number.isFinite(w.d)) return '1970-01-01';
  return `${pad(w.y, 4)}-${pad(w.m, 2)}-${pad(w.d, 2)}`;
}

/** `YYYY-MM-DD` → 该日 00:00 的 UTC 毫秒（仅用于求日期差，不代表真实瞬时）。 */
function dateKeyToUtc(key: string): number {
  const parts: readonly unknown[] = key.split('-');
  // 显式收窄：`noUncheckedIndexedAccess` 下下标访问是 `T | undefined`，不兜底会过不了 tsc。
  const y = num(parts[0], NaN);
  const m = num(parts[1], NaN);
  const d = num(parts[2], NaN);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return 0;
  return Date.UTC(y, m - 1, d);
}

/**
 * 自然日天数差：`laterMs` 的本地日 - `earlierMs` 的本地日。
 * 日期字符串先做 UTC 归一（`Date.UTC(y, m-1, d)`）再相减 / 86400000，规避 DST/时区误差。
 */
export function dayDiff(laterMs: number, earlierMs: number, timeZone: string = DEFAULT_TIME_ZONE): number {
  const a = dateKeyToUtc(dayKey(laterMs, timeZone));
  const b = dateKeyToUtc(dayKey(earlierMs, timeZone));
  return Math.round((a - b) / MS_PER_DAY);
}

/** 某瞬时相对 UTC 的时区偏移（毫秒，含正负；抹掉毫秒避免 formatToParts 无毫秒分量）。 */
function tzOffsetMs(ms: number, timeZone: string): number {
  const base = Math.floor(ms / 1000) * 1000;
  const w = wallClock(base, timeZone, true);
  return Date.UTC(w.y, w.m - 1, w.d, w.hour, w.minute, w.second) - base;
}

/** `timeZone` 下给定的「本地墙钟时间」→ 绝对毫秒（先猜 UTC 再按偏移修正，DST 边界收敛两次）。 */
export function zonedWallTimeToMs(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
  timeZone: string = DEFAULT_TIME_ZONE,
): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute, second, 0);
  let offset = tzOffsetMs(guess, timeZone);
  let out = guess - offset;
  for (let i = 0; i < 2; i += 1) {
    const next = tzOffsetMs(out, timeZone);
    if (next === offset) break;
    offset = next;
    out = guess - offset;
  }
  return out;
}

/**
 * 「次日 0 点」：按 `timeZone` 的本地日期 +1 天的 00:00:00.000（图纸 4.2）。
 * 先取 `dayKey`，再用 `Date.UTC` 归一化 `+1 天`（自动处理跨月/跨年），最后换回绝对毫秒。
 */
export function nextDayStart(now: number, timeZone: string = DEFAULT_TIME_ZONE): number {
  const key = dayKey(now, timeZone);
  const parts: readonly unknown[] = key.split('-');
  // 同上：显式兜底，满足 noUncheckedIndexedAccess。
  const y = num(parts[0], 1970);
  const m = num(parts[1], 1);
  const d = num(parts[2], 1);
  const next = dateKeyToUtc(`${pad(y, 4)}-${pad(m, 2)}-${pad(d, 2)}`) + MS_PER_DAY;
  // 用 UTC 归一算出「次日」的日月（Date.UTC 会自动进位跨月/跨年），再换回绝对毫秒。
  const normalized = new Date(next);
  return zonedWallTimeToMs(
    normalized.getUTCFullYear(),
    normalized.getUTCMonth() + 1,
    normalized.getUTCDate(),
    0,
    0,
    0,
    timeZone,
  );
}

/* ─────────────────────────── 4.1 计分与衰减 ─────────────────────────── */

/**
 * 按 `level_bounds` 半开区间映射等级（图纸 4.1）。
 *
 * 遍历 L3 → L2 → L1 → L0，命中 `score >= minInclusive && score < maxExclusive`；
 * L0 用 `score <= maxInclusive`（100 归 L0）。全都不命中时兜底：从高到低找
 * 「`minInclusive` 不大于 score」的最高档（升级不越 L0、降级不越 L3），
 * 即 101 仍 L0、-101 仍 L3。
 *
 * 防御：`bounds` 整块缺失/某个档缺失（坏配置）时，该档回退图纸默认区间
 * （`DEFAULT_LEVEL_BOUNDS`），避免「无 bounds」把 5 分误判成 L0。正常配置下行为不变。
 */
export function levelForScore(score: number, bounds: Record<Level, LevelBound>): Level {
  const s = num(score, 0);

  for (const level of LEVEL_ASC) {
    const bound = bounds?.[level] ?? DEFAULT_LEVEL_BOUNDS[level];
    const min = num(bound?.minInclusive, Number.NEGATIVE_INFINITY);
    if (s < min) continue;

    if (level === 'L0') {
      const max = num(bound?.maxInclusive, Number.POSITIVE_INFINITY);
      if (s <= max) return 'L0';
      continue;
    }
    const maxExclusive = num(bound?.maxExclusive, Number.POSITIVE_INFINITY);
    if (s < maxExclusive) return level;
  }

  // 兜底（正常配置走不到）：按 score 上下限钳到 L0 / L3，不越界。
  for (const level of LEVEL_DESC) {
    const bound = bounds?.[level] ?? DEFAULT_LEVEL_BOUNDS[level];
    const min = num(bound?.minInclusive, Number.NEGATIVE_INFINITY);
    if (s >= min) return level;
  }
  return s >= 0 ? 'L0' : 'L3';
}

/**
 * 按自然日衰减（返回**深拷贝**）：`score -= decay_per_day * 天数差`，钳制 `[-100, 100]`，
 * 更新 `lastDecayAt`，并按新分数重算 `level`。
 *
 * - `lastDecayAt === 0` → 首次：只把 `lastDecayAt = now`，**不扣分**（level/score 原样）；
 * - 否则 `deltaDays = max(0, dayDiff(now, lastDecayAt))`（`now` 早于 `lastDecayAt` 不涨分）。
 */
export function applyDecay(entry: RelationshipEntry, now: number, cfg: RelationshipConfig): RelationshipEntry {
  const out = cloneEntry(entry);
  const at = num(now, 0);

  if (out.lastDecayAt === 0) {
    // 首次见到这条记录：只打时间戳，不扣分（因此 level 保持入参值）。
    out.lastDecayAt = at;
    return out;
  }

  const deltaDays = Math.max(0, dayDiff(at, out.lastDecayAt));
  const decayPerDay = num(cfg?.decay_per_day, 0);
  out.score = clampScore(out.score - decayPerDay * deltaDays);
  out.lastDecayAt = at;
  out.level = levelForScore(out.score, cfg?.level_bounds);
  return out;
}

/**
 * 是否可计分：`scoreCooldowns[kind]` 为 `last`，`last === 0` 视为可计分，
 * 否则要求 `now - last >= score_cooldown_minutes * 60000`。
 */
export function canScore(
  entry: RelationshipEntry,
  kind: 'reply' | 'mention' | 'bot',
  now: number,
  cfg: RelationshipConfig,
): boolean {
  const last = num(entry?.scoreCooldowns?.[kind], 0);
  if (last === 0) return true;
  const cooldownMs = Math.max(0, num(cfg?.score_cooldown_minutes, 0) * 60_000);
  return num(now, 0) - last >= cooldownMs;
}

/** 计分类型 → 分值字段（`reply → score_reply` 等；**不存在 meme 键**）。 */
function scoreDelta(kind: 'reply' | 'mention' | 'bot', cfg: RelationshipConfig): number {
  if (kind === 'reply') return num(cfg?.score_reply, 0);
  if (kind === 'mention') return num(cfg?.score_mention, 0);
  if (kind === 'bot') return num(cfg?.score_bot, 0);
  return 0;
}

/**
 * 计分一次（返回**深拷贝**）：先 `applyDecay`，再判 `canScore`。
 *
 * - 冷却中：**原样返回 decay 后的对象**——`score` / `level` / `updatedAt` / `scoreCooldowns`
 *   都不动（只可能已按自然日衰减、`lastDecayAt` 已被刷新）。这是刻意的：冷却只是「这次不计分」，
 *   不代表发生了一次记录更新，所以 `updatedAt` 不应变化；
 * - 可计分：`score += 对应分值`，钳制 `[-100, 100]`，按 bounds 重算 `level`，
 *   `scoreCooldowns[kind] = now`（只动对应键），`updatedAt = now`。
 */
export function scoreEvent(
  entry: RelationshipEntry,
  kind: 'reply' | 'mention' | 'bot',
  now: number,
  cfg: RelationshipConfig,
): RelationshipEntry {
  const decayed = applyDecay(entry, now, cfg);
  if (!canScore(decayed, kind, now, cfg)) return decayed;

  const at = num(now, 0);
  const score = clampScore(decayed.score + scoreDelta(kind, cfg));
  return {
    ...decayed,
    score,
    level: levelForScore(score, cfg?.level_bounds),
    scoreCooldowns: { ...decayed.scoreCooldowns, [kind]: at },
    updatedAt: at,
  };
}

/* ─────────────────────────── 4.2 临时态度 ─────────────────────────── */

/**
 * 越界行为 → 写 `temporaryAttitude = "冷淡"`，`temporaryAttitudeExpiresAt = 次日 0 点`（Asia/Shanghai）。
 * **不改 `level` / `score`**；返回深拷贝。
 */
export function setTemporaryCold(input: {
  entry: RelationshipEntry;
  now: number;
  timeZone?: string;
}): RelationshipEntry {
  const out = cloneEntry(input?.entry as RelationshipEntry);
  const timeZone = input?.timeZone && String(input.timeZone).trim() ? String(input.timeZone).trim() : DEFAULT_TIME_ZONE;
  out.temporaryAttitude = TEMP_ATTITUDE_COLD;
  out.temporaryAttitudeExpiresAt = nextDayStart(num(input?.now, 0), timeZone);
  return out;
}

/**
 * 读取时惰性过期：`expiresAt > 0 && now >= expiresAt` → 清 `temporaryAttitude` / `ExpiresAt`。
 * 否则原样（深拷贝）。**不依赖定时任务**。
 */
export function lazyExpireAttitude(entry: RelationshipEntry, now: number): RelationshipEntry {
  const out = cloneEntry(entry);
  const expiresAt = out.temporaryAttitudeExpiresAt;
  if (expiresAt > 0 && num(now, 0) >= expiresAt) {
    out.temporaryAttitude = '';
    out.temporaryAttitudeExpiresAt = 0;
  }
  return out;
}

/* ─────────────────────────── 4.3 争宠 ─────────────────────────── */

/**
 * 在场 L3 集合：最近 `withinMinutes`（默认 30）分钟内**非 bot**（`self === false`）消息的
 * `senderId` 集合 ∩ `relationships`，取 `level === 'L3'` 者，**按 userId 字典序**返回。
 * 数据不可用（`messages` 缺失/为空）→ 返回空数组（调用方 warn 并跳过注入）。
 */
export function presentLowLevelUsers(input: {
  messages: RecentlyMessage[];
  relationships: Record<string, RelationshipEntry>;
  now: number;
  withinMinutes?: number;
}): string[] {
  const messages = Array.isArray(input?.messages) ? input.messages : [];
  const relationships = input?.relationships ?? {};
  const now = num(input?.now, 0);
  const withinMinutes = Math.max(0, num(input?.withinMinutes, 30));
  const windowMs = withinMinutes * 60_000;

  const senders = new Set<string>();
  for (const message of messages) {
    if (!message || message.self !== false) continue; // 只认明确「非 bot」的消息
    const at = num(message.at, 0);
    if (now - at > windowMs) continue; // 超出窗口（含未来时间戳时 -at 为负，仍算在场）
    const userId = String(message.senderId ?? '').trim();
    if (userId) senders.add(userId);
  }

  const present: string[] = [];
  for (const userId of senders) {
    const entry = relationships[userId];
    if (entry && entry.level === 'L3') present.push(userId);
  }
  present.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)); // 字典序（阶段三按此取前 5）
  return present;
}

/** 争宠是否触发：当前对话者为 L0/L1，且在场 L3 集合非空（文案由阶段三组装）。 */
export function shouldInjectContest(input: {
  currentLevel: Level | undefined;
  presentLow: string[];
}): boolean {
  const level = input?.currentLevel;
  if (!(level === 'L0' || level === 'L1')) return false;
  return Array.isArray(input?.presentLow) && input.presentLow.length > 0;
}

/**
 * 关系标签文案：`[当前关系标签：<levels[level]>]`。
 *
 * `level` 缺省（`undefined`，例如该用户还没进 `relationships`）→ 按 L2 文案（`levels.L2`，
 * 即「普通」）；`levels.L2` 也缺失时兜底字面量「普通」。
 */
export function relationshipTag(level: Level | undefined, levels: Record<Level, string>): string {
  const key = level; // `Level | undefined`：缺省即「该用户还没进 relationships」
  const table = levels ?? ({} as Record<Level, string>);
  const label = (key && typeof table[key] === 'string' && table[key]) || table['L2'] || '普通';
  return `[当前关系标签：${label}]`;
}
