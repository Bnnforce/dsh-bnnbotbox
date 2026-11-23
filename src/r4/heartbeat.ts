/**
 * R4.0 模块二：心跳状态机（纯函数、无 IO、不抛错）。
 *
 * 图纸依据（方案.txt 2.1 状态流转 / 2.3 时间字段更新 / 2.4 心跳执行）：
 *  - `normal` 触发心跳：先 `state=waiting, waitingUntil=now+15min,
 *    lastBotMessageAt=now, dailyCount++`，**写成功才发送**；发送失败由调度器
 *    `warn` 后调用 `rollbackWaitSent`（state=normal、waitingUntil=0、dailyCount--）。
 *  - `waiting` 未到期 → 跳过；到期无人回复 → `cooldown`（3h，cold=true/coldSetAt=now）；
 *    到期有人回复 → `normal, waitingUntil=0`。
 *  - `cooldown` 内有人回复 → `normal, cooldownUntil=0, cold=false`；
 *    `cooldownUntil` 到期无人回复 → `normal`，**cold 保留**；
 *    `coldSetAt` 超 24h → 强制 `cold=false` 且 **coldSetAt 清 0**。
 *  - 前置跳过 5 条**顺序严格**，任一命中即跳过（不计数、不发送、不改状态）。
 *
 * 纪律：
 *  - 本文件不读写磁盘、不算随机数（随机只由 `nextIntervalMs` 消费）；
 *  - 不 import contracts.ts（图纸 0.1：模块间只共享 types/logger）；`HeartbeatTickResult`
 *    在本文件内联定义，与 contracts.ts 的接口**逐字一致**；
 *  - 所有导出函数都返回**新对象**，绝不修改入参（可安全地拿旧状态做回滚快照）；
 *  - 唯一允许的模块间依赖是模块一的 `./time.js`（`isSleepWindow` / `zonedTime`，
 *    纯函数）——图纸 2.4 明确要求装死窗口判定走模块一。
 */

import type { HeartbeatConfig, HeartbeatState } from './types.js';
import { isSleepWindow, zonedTime } from './time.js';

/**
 * waiting 等待窗口（分钟）**默认值**：图纸 2.1 固定 `waitingUntil = now + 15min`。
 *
 * 2026-11-04 改：从「硬编码常量」变成「默认值」—— `heartbeat_config.waiting_minutes` 可覆盖。
 * 原因：interval 可配而 waiting 不可配时，调短 interval 完全不生效
 * （每轮仍要等满 15 分钟 waiting 才推进状态机），调试/测试时观察不到节奏。
 * 图纸默认仍为 15，不改配置时行为与之前**完全一致**。
 */
export const WAITING_MINUTES = 15;

/** 从配置解析 waiting 窗口（非法/缺省/<=0 → 默认 15）。纯函数、不抛。 */
export function resolveWaitingMinutes(cfg: unknown): number {
  const raw = Number((cfg as { waiting_minutes?: unknown } | undefined)?.waiting_minutes);
  if (!Number.isFinite(raw) || raw <= 0) return WAITING_MINUTES;
  return Math.max(1, Math.round(raw));
}

/** 调度最小间隔：图纸 2.4「最小不低于 5 分钟」。 */
export const MIN_INTERVAL_MS = 5 * 60 * 1000;

/** 死群阈值：图纸 2.4「`now - lastNonBotMessageAt > 2h` 视为死群」。 */
export const DEAD_GROUP_MS = 2 * 60 * 60 * 1000;

/** cold 兜底阈值：图纸 2.1「coldSetAt 超 24h → 强制 cold=false」。 */
export const COLD_MAX_HOURS = 24;

/**
 * `waitingUntil` 的容错上限（2026-11-03 修复 R4 体检 P1-3）。
 *
 * 脏数据（时钟回拨、写入方把 waitingUntil 写成极远未来、手工改坏文件）会让
 * 「waiting 未到期 → 跳过」这条分支**永远命中**，心跳死锁且没有任何兜底。
 * 超过该上限一律视为损坏：强制回 `normal` + 清 `waitingUntil` 并 warn。
 */
export const MAX_WAIT_MS = 2 * 60 * 60 * 1000;

/** `cooldownUntil` 的容错上限：图纸固定 3h。超出（或 <= -24h）按损坏处理。 */
export const MAX_COOLDOWN_MS = COLD_MAX_HOURS * 60 * 60 * 1000;

const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

/** 配置缺失时的兜底（与 config.ts 默认值一致）。 */
const DEFAULT_INTERVAL_MINUTES = 45;
const DEFAULT_JITTER_MINUTES = 0;
const DEFAULT_MAX_DAILY = 5;
const DEFAULT_COOLDOWN_HOURS = 3;
/** 死群小时数兜底（图纸固定 2h）。 */
const DEFAULT_DEAD_GROUP_HOURS = 2;

/**
 * 「群最近有人说话就跳过」的**纯函数兜底值**（2026-11-05 心跳人性化·阶段 1）。
 *
 * ⚠️ 这里**故意是 0（关闭）**，不是 20：
 *   `evaluateTick` 是纯函数，现有 52 条单测大量依赖"给定状态该发就发"的语义。
 *   若这里默认 20，所有没显式传该字段的老用例会突然全部变成"跳过" → 大面积假失败，
 *   而且会掩盖真实回归。
 *
 *   生产默认值（20）放在 `config.ts` 的 `DEFAULT_CONFIG.heartbeat_config` 里，
 *   由 scheduler 原样把 `config.heartbeat_config` 传给 `evaluateTick`，自然生效。
 *   这样「纯函数向后兼容」和「生产默认开启」两件事同时成立。
 */
const DEFAULT_MIN_QUIET_MINUTES = 0;

/** 心跳 tick 结果（与 contracts.ts `HeartbeatTickResult` 逐字一致）。 */
export interface HeartbeatTickResult {
  /** 迁移后的状态（调用方负责原子写） */
  state: HeartbeatState;
  /** 是否发生了写状态的需求 */
  changed: boolean;
  /** 需要发送心跳时为 true；此时 state 已迁移到 waiting 且 dailyCount 已 +1 */
  shouldSend: boolean;
  /** 跳过原因（诊断用，中文） */
  skipReason?: string;
}

/** 安全数字：非有限值一律回退。 */
function numOr(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** 状态枚举兜底：脏数据一律按 `normal`（不让未知状态卡死状态机）。 */
function statusOr(value: unknown): HeartbeatState['state'] {
  return value === 'waiting' || value === 'cooldown' || value === 'normal' ? value : 'normal';
}

/**
 * 深拷贝 + 字段归一化（不修改入参，脏字段按默认值收敛）。
 * 所有导出函数都从它出发，保证「纯函数、返回新对象」。
 */
function copy(state: HeartbeatState): HeartbeatState {
  const s = (state ?? {}) as Partial<HeartbeatState>;
  return {
    date: typeof s.date === 'string' ? s.date : '',
    dailyCount: numOr(s.dailyCount),
    lastNonBotMessageAt: numOr(s.lastNonBotMessageAt),
    lastBotMessageAt: numOr(s.lastBotMessageAt),
    state: statusOr(s.state),
    cold: s.cold === true,
    coldSetAt: numOr(s.coldSetAt),
    waitingUntil: numOr(s.waitingUntil),
    cooldownUntil: numOr(s.cooldownUntil),
  };
}

/**
 * 跨天重置：`state.date !== date` → `dailyCount=0, date=date`；
 * 相等则原样返回（**仍是新对象**，不改入参）。
 *
 * 图纸 2.4「跨天重置」只列这两个字段，其余字段（cold/waiting/cooldown/时间戳）保持不动。
 */
export function resetIfNewDay(state: HeartbeatState, t: { date: string; at: number }): HeartbeatState {
  const next = copy(state);
  const date = typeof t?.date === 'string' ? t.date : '';
  // `t.at` 保留在签名里（调用方需要传当天时间戳），跨天判定只用 `date` 字符串。
  void t?.at;
  if (next.date !== date) {
    next.dailyCount = 0;
    next.date = date;
  }
  return next;
}

/**
 * 发送前写状态（`normal` 触发心跳时调用；**调用方必须先原子写成功再发送**）。
 * 图纸 2.1：`state=waiting, waitingUntil=now+15min, lastBotMessageAt=now, dailyCount++`。
 * 只改这四个字段，其余（date/lastNonBotMessageAt/cold/coldSetAt/cooldownUntil）保持不动。
 */
export function markWaitSent(state: HeartbeatState, now: number, waitingMinutes = WAITING_MINUTES): HeartbeatState {
  const next = copy(state);
  const at = numOr(now);
  const minutes = Number.isFinite(waitingMinutes) && waitingMinutes > 0 ? waitingMinutes : WAITING_MINUTES;
  next.state = 'waiting';
  next.waitingUntil = at + minutes * MINUTE_MS;
  next.lastBotMessageAt = at;
  next.dailyCount = Math.max(0, numOr(next.dailyCount)) + 1;
  return next;
}

/**
 * 发送失败回滚：`state=normal, waitingUntil=0, dailyCount--`（**不得为负**）。
 *
 * `lastBotMessageAt` **保持不动**（不回滚）：发送失败那条消息没有进入历史，
 * 不是「bot 说过的话」；此外 `markWaitSent` 写入前的旧值本函数拿不到，
 * 调度器应优先保留 `markWaitSent` 之前的快照（`{ ...state }`），本函数只做兜底回滚。
 * 同理 `cold` / `coldSetAt` / `cooldownUntil` 不动（本函数只撤销 waiting 那一步）。
 */
export function rollbackWaitSent(state: HeartbeatState): HeartbeatState {
  const next = copy(state);
  next.state = 'normal';
  next.waitingUntil = 0;
  next.dailyCount = Math.max(0, numOr(next.dailyCount) - 1);
  return next;
}

/**
 * 「有人回复」触发的状态解除（图纸 2.1）：
 *  - `waiting` → `normal, waitingUntil=0`；
 *  - `cooldown` → `normal, cooldownUntil=0, cold=false`；
 *  - `normal` → 原样（新对象）。
 *
 * 清 `cold` 时一并把 `coldSetAt` 清 0：与 24h 兜底（清 0）保持同一约定，避免
 * 「cold=false 但 coldSetAt 仍是旧时间」的脏数据。`now` / `cooldownHours` 保留在
 * 签名里（调度器审计用），本函数内不做时间判定。
 */
export function onSomeoneReplied(state: HeartbeatState, now: number, cooldownHours: number): HeartbeatState {
  const next = copy(state);
  void now;
  void cooldownHours;
  if (next.state === 'waiting') {
    next.state = 'normal';
    next.waitingUntil = 0;
    return next;
  }
  if (next.state === 'cooldown') {
    next.state = 'normal';
    next.cooldownUntil = 0;
    next.cold = false;
    next.coldSetAt = 0;
    return next;
  }
  return next;
}

/**
 * `waiting` 到期且期间无人回复 → `cooldown`：
 * 图纸 2.1 要求 `state=cooldown, cooldownUntil=now+3h, cold=true, coldSetAt=now`。
 * `waitingUntil` 清 0（图纸未列，实现细节：`state=cooldown` 下该字段不参与判定，清掉防脏）。
 */
export function expireWaitingToCooldown(state: HeartbeatState, now: number, cooldownHours: number): HeartbeatState {
  const next = copy(state);
  const at = numOr(now);
  const hours = Number.isFinite(cooldownHours) && cooldownHours >= 0 ? cooldownHours : DEFAULT_COOLDOWN_HOURS;
  next.state = 'cooldown';
  next.cooldownUntil = at + hours * HOUR_MS;
  next.cold = true;
  next.coldSetAt = at;
  next.waitingUntil = 0;
  return next;
}

/**
 * `cooldownUntil` 到期且无人回复 → `state=normal`，**cold 保留**（图纸 2.1）。
 * `cooldownUntil` 保持不动（图纸未列；`state=normal` 下该字段不参与判定）。
 */
export function onCooldownExpired(state: HeartbeatState, now: number): HeartbeatState {
  const next = copy(state);
  void now;
  next.state = 'normal';
  return next;
}

/**
 * 24h 兜底：`now - coldSetAt > 24h` → `cold=false`，且 `coldSetAt` **清 0**
 * （图纸 2.1 只写「强制 cold=false」；清 0 是明确约定的实现细节：避免 cold=false 时
 * 残留过期时间戳，后续 cold 重新置位时 coldSetAt 会被重新写成 now）。
 * 边界取严格 `>`：恰好 24h 仍算 cold（「超 24h」才清）。
 * `cold=false` 时原样返回（新对象）。
 */
export function enforceColdExpiry(state: HeartbeatState, now: number, hours = COLD_MAX_HOURS): HeartbeatState {
  const next = copy(state);
  if (!next.cold) return next;
  const h = Number.isFinite(hours) && hours > 0 ? hours : COLD_MAX_HOURS;
  const age = numOr(now) - next.coldSetAt;
  // coldSetAt=0（脏数据/未记录）时 age 极大，同样会被兜底清掉，符合「超 24h」语义。
  if (age > h * HOUR_MS) {
    next.cold = false;
    next.coldSetAt = 0;
  }
  return next;
}

/**
 * 脏时间戳兜底（2026-11-03 修复 P1-3）：只处理「未来过远」的时间戳。
 * - `waiting` 且 `waitingUntil - now > MAX_WAIT_MS` → 损坏：`state=normal, waitingUntil=0`；
 * - `cooldown` 且 `cooldownUntil - now > MAX_COOLDOWN_MS` → 损坏：`state=normal, cooldownUntil=0`。
 * `cold` / `coldSetAt` / `dailyCount` 不动（`coldSetAt` 有它自己的 24h 兜底）。
 *
 * 返回的 `sanitized=true` 表示确实改过，调用方应写盘并 warn（便于线上发现坏数据来源）。
 */
export function sanitizeCorruptDeadlines(state: HeartbeatState, now: number): { state: HeartbeatState; sanitized: boolean } {
  const next = copy(state);
  const at = numOr(now);
  let sanitized = false;
  if (next.state === 'waiting' && next.waitingUntil - at > MAX_WAIT_MS) {
    next.state = 'normal';
    next.waitingUntil = 0;
    sanitized = true;
  }
  if (next.state === 'cooldown' && next.cooldownUntil - at > MAX_COOLDOWN_MS) {
    next.state = 'normal';
    next.cooldownUntil = 0;
    sanitized = true;
  }
  // 时间戳早于「过去 24h 之前」的 waiting/cooldown 也视为污点（防止负向死锁）。
  if (next.state === 'waiting' && next.waitingUntil < at - MAX_WAIT_MS) {
    next.state = 'normal';
    next.waitingUntil = 0;
    sanitized = true;
  }
  if (next.state === 'cooldown' && next.cooldownUntil < at - MAX_COOLDOWN_MS) {
    next.state = 'normal';
    next.cooldownUntil = 0;
    sanitized = true;
  }
  return { state: next, sanitized };
}

/**
 * 下一次调度间隔（毫秒）：`(interval ± jitter)` 随机，**最小不低于 5 分钟**（图纸 2.4）。
 * `random()` 取 `[0,1)`；越界/非有限/抛错 → 按 0.5（无抖动）兜底，绝不抛错。
 * `jitter_minutes` 取绝对值（负配置按正处理）。
 *
 * **2026-11-03 修复 P2-3**：此前 `scheduler.ts` 与本源各有一份同名实现且语义不同
 * （本源曾在 [base-jitter, base+jitter] 区间、调度器在 [base-jitter+2jitter*r]），
 * 本源那份是死代码。现在**唯一实现放在这里**，`scheduler.ts` 直接复用本函数，
 * 保证「定时器实际间隔」与「状态机契约」是同一个公式。
 */
export function nextIntervalMs(cfg: HeartbeatConfig, random: () => number): number {
  const intervalMinutes = Math.max(0, numOr(cfg?.interval_minutes, DEFAULT_INTERVAL_MINUTES));
  const jitterMinutes = Math.abs(numOr(cfg?.jitter_minutes, DEFAULT_JITTER_MINUTES));
  const baseMs = intervalMinutes * MINUTE_MS;
  const jitterMs = jitterMinutes * MINUTE_MS;
  let roll = 0.5;
  try {
    const value = random?.();
    const n = Number(value);
    if (Number.isFinite(n)) roll = Math.max(0, Math.min(1, n));
  } catch {
    roll = 0.5;
  }
  // roll ∈ [0,1] → offset ∈ [-jitter, +jitter]
  const offsetMs = (roll * 2 - 1) * jitterMs;
  const ms = Math.round(baseMs + offsetMs);
  return Math.max(MIN_INTERVAL_MS, ms);
}

/**
 * 心跳 tick 判定（**唯一的状态机入口**）。
 *
 * 顺序（图纸 2.4 + 本模块硬性规格，**严格不可调换**）：
 *  1. `resetIfNewDay`（跨天重置，这一步可能已产生 `changed=true`）；
 *  2. 前置跳过 5 条：装死窗口 → 死群 → waiting 未到期 → cooldown 未到期 → 每日上限；
 *  3. 到期迁移：waiting 到期 **且期间有人回复** → normal；waiting 到期 **无人回复** → cooldown；
 *     cooldown 到期 → normal（cold 保留）；
 *  4. 全部不命中 → `markWaitSent`，`shouldSend=true`。
 *
 * **到期迁移后本次 tick 不再判定发送**（图纸未写，采用保守策略：迁移那一 tick
 * `shouldSend=false`，状态先落盘，下一 tick 再按新状态判定；注释即约定）。
 *
 * `repliedDuringWait`（可选，不破坏既有调用方）：图纸 2.1 的两条 waiting 到期分支
 * 需要区分「期间有人回复 / 无人回复」。布尔由调度层在**同一次 tick 内**先用
 * `hasSomeoneReplied` 算好再传入（纯函数自身拿不到消息历史）。只在
 * `state==='waiting' && now >= waitingUntil` 时生效：
 *  - `true`  → `onSomeoneReplied`（state=normal, waitingUntil=0）；
 *  - `false`/缺省 → `expireWaitingToCooldown`（state=cooldown, cold=true, coldSetAt=now）。
 *
 * `random` 保留在签名里兼容契约（图纸 2.4 的抖动由 `nextIntervalMs` 负责），
 * 本函数**不做任何随机**（死群/到期判定均为确定性）。
 */
export function evaluateTick(input: {
  state: HeartbeatState;
  now: number;
  date: string;
  heartbeat: HeartbeatConfig;
  lastNonBotMessageAt: number;
  deadGroupHours?: number;
  random?: () => number;
  /** waiting 到期那一次 tick 由调度层预算的「期间是否有人回复」（图纸 2.1 两条分支）。 */
  repliedDuringWait?: boolean;
}): HeartbeatTickResult {
  const now = numOr(input?.now);
  const date = typeof input?.date === 'string' ? input.date : '';
  const heartbeat = (input?.heartbeat ?? {}) as HeartbeatConfig;
  const maxDaily = Math.max(0, numOr(heartbeat.max_daily, DEFAULT_MAX_DAILY));
  const cooldownHours = Math.max(0, numOr(heartbeat.cooldown_hours, DEFAULT_COOLDOWN_HOURS));
  const deadGroupMs =
    (Number.isFinite(input?.deadGroupHours) && Number(input?.deadGroupHours) >= 0
      ? Number(input?.deadGroupHours)
      : DEFAULT_DEAD_GROUP_HOURS) * HOUR_MS;
  // 契约参数保留但不使用（本函数无随机；未来抖动也只能在 nextIntervalMs）。
  void input?.random;

  // 1) 跨天重置。
  const originalDate = typeof input?.state?.date === 'string' ? input.state.date : '';
  let state = resetIfNewDay(input?.state as HeartbeatState, { date, at: now });
  let changed = state.date !== originalDate;

  // 1.5) 脏截止时间兜底（2026-11-03 修复 P1-3）：必须在「waiting/cooldown 未到期 → 跳过」之前。
  //      修正后**本 tick 不发送**（与「到期迁移 tick 不发送」同一保守策略），
  //      否则会把一份损坏状态直接当成「可以立刻发心跳」，反而制造一次意外发送。
  const fixed = sanitizeCorruptDeadlines(state, now);
  if (fixed.sanitized) {
    state = fixed.state;
    return {
      state,
      changed: true,
      shouldSend: false,
      skipReason: '状态里的 waitingUntil/cooldownUntil 明显损坏（超出容错上限）→ 已修正为 normal，本 tick 不发送',
    };
  }

  // 2) 前置跳过 —— 顺序严格：装死 → 死群 → waiting → cooldown → 每日上限。
  // 注意：跳过分支不改状态字段，但跨天重置仍会返回 changed=true（重置与跳过度独立）。
  const hour = zonedTime(now).hour; // 上海小时数，走模块一（纯函数）
  if (isSleepWindow(hour)) {
    return { state, changed, shouldSend: false, skipReason: '装死窗口（02:00-06:00）内 → 跳过' };
  }

  const lastNonBotMessageAt = numOr(input?.lastNonBotMessageAt, numOr(state.lastNonBotMessageAt));
  // 2026-11-04：`deadGroupHours === 0` 的语义是**关闭死群判定**，不是"窗口 0 小时"
  //   （否则静默 1 秒就被判死群，与"关闭"完全相反）。这里显式分支，不用 `0 ? : ` 的假值技巧。
  if (deadGroupMs > 0 && lastNonBotMessageAt > 0 && now - lastNonBotMessageAt > deadGroupMs) {
    const hoursText = deadGroupMs % HOUR_MS === 0
      ? `${deadGroupMs / HOUR_MS}h`
      : `${Math.round(deadGroupMs / MINUTE_MS)}min`;
    return { state, changed, shouldSend: false, skipReason: `死群（最近非 bot 消息已超 ${hoursText}）→ 跳过` };
  }

  if (state.state === 'waiting' && now < state.waitingUntil) {
    return { state, changed, shouldSend: false, skipReason: 'waiting 等待期内（now < waitingUntil）→ 跳过' };
  }

  if (state.state === 'cooldown' && now < state.cooldownUntil) {
    return { state, changed, shouldSend: false, skipReason: 'cooldown 冷却期内（now < cooldownUntil）→ 跳过' };
  }

  // 3) 到期迁移（保守：迁移后本 tick 不发送，下一 tick 再判定）。
  if (state.state === 'waiting') {
    // 走到这里必然 now >= waitingUntil（未到期已在上面跳过）。
    if (input?.repliedDuringWait === true) {
      // 图纸 2.1：waiting 到期且期间「有人回复」→ normal、waitingUntil=0。
      state = onSomeoneReplied(state, now, cooldownHours);
      return {
        state,
        changed: true,
        shouldSend: false,
        skipReason: 'waiting 到期且期间有人回复 → normal（迁移 tick 不发送）',
      };
    }
    state = expireWaitingToCooldown(state, now, cooldownHours);
    return {
      state,
      changed: true,
      shouldSend: false,
      skipReason: 'waiting 到期且期间无人回复 → cooldown（迁移 tick 不发送，下一 tick 再判定）',
    };
  }
  if (state.state === 'cooldown') {
    // 走到这里必然 now >= cooldownUntil。
    state = onCooldownExpired(state, now);
    return {
      state,
      changed: true,
      shouldSend: false,
      skipReason: 'cooldown 到期且无人回复 → normal（cold 保留，迁移 tick 不发送）',
    };
  }

  // ★★ 2026-11-05 修（P0 · 心跳状态机卡死）：以下两个「跳过发送」的判定
  //    **必须排在到期迁移之后** —— 它们只决定「这一轮要不要开口」，
  //    **不该决定状态机能不能前进**。
  //
  //    原先它们在迁移之前，导致：配额跑满的群永远迁不出 waiting/cooldown
  //    （实测 某群A cooldown 已过期 48 分钟、某群B waiting 已过期 23 分钟仍卡着）；
  //    次日 0 点跨天重置后，过期 waiting 还会走 expireWaitingToCooldown →
  //    凭空进 3h cooldown + cold=true（她凌晨静默、早上第一句被强加"哼"）。
  //    迁移本身不发送消息，所以不需要被这两个判定拦截。

  // 5) 群最近 N 分钟内有人说话 → 跳过，**不插嘴**（心跳人性化·阶段 1）。
  //
  // 事故背景（2026-11-05 20:05）：那条「你们俩这是被同一件事坑了吧哈哈」发出时，
  // 群里 **11 分 45 秒前**刚有人说话（19:53:32），而旧状态机完全不看群里有没有人说话，
  // 只按自己的 waiting/cooldown 记账 → 在别人的对话中间硬插了一句。
  //
  // 缺省 0 = 关闭（原因见 DEFAULT_MIN_QUIET_MINUTES 的注释）。
  const minQuietMinutes = numOr(heartbeat.min_quiet_minutes, DEFAULT_MIN_QUIET_MINUTES);
  const minQuietMs = Math.max(0, minQuietMinutes) * MINUTE_MS;
  if (minQuietMs > 0 && lastNonBotMessageAt > 0 && now - lastNonBotMessageAt < minQuietMs) {
    const quietMinutes = Math.round((now - lastNonBotMessageAt) / MINUTE_MS);
    return {
      state,
      changed,
      shouldSend: false,
      skipReason: `群最近 ${quietMinutes} 分钟有人说话（< ${minQuietMinutes} 分钟阈值）→ 跳过，不插嘴`,
    };
  }

  // 6) 每日上限（同样在迁移之后，避免配额满把状态机锁死）。
  if (state.dailyCount >= maxDaily) {
    return {
      state,
      changed,
      shouldSend: false,
      skipReason: `今日心跳已达上限（dailyCount=${state.dailyCount} >= max_daily=${maxDaily}）→ 跳过`,
    };
  }

  // 7) 全部通过：进入 waiting 并请求发送（调用方先原子写、再发送）。
  //    waiting 窗口取配置 `heartbeat_config.waiting_minutes`（缺省 15 = 图纸默认）。
  state = markWaitSent(state, now, resolveWaitingMinutes(heartbeat));
  return { state, changed: true, shouldSend: true };
}
