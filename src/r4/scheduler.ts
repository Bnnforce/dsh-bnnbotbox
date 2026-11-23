/**
 * R4.0 调度器（阶段四：心跳任务 + 凌晨提取任务的定时器）。
 *
 * 图纸 4.2 交付清单里，R4 需要重启的定时器有两个：
 *   ③ 心跳任务定时器；④ 凌晨提取任务定时器。
 *
 * 本文件**只做调度与编排**：
 *   · 心跳：按 `interval_minutes ± jitter_minutes`（最小 5 分钟）逐个群 tick；
 *   · 提取：每天 `run_daily_at` 后跑一次，`lastRunDate == 今天` 则跳过；失败也写今天、不重试。
 *
 * 纪律：
 *   · 所有异常吞掉并 warn，绝不抛顶层（红线 0.1）；
 *   · 定时器 `unref()`，不阻止进程退出；
 *   · 提供 `stop()`（幂等），供插件 dispose 调用；
 *   · 任何外部能力（发消息 / 调模型）都是**注入的回调**，缺失则跳过（不崩）。
 */

import { join } from 'node:path';

import { isPlainObject, readJsonSafe, writeJsonAtomic } from './atomic.js';
import { logInfo, logWarn, type R4Logger } from './logger.js';
import { stateDir } from './paths.js';
import { dayKeyOf } from './sample.js';
import { nextIntervalMs as heartbeatNextIntervalMs } from './heartbeat.js';
import { readExtractionState, writeExtractionState, readHeartbeat, writeHeartbeat } from './state.js';
import { resolveTimeZone, secondsOfDay, zonedTime } from './time.js';
import type { ElysiaConfig, HeartbeatState, RecentlyMessage } from './types.js';

/** 心跳单轮的结果（诊断）。 */
export interface HeartbeatTickReport {
  groupId: string;
  /** 是否跳过以及为什么。 */
  skipped: boolean;
  reason?: string;
  /** 是否真的"由 R4 自己发出去了"（legacy 的 send 成功）。**wake 入队成功时为 false**。 */
  sent: boolean;
  /**
   * ★ 2026-11-05：是否已交给下一跳（wake 写入 outbox / legacy 直接发送）。
   * 与 `delivered` 分开，是为了让日志和测试能区分「已入队」和「已送达」。
   */
  queued: boolean;
  /** ★ 2026-11-05：是否已真正送达群里（只有 legacy 的 send 成功才算；wake 只是入队）。 */
  delivered: boolean;
  /** 本群当日累计。 */
  dailyCount: number;
}

/**
 * ★ 2026-11-05 心跳 wake：一次心跳的生成结果（共享契约 §3）。
 *
 * `text` 与 `wakePrompt` **至少有一个非空**：
 *   · legacy 模式只给 `text`；
 *   · wake 模式只给 `wakePrompt`（不给正文，让被唤醒的 agent 用完整人格自己说）。
 */
export interface HeartbeatDraft {
  /** legacy 模式要发的正文；wake 模式下作为 wake 失败时的兜底（可为空 = 失败就沉默）。 */
  text?: string;
  /** wake 模式要注入给 agent 的指令全文（首行必须是 `HEARTBEAT_WAKE_MARKER`）。 */
  wakePrompt?: string;
  tag?: string;
}

/** outbox 文件的 payload（R4 写、扩展桥读；共享契约 §3）。 */
export interface HeartbeatWakePayload {
  /** 唯一 id：`{gid}-{ts}-{rand}`，桥用它判重，**不用内容指纹**。 */
  id: string;
  groupId: string;
  /** ★ 向后兼容：老桥 `readOutbox` 里 `if (!text) return null` 会整条丢弃 —— 所以**永远写**（可为空串）。 */
  text: string;
  /** wake 指令全文；空/缺省 = 老格式，桥直接发 `text`。 */
  wakePrompt?: string;
  at: number;
}

/** 提取单轮的结果（诊断）。 */
export interface ExtractionRunReport {
  /** 今天日期（Asia/Shanghai）。 */
  date: string;
  /** 是否因「今天已跑过」跳过。 */
  skipped: boolean;
  /** 处理了几个群。 */
  groups: number;
  /** 每个群的处置摘要（不含正文内容）。 */
  notes: string[];
  /** 整体是否失败（失败也不重试）。 */
  failed: boolean;
}

/** 心跳依赖（全部可注入，便于测试隔离）。 */
export interface HeartbeatDeps {
  config: ElysiaConfig;
  root: string;
  logger?: R4Logger;
  /** 列出所有待检查的群（一般来自 msg-history 目录）。 */
  listGroups: () => string[];
  /** 读某群最近消息（用于「有人回复」判定与生成参考）。 */
  readMessages: (groupId: string) => RecentlyMessage[];
  /** 判定与迁移（模块二 `evaluateTick` + `hasSomeoneReplied`）。由 index 注入，避免 r4 内部硬依赖。 */
  evaluate: (input: {
    groupId: string; state: HeartbeatState; now: number; date: string;
    messages: RecentlyMessage[];
    /** 死群判定窗口（小时）。2026-11-04 新增：不传 = 回落 2h（旧行为）。 */
    deadGroupHours?: number;
  }) => {
    next: HeartbeatState;
    changed: boolean;
    shouldSend: boolean;
    skipReason?: string;
    /** 状态机判定「waiting 到期且期间有人回复」时为 true（供日志）。 */
    repliedDuringWait?: boolean;
  };
  /**
   * 生成心跳内容（返回 null = 本次不发送）。超时/空返回也返 null。
   *
   * ★ 2026-11-05 契约变更（共享契约 §3）：
   *   返回值从 `{text}` 改为 `HeartbeatDraft`；wake 模式下 `text` 为空、`wakePrompt` 非空。
   *   入参新增 `now` / `lastBotMessageAt` / `lastNonBotMessageAt`（wake prompt 要用，
   *   后者必须取 heartbeat state —— bot 自己的发言不在 `messages` 里，见硬阻塞 #3）。
   */
  generate: (input: {
    groupId: string;
    messages: RecentlyMessage[];
    /** 当前时间戳（由调度器传，缺省时生成方回落自己取）。 */
    now?: number;
    /** 该群她上次说话的时间戳（heartbeat state 的 `lastBotMessageAt`，0 = 未知）。 */
    lastBotMessageAt?: number;
    /** 该群最近一条**真人**消息时间戳（heartbeat state 的 `lastNonBotMessageAt`，0 = 未知）。 */
    lastNonBotMessageAt?: number;
  }) => Promise<HeartbeatDraft | null>;
  /** 真正发送；返回是否成功。缺失 = 该模式下不能发送（跳过）。 */
  send?: (groupId: string, text: string) => Promise<boolean>;
  /**
   * ★ 2026-11-05 心跳 wake：写入唤醒队列（**不是"已送达"**）。返回 true = 已入队。
   *
   * 由 index 注入（落到 `r4-bridge.ts#sendWakeToGroup`，写 outbox 文件）。
   * 扩展包 `hooks/r4-heartbeat-bridge.mjs` 读到后会用 `caps.wakeTo` 注入 agent。
   * 缺失 = wake 模式没有通道（调度器按「该模式未接线」跳过，**绝不拿 legacy 正文硬发**）。
   */
  sendWake?: (payload: HeartbeatWakePayload) => Promise<boolean>;
  /** 当前时间（测试注入）。 */
  now?: () => number;
  /** 随机数（测试注入）。 */
  random?: () => number;
}

/** 提取依赖。 */
export interface ExtractionDeps {
  config: ElysiaConfig;
  root: string;
  logger?: R4Logger;
  /** 列出所有群。 */
  listGroups: () => string[];
  /** 读某群最近 N 条非 bot 文字消息。 */
  readMessages: (groupId: string, limit: number) => import('./types.js').RecentlyMessage[];
  /** 对单个群跑一次提取；返回写入了几条 tag（0 = 无）。 */
  extract: (input: { groupId: string; messages: import('./types.js').RecentlyMessage[] }) => Promise<{ accepted: number }>;
  now?: () => number;
}

/** 调度器句柄。 */
export interface SchedulerHandle {
  /** 心跳单轮（也供手动触发/测试）。 */
  tickHeartbeatOnce: () => Promise<HeartbeatTickReport[]>;
  /** 提取单轮（也供手动触发/测试）。 */
  runExtractionOnce: () => Promise<ExtractionRunReport>;
  /** 停止全部定时器（幂等）。 */
  stop: () => void;
  /** 当前是否在跑。 */
  readonly running: boolean;
}

/**
 * 最小间隔（图纸 2.4：最小不低于 5 分钟）。与 `heartbeat.ts` 同一常量。
 */
export const MIN_INTERVAL_MS = 5 * 60 * 1000;

/**
 * 计算下一次心跳间隔（毫秒）。
 *
 * **2026-11-03 修复 P2-3**：此前本源与 `heartbeat.ts` 各有一份实现且语义不同；
 * 现在**只复用 `heartbeat.ts:nextIntervalMs`**（单一实现），本函数退化为薄封装，
 * 保留导出只为兼容既有测试与外部调用。
 */
export function nextIntervalMs(cfg: ElysiaConfig['heartbeat_config'], random: () => number): number {
  return heartbeatNextIntervalMs(cfg, random);
}

/**
 * ★ 2026-11-05 心跳 wake：解析某群本轮该用哪种生成/投递模式。
 *
 * 规则（共享契约 §1）：
 *   · `generation_mode`：`'legacy' | 'wake'`，**缺省 legacy**（opt-in —— 保护现有 e2e 的
 *     「`sentToGroup` 被调用 / `state=waiting`」断言）；
 *   · `wake_first_groups`：非空 = **只有名单内的群**走 wake（灰度），名单外一律 legacy；
 *     空/缺省 = 全部群按 `generation_mode`。
 *
 * ⚠️ mode **必须来自配置**，不能从「有没有接线 sendWake」推断 —— 否则
 * `generation_mode='legacy'` 的回滚开关是假的（架构审查列出的硬阻塞 #1）。
 */
export function resolveGenerationMode(config: ElysiaConfig, groupId: string): 'legacy' | 'wake' {
  const hb = config?.heartbeat_config;
  const fallback: 'legacy' | 'wake' = hb?.generation_mode === 'wake' ? 'wake' : 'legacy';
  // ★ 2026-11-05 修（P1 · 回滚开关失效）：`generation_mode` 是**总闸**，优先级高于灰度名单。
  //   原先 `wake_first_groups` 非空时 `generation_mode` 被完全忽略 ——
  //   按文档把 generation_mode 改成 'legacy' 做回滚时，灰度名单里的群**仍然在走 wake**，
  //   安全开关实际是假的。现在：总闸关 = 一律 legacy；总闸开（wake）时灰度名单才生效。
  if (fallback === 'legacy') return 'legacy';
  const firstGroups = Array.isArray(hb?.wake_first_groups)
    ? hb.wake_first_groups.map((g) => (typeof g === 'string' ? g.trim() : '')).filter((g) => g.length > 0)
    : [];
  if (firstGroups.length === 0) return fallback;
  return firstGroups.includes(String(groupId ?? '').trim()) ? 'wake' : 'legacy';
}

/**
 * wake payload/outbox 的唯一后缀（4 位 36 进制）。
 *
 * **刻意不用注入的 `random()`**：那是心跳抖动用的随机源，测试里常被固定成常量
 * （`() => 0.5`），拿它做 id 会让两次 tick 生成同一个 id → 扩展桥按 id 判重会
 * **误丢第二条**。这里用独立的 `Math.random`，保证「5 秒内两次」也唯一。
 */
function newWakeRand4(): string {
  return (Math.random().toString(36).slice(2, 6) + '0000').slice(0, 4);
}

/* ───────────── wake 回执 / 桥存活（2026-11-05 心跳账目修复） ───────────── */

/**
 * 扩展桥存活窗口（毫秒）：`.bridge-alive` 超过这个时长没刷新 = 桥没加载/已挂。
 *
 * 为什么是 30 秒：桥的扫描节律是 5 秒（`tasks.json` 的 `ext-heartbeat-bridge`，
 * **禁止降频**），30 秒 = 连续 6 轮没写存活文件，足以判定它已经不在了。
 */
export const BRIDGE_ALIVE_STALE_MS = 30_000;

/**
 * wake 回执回滚有效期的**下限**（毫秒）：只回滚「最近一轮内」的失败回执。
 *
 * 上限不宜太大：回执文件每群只有一份、会被桥覆盖写，太老的回执回滚的是
 * 早已被别的 tick 改过的账，容易扣错。
 */
export const WAKE_RECEIPT_TTL_MS = 30 * 60 * 1000;

/** 回执有效期在「一整轮最长心跳间隔」之外再留的余量（桥 5 秒扫一次，正常几秒内就有回执）。 */
const WAKE_RECEIPT_MARGIN_MS = 15 * 60 * 1000;

/**
 * 计算 wake 回执的有效期：**必须覆盖一整轮最长心跳间隔**。
 *
 * 为什么不能写死 30 分钟：心跳节律是 `interval_minutes ± jitter_minutes`
 * （生产 45±15 分钟），失败回执要等到**下一次 tick** 才会被消费 ——
 * 写死 30 分钟会让大多数轮次的回执在下次 tick 前就过期，回滚永远不发生，
 * 这个 bug 等于没修。所以按配置推导：`(interval + |jitter|) + 15 分钟余量`，下限 30 分钟。
 */
export function wakeReceiptTtlMs(config: ElysiaConfig): number {
  const hb = config?.heartbeat_config;
  const interval = Number(hb?.interval_minutes);
  const jitter = Math.abs(Number(hb?.jitter_minutes));
  const maxRoundMinutes = (Number.isFinite(interval) ? interval : 45) + (Number.isFinite(jitter) ? jitter : 0);
  return Math.max(WAKE_RECEIPT_TTL_MS, Math.round(maxRoundMinutes * 60_000) + WAKE_RECEIPT_MARGIN_MS);
}

/** 回执 `at` 允许比本机 now 超前多少（毫秒）：只为容忍轻微时钟抖动。 */
const WAKE_RECEIPT_FUTURE_SLACK_MS = 60_000;

/** 「桥未存活」warn 的节流间隔（同一群 5 分钟最多一条，防刷屏）。 */
const BRIDGE_ALIVE_WARN_MS = 5 * 60 * 1000;

/**
 * `state/heartbeat-receipts/{groupId}.json`（扩展桥写的投递回执）。
 * 契约（共享契约 §5）：`{ at, via, status: 'injected' | 'wake-failed', id }`，
 * `id` = R4 写进 outbox 的 payload id。
 */
interface HeartbeatWakeReceipt {
  at: number;
  status: 'injected' | 'wake-failed';
  id: string;
  via?: string;
}

/** 一次已入队、尚未拿到结果的 wake（回滚 `lastBotMessageAt` 需要「入队前」的值）。 */
interface WakeLedgerPending {
  id: string;
  /** 入队时刻（= payload.at，也是 `markWaitSent` 写进状态的那个假时间）。 */
  at: number;
  /** 入队**之前**状态的 `lastBotMessageAt`。 */
  prevLastBotMessageAt: number;
}

/**
 * ★ 2026-11-05：R4 自己的 wake 记账。
 *
 * 为什么必须单独存：桥的 receipt 每群**只有一个文件、覆盖写**，不能当历史用；
 * 而 `HeartbeatState` 经 `readHeartbeat` 白名单重建会丢未知字段 —— 所以
 * 「这个回执已经回滚过」的标记必须落在 R4 自己的持久化文件里（本文件）。
 */
interface WakeLedgerGroup {
  pending?: WakeLedgerPending;
  /** 最近一个已消费（已回滚）的回执 id —— 防同一回执每轮重复回滚。 */
  consumedReceiptId?: string;
  consumedAt?: number;
}

interface WakeLedger {
  version: number;
  groups: Record<string, WakeLedgerGroup>;
}

/**
 * 回执文件路径。**文件名必须与扩展桥 `writeReceipt` 逐字一致**：
 * 桥只把路径分隔符替换成 `_`（见 `r4-heartbeat-bridge.mjs` 的 `writeReceipt`）；
 * 这里若改用更严格的 `sanitizeId`，遇到特殊字符会算出另一个文件名 → 回滚永远失效。
 * （`..` 这类字符不含分隔符，只会变成 `...json` 这样的普通文件名，不会穿越目录。）
 */
function wakeReceiptFile(groupId: string, root: string): string {
  const safe = String(groupId).replace(/[/\\]/gu, '_') || 'unknown';
  return join(stateDir(root), 'heartbeat-receipts', `${safe}.json`);
}

/** R4 自己的 wake 记账文件（`state/heartbeat-wake-ledger.json`）。 */
function wakeLedgerFile(root: string): string {
  return join(stateDir(root), 'heartbeat-wake-ledger.json');
}

/** 桥存活心跳文件（扩展桥每轮扫描结束后写）。 */
function bridgeAliveFile(root: string): string {
  return join(stateDir(root), 'heartbeat-outbox', '.bridge-alive');
}

/** 读回执；缺失/损坏/状态非法 → null（不 warn：“没有回执”是常态）。 */
function readWakeReceipt(groupId: string, root: string): HeartbeatWakeReceipt | null {
  const raw = readJsonSafe<unknown>(wakeReceiptFile(groupId, root));
  if (!isPlainObject(raw)) return null;
  const status = raw.status;
  if (status !== 'injected' && status !== 'wake-failed') return null;
  const at = Number(raw.at);
  if (!Number.isFinite(at) || at <= 0) return null;
  return {
    at,
    status,
    id: String(raw.id ?? '').trim(),
    ...(typeof raw.via === 'string' ? { via: raw.via } : {}),
  };
}

/** 读记账；缺失/损坏 → 空账本（绝不抛错）。 */
function readWakeLedger(root: string): WakeLedger {
  const empty: WakeLedger = { version: 1, groups: {} };
  const raw = readJsonSafe<unknown>(wakeLedgerFile(root));
  if (!isPlainObject(raw) || !isPlainObject(raw.groups)) return empty;
  const groups: Record<string, WakeLedgerGroup> = {};
  for (const [groupId, value] of Object.entries(raw.groups)) {
    if (!groupId || !isPlainObject(value)) continue;
    const group: WakeLedgerGroup = {};
    if (isPlainObject(value.pending)) {
      const id = String(value.pending.id ?? '').trim();
      const at = Number(value.pending.at);
      const prev = Number(value.pending.prevLastBotMessageAt);
      if (id && Number.isFinite(at) && at > 0 && Number.isFinite(prev) && prev >= 0) {
        group.pending = { id, at, prevLastBotMessageAt: prev };
      }
    }
    const consumedId = String(value.consumedReceiptId ?? '').trim();
    if (consumedId) {
      group.consumedReceiptId = consumedId;
      const consumedAt = Number(value.consumedAt);
      if (Number.isFinite(consumedAt) && consumedAt > 0) group.consumedAt = consumedAt;
    }
    if (group.pending || group.consumedReceiptId) groups[groupId] = group;
  }
  return { version: 1, groups };
}

/** 原子写记账；失败 warn 并返回 false（不阻塞心跳主流程）。 */
function writeWakeLedger(root: string, ledger: WakeLedger, logger?: R4Logger): boolean {
  return writeJsonAtomic(wakeLedgerFile(root), ledger, logger);
}

/**
 * 读桥存活：`.bridge-alive` 不存在、损坏、或 `now - at > 30 秒` → 视为桥不在。
 * **永不抛错**。未来时间戳按存活处理（只可能是时钟抖动，不当作故障）。
 */
function readBridgeAlive(root: string, now: number): { alive: boolean; detail: string } {
  const raw = readJsonSafe<unknown>(bridgeAliveFile(root));
  if (!isPlainObject(raw)) return { alive: false, detail: '.bridge-alive 不存在或损坏' };
  const at = Number(raw.at);
  if (!Number.isFinite(at) || at <= 0) return { alive: false, detail: '.bridge-alive 里没有有效的 at' };
  const age = now - at;
  if (age > BRIDGE_ALIVE_STALE_MS) {
    return {
      alive: false,
      detail: `.bridge-alive 已 ${Math.round(age / 1000)} 秒未更新（阈值 ${BRIDGE_ALIVE_STALE_MS / 1000} 秒）`,
    };
  }
  return { alive: true, detail: '' };
}

/** 解析 `HH:MM` → 当天相对毫秒。 */
export function hhmmOf(value: string, fallback = '03:00'): { hour: number; minute: number } {
  const m = /^(\d{1,2}):(\d{2})$/u.exec(String(value ?? '').trim());
  if (!m) {
    const f = /^(\d{1,2}):(\d{2})$/u.exec(fallback)!;
    return { hour: Number(f[1]), minute: Number(f[2]) };
  }
  return { hour: Math.min(23, Math.max(0, Number(m[1]))), minute: Math.min(59, Math.max(0, Number(m[2]))), };
}

/** 今天是否已过 `run_daily_at`（Asia/Shanghai）。**永不抛错**（时区非法/时间戳非法 → false）。 */
export function isPastDailyRunAt(now: number, runDailyAt: string, timeZone = 'Asia/Shanghai'): boolean {
  const { hour, minute } = hhmmOf(runDailyAt);
  try {
    // ★ 2026-11-05（重构任务 A）：改用 time.ts 的共享格式化器（原来这里自己 new 一个）
    const t = zonedTime(now, timeZone);
    return t.hour > hour || (t.hour === hour && t.minute >= minute);
  } catch {
    return false;
  }
}

/** 毫秒到「下一个 run_daily_at」（用于定时器 delay）。**永不抛错**（异常 → 1 小时后重试）。 */
export function msUntilNextDailyRun(now: number, runDailyAt: string, timeZone = 'Asia/Shanghai'): number {
  const { hour, minute } = hhmmOf(runDailyAt);
  try {
    // ★ 2026-11-05（重构任务 A）：`secondsOfDay` 已内置秒分量，不再自造格式化器
    const todayMs = secondsOfDay(now, timeZone) * 1000;
    const targetMs = (hour * 3600 + minute * 60) * 1000;
    let delta = targetMs - todayMs;
    if (delta <= 0) delta += 24 * 3600 * 1000;
    return Math.max(1000, delta);
  } catch {
    return 60 * 60 * 1000;
  }
}

/**
 * 创建调度器。**不会自己启动定时器** —— 调用 `start()` 才开始（便于测试不跑真定时器）。
 *
 * ★ 2026-11-05 阶段 5：**节律可外置**（全部定时器集成到任务中心）。
 *
 * 主人要求「把定时器全部集成在一起，别的功能不用动」。因此这里的设计是
 * **只交节律、不交业务**：
 *   · `tickHeartbeatOnce` / `runExtractionOnce` 的**实现一个字没改**（业务照旧）；
 *   · 只多了一个可选参数 `externalDriver`：
 *     - **传了** → 本文件**不再自己排 setTimeout**，改为把这两个函数**登记**给任务中心，
 *       由 `任务中心/tasks.json` 里 `owner:'plugin'` 的两条任务驱动；
 *     - **没传**（缺省，测试/降级路径）→ 行为与之前**完全一致**（自我续排 setTimeout）。
 *   · 这样：插件源码仍可独立测试（不依赖扩展包），真机上则由统一调度器驱动。
 *
 * 心跳的随机抖动是拟人化命门（45±15 分钟**每次不同**，否则她每天在同样时刻开口）。
 * 引擎为此专门加了 `jitterMode:'random'` + 「执行后写下一轮承诺间隔」机制
 * （详见 `bnn-custom/lib/central-core.mjs` 里 jitterForTask / computeDue 的注释）。
 */
export function createScheduler(
  deps: { heartbeat: HeartbeatDeps; extraction: ExtractionDeps },
  externalDriver?: {
    /** 注册心跳执行器（返回注销函数；缺省无操作）。 */
    registerHeartbeat: (fn: () => Promise<unknown>) => void;
    /** 注册提取执行器。 */
    registerExtraction: (fn: () => Promise<unknown>) => void;
  },
): SchedulerHandle & { start: () => void } {
  const hbLogger = deps.heartbeat.logger;
  const exLogger = deps.extraction.logger;
  const nowFn = () => (deps.heartbeat.now ? deps.heartbeat.now() : Date.now());
  const randomFn = () => (deps.heartbeat.random ? deps.heartbeat.random() : Math.random());

  let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
  let extractionTimer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let running = false;
  /** 心跳单轮重入锁（2026-11-03 修复 P2-10）：定时器与手动 tick 并发会重复发送。 */
  let ticking = false;

  /**
   * 已消费回执 id（**进程内兜底**）：即使记账写盘失败，同一进程里也不会重复回滚。
   * 跨重启的去重靠 `heartbeat-wake-ledger.json` 的 `consumedReceiptId`。
   */
  const recoveredReceiptIds = new Set<string>();

  /** 「桥未存活」warn 节流（groupId → 上次 warn 的 now）。 */
  const aliveWarnAt = new Map<string, number>();

  /**
   * ★ 2026-11-05：消费上一次 wake 的投递回执，失败则回滚假成功。
   *
   * 背景（本 bug 的根因）：
   *   `sendWake` 返回 true 只代表「outbox 文件写成功」= **已入队**，不是已送达。
   *   真正的投递在扩展桥里；`caps.wakeTo` 在会话被回收（群安静 >30 分钟）时必失败，
   *   桥只会写 `status:'wake-failed'` 的 receipt 并删 outbox 文件，R4 毫不知情 →
   *   配额被假成功吃掉、`lastBotMessageAt` 记成「她刚说过话」（wake prompt 会带着这个
   *   错误事实去骗 agent「你上次说话是 XX:XX」）。
   *
   * 回滚规则：
   *   · 只看 `wake-failed`；`injected` 是成功，什么都不做。
   *   · 只回滚有效期内（覆盖一整轮心跳间隔，见 `wakeReceiptTtlMs`）的回执，
   *     且同一回执 id **只回滚一次**（记账 + 进程内 Set 双保险）。
   *   · `dailyCount = max(0, dailyCount - 1)`；`lastBotMessageAt` 只有拿到「入队前」的
   *     旧值、且状态里仍是入队时写的假时间才恢复 —— 绝不写 0、绝不覆盖后来的真实发言。
   *
   * **任何异常都不能阻塞心跳主流程**：读失败就按「没有回执」处理。
   */
  const recoverWakeReceipt = (groupId: string, state: HeartbeatState, now: number): HeartbeatState => {
    let receipt: HeartbeatWakeReceipt | null = null;
    try {
      receipt = readWakeReceipt(groupId, deps.heartbeat.root);
    } catch {
      return state;
    }
    if (!receipt || receipt.status !== 'wake-failed') return state;
    const id = receipt.id;
    // 没有 id 就无法幂等去重 → 宁可少回滚一次，也不能每轮重复扣配额。
    if (!id) return state;
    const age = now - receipt.at;
    // 有效期按配置推导（见 `wakeReceiptTtlMs`）：要覆盖「一整轮最长心跳间隔」，
    // 否则回执还没等到下一次 tick 就过期，回滚永远不发生。
    const ttl = wakeReceiptTtlMs(deps.heartbeat.config);
    if (!Number.isFinite(age) || age < -WAKE_RECEIPT_FUTURE_SLACK_MS || age > ttl) return state;
    const ledger = readWakeLedger(deps.heartbeat.root);
    const group = ledger.groups[groupId];
    if (group?.consumedReceiptId === id || recoveredReceiptIds.has(id)) return state;
    const before = Math.max(0, Math.round(Number(state.dailyCount) || 0));
    const next: HeartbeatState = { ...state, dailyCount: Math.max(0, before - 1) };
    let restoredLastBot = false;
    if (group?.pending && group.pending.id === id) {
      // 只在状态里仍是「入队时写的那个假时间」时恢复：这期间她若真的说过话，
      // `lastBotMessageAt` 已被真实发送更新过，覆盖它等于抹掉真相。
      if (Math.round(Number(state.lastBotMessageAt) || 0) === Math.round(group.pending.at)) {
        next.lastBotMessageAt = group.pending.prevLastBotMessageAt;
        restoredLastBot = true;
      }
    }
    if (!writeHeartbeat(groupId, next, deps.heartbeat.root, hbLogger)) {
      logWarn(hbLogger, `[r4] 心跳：${groupId} wake 投递失败，但回滚状态写盘失败 → 下一轮重试`);
      return state;
    }
    // ★「已消费」标记必须存在 R4 自己的记账里：桥的 receipt 每群只有一份、会被覆盖写。
    const nextGroup: WakeLedgerGroup = { consumedReceiptId: id, consumedAt: now };
    // 如果这期间又入队了**新**的一批 wake，它的 pending 不能被这条旧回执抹掉。
    if (group?.pending && group.pending.id !== id) nextGroup.pending = group.pending;
    const ledgerOk = writeWakeLedger(
      deps.heartbeat.root,
      { version: 1, groups: { ...ledger.groups, [groupId]: nextGroup } },
      hbLogger,
    );
    if (!ledgerOk) {
      logWarn(hbLogger, `[r4] 心跳：${groupId} wake 回执已回滚，但「已消费」标记写盘失败 → 重启后可能重复回滚一次（本进程已防重）`);
    }
    recoveredReceiptIds.add(id);
    logWarn(
      hbLogger,
      `[r4] 心跳：${groupId} wake 投递失败 → 已回滚 dailyCount（${before} → ${next.dailyCount}）`
      + `${restoredLastBot ? '，lastBotMessageAt 已恢复到入队前' : ''}（回执 id=${id}）`,
    );
    return next;
  };

  /**
   * wake 入队成功后记 pending：回滚 `lastBotMessageAt` 需要「入队前」的旧值。
   * 记账失败只 warn —— 那条心跳仍然算成功入队，不能因为记账问题卡住主流程。
   */
  const recordWakePending = (groupId: string, payload: HeartbeatWakePayload, prevLastBotMessageAt: number): void => {
    try {
      const ledger = readWakeLedger(deps.heartbeat.root);
      const prev = Math.max(0, Math.round(Number(prevLastBotMessageAt) || 0));
      const next: WakeLedger = {
        version: 1,
        groups: {
          ...ledger.groups,
          [groupId]: {
            ...ledger.groups[groupId],
            pending: { id: payload.id, at: payload.at, prevLastBotMessageAt: prev },
          },
        },
      };
      if (!writeWakeLedger(deps.heartbeat.root, next, hbLogger)) {
        logWarn(hbLogger, `[r4] 心跳：${groupId} wake 已入队，但 pending 记账写盘失败（失败回执只回滚 dailyCount、不动 lastBotMessageAt）`);
      }
    } catch (error) {
      logWarn(hbLogger, `[r4] 心跳：${groupId} wake pending 记账异常（已忽略）：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  /**
   * 心跳单轮：**逐群** tick；每群独立 try-catch。
   *
   * 写盘顺序（2026-11-03 修复 P0-1，与图纸 2.4 一致）：
   *   ① 生成内容成功 → ② 原子写 `waiting`（写成功才继续）→ ③ 发送 → ④ 发送失败回滚。
   * 生成失败/无发送能力 → **完全不写状态**（不计数、不进入 waiting）。
   */
  const tickHeartbeatOnce = async (): Promise<HeartbeatTickReport[]> => {
    const reports: HeartbeatTickReport[] = [];
    if (ticking) {
      logWarn(hbLogger, '[r4] 心跳：上一轮尚未结束 → 本次 tick 跳过（防重入）');
      return reports;
    }
    ticking = true;
    try {
      const config = deps.heartbeat.config;
      const root = deps.heartbeat.root;
      const now = nowFn();
      const date = dayKeyOf(now, config.timezone || 'Asia/Shanghai');
      let groups: string[] = [];
      try {
        groups = deps.heartbeat.listGroups();
      } catch (error) {
        logWarn(hbLogger, `[r4] 心跳：列出群失败（已跳过）：${error instanceof Error ? error.message : String(error)}`);
        return reports;
      }
      // ★ 2026-11-04 心跳白名单：`heartbeat_config.enabled_groups` 非空时**只处理名单内的群**。
      //   缺省/空数组 = 全部群参与（行为与之前一致）。
      //   为什么放在循环最前：名单外的群**连 generate（模型调用）都不会发生** ——
      //   这对「QQ 主动消息权限没开」的群很重要，否则每轮都白烧一次 deepseek-flash 调用
      //   （发送必被平台拒 40034105，然后回滚，模型成本却退不回来）。
      const allowList = Array.isArray(deps.heartbeat.config.heartbeat_config?.enabled_groups)
        ? deps.heartbeat.config.heartbeat_config.enabled_groups.filter((g) => typeof g === 'string' && g.trim()).map((g) => g.trim())
        : [];
      for (const groupId of groups) {
        try {
          if (allowList.length > 0 && !allowList.includes(groupId)) {
            reports.push({ groupId, skipped: true, reason: '不在心跳白名单内（跳过，不调模型）', sent: false, queued: false, delivered: false, dailyCount: 0 });
            continue;
          }
          const stateBefore = readHeartbeat(groupId, root, hbLogger);
          // ★ mode 先解析（纯函数、零 IO）：回执回滚与桥存活判定都按它分派。
          //   原先 mode 在 evaluate 之后才算，要读回执就必须提前。
          const mode = resolveGenerationMode(config, groupId);
          // ★ 2026-11-05 心跳账目修复：每个群处理前，先消费「上一次 wake 的投递结果」。
          //   桥写 receipt 只代表「它尝试过」；R4 在这里才知道真结果（成功/失败）。
          //   wake 失败 → 撤回那次假成功（dailyCount、lastBotMessageAt）。
          const state = recoverWakeReceipt(groupId, stateBefore, now);
          // ★ 2026-11-05 桥存活检测：wake 模式的唯一通道是扩展桥的 outbox。
          //   桥没加载（或挂了）时继续 tick = 白扣配额 + 写假状态（wake 文件永远没人读），
          //   所以本轮直接跳过：不生成、不计数、不进 waiting。
          if (mode === 'wake') {
            const alive = readBridgeAlive(root, now);
            if (!alive.alive) {
              const lastWarn = aliveWarnAt.get(groupId) ?? 0;
              if (!(now - lastWarn < BRIDGE_ALIVE_WARN_MS)) {
                aliveWarnAt.set(groupId, now);
                logWarn(hbLogger, `[r4] 心跳：${groupId} 扩展桥未存活（${alive.detail}）→ 本次跳过心跳（不生成、不计数、不进 waiting）`);
              }
              reports.push({ groupId, skipped: true, reason: `扩展桥未存活（${alive.detail}）→ 跳过（不计数）`, sent: false, queued: false, delivered: false, dailyCount: state.dailyCount });
              continue;
            }
          }
          const messages = deps.heartbeat.readMessages(groupId);
          // 2026-11-04：把 `dead_group_hours` 传给判定层（原先 evaluate 只用硬编码 2h，
          // 低活跃群永远被判死群、心跳一次都发不出去）。不配置时该字段为 undefined，
          // evaluate 内部回落 DEFAULT_DEAD_GROUP_HOURS=2 → 与旧行为完全一致。
          const verdict = deps.heartbeat.evaluate({
            groupId, state, now, date, messages,
            deadGroupHours: config.heartbeat_config?.dead_group_hours,
          });
          // ① 只有「不发送、但有状态迁移」（跨天重置 / 到期迁移 / 脏数据兜底）才在这里写盘。
          if (verdict.changed && !verdict.shouldSend) {
            const wrote = writeHeartbeat(groupId, verdict.next, root, hbLogger);
            if (!wrote) {
              logWarn(hbLogger, `[r4] 心跳：${groupId} 状态写盘失败 → 本群跳过`);
              reports.push({ groupId, skipped: true, reason: '状态写盘失败', sent: false, queued: false, delivered: false, dailyCount: state.dailyCount });
              continue;
            }
          }
          if (!verdict.shouldSend) {
            reports.push({ groupId, skipped: true, reason: verdict.skipReason ?? '无需发送', sent: false, queued: false, delivered: false, dailyCount: verdict.next.dailyCount });
            continue;
          }
          // ② 先决定「这条到底能不能发」再动状态：生成 → 发送能力检查。
          //    ★ 2026-11-05 四处必改之①（共享契约 §4）：能力判定不能只看 `send`。
          const sendDirect = deps.heartbeat.send;
          const sendWake = deps.heartbeat.sendWake;
          if (!sendDirect && !sendWake) {
            logInfo(hbLogger, `[r4] 心跳：${groupId} 无发送能力（未接线）→ 跳过、不计数、不进 waiting`);
            reports.push({ groupId, skipped: true, reason: '无发送能力（未接线）', sent: false, queued: false, delivered: false, dailyCount: state.dailyCount });
            continue;
          }
          // 该模式的通道没接线 → 跳过、**不调模型**，也绝不拿 legacy 正文硬发 wake 群。
          // （`mode` 已在循环开头解析：回执回滚 / 桥存活判定都要用它。）
          if (mode === 'wake' && !sendWake) {
            logWarn(hbLogger, `[r4] 心跳：${groupId} 配置为 wake 模式但未接线 sendWake → 跳过（不计数、不进 waiting）`);
            reports.push({ groupId, skipped: true, reason: 'wake 模式未接线 sendWake', sent: false, queued: false, delivered: false, dailyCount: state.dailyCount });
            continue;
          }
          if (mode === 'legacy' && !sendDirect) {
            logInfo(hbLogger, `[r4] 心跳：${groupId} 配置为 legacy 模式但未接线 send → 跳过（不计数、不进 waiting）`);
            reports.push({ groupId, skipped: true, reason: 'legacy 模式未接线 send', sent: false, queued: false, delivered: false, dailyCount: state.dailyCount });
            continue;
          }
          let generated: HeartbeatDraft | null = null;
          try {
            // wake prompt 要用「她上次说话 / 群里最后一条真人消息」——
            // 这两者只有 heartbeat state 有（bot 自己的发言不在 messages 里，硬阻塞 #3）。
            generated = await deps.heartbeat.generate({
              groupId,
              messages,
              now,
              lastBotMessageAt: state.lastBotMessageAt,
              lastNonBotMessageAt: state.lastNonBotMessageAt,
            });
          } catch (error) {
            // 生成抛错 = 生成失败（2026-11-03 修复 P0-1）：**不写状态、不计费**，但要留报告。
            logWarn(hbLogger, `[r4] 心跳：${groupId} 生成抛错（已跳过，不计数、不进 waiting）：${error instanceof Error ? error.message : String(error)}`);
            reports.push({ groupId, skipped: true, reason: '生成抛错或空返回', sent: false, queued: false, delivered: false, dailyCount: state.dailyCount });
            continue;
          }
          // ★ 2026-11-05 四处必改之②：`wakePrompt` 非空时不能算"生成失败"。
          if (!generated || (!String(generated.text ?? '').trim() && !String(generated.wakePrompt ?? '').trim())) {
            logInfo(hbLogger, `[r4] 心跳：${groupId} 生成失败/空返回 → 跳过、不计数、不进 waiting`);
            reports.push({ groupId, skipped: true, reason: '生成失败或空返回', sent: false, queued: false, delivered: false, dailyCount: state.dailyCount });
            continue;
          }
          // ★ 2026-11-05 四处必改之③：分派必须在写 waiting **之前**定死，
          //   否则「内容与模式不匹配」会白扣一次日配额。
          const wakePrompt = String(generated.wakePrompt ?? '').trim();
          // legacy 发送保留原文（不做 trim，与改造前行为完全一致）；trim 只用于"是否为空"判定。
          const rawText = String(generated.text ?? '');
          const hasText = rawText.trim().length > 0;
          const useWake = mode === 'wake' && !!sendWake && !!wakePrompt;
          const useDirect = !useWake && !!sendDirect && hasText;
          if (!useWake && !useDirect) {
            logWarn(hbLogger, `[r4] 心跳：${groupId} 生成内容与模式不匹配（mode=${mode}，无可用通道/正文）→ 跳过、不计数、不进 waiting`);
            reports.push({ groupId, skipped: true, reason: '生成内容与模式不匹配', sent: false, queued: false, delivered: false, dailyCount: state.dailyCount });
            continue;
          }
          // ③ 生成成功 → 原子写 waiting（**写成功才允许发送 / 入队**）。
          const waiting = writeHeartbeat(groupId, verdict.next, root, hbLogger);
          if (!waiting) {
            logWarn(hbLogger, `[r4] 心跳：${groupId} waiting 状态写盘失败 → 不发送（防重复）`);
            reports.push({ groupId, skipped: true, reason: 'waiting 写盘失败', sent: false, queued: false, delivered: false, dailyCount: state.dailyCount });
            continue;
          }
          // ④ 分派：wake → 写 outbox（只是**入队**，不是已送达）；legacy → 真实发送。
          let ok = false;
          if (useWake) {
            const payload: HeartbeatWakePayload = {
              id: `${groupId}-${now}-${newWakeRand4()}`,
              groupId,
              // 契约：老桥 `if (!text) return null` 会整条丢弃 —— text 必须**永远写**（wake 模式为空串）。
              text: rawText,
              ...(wakePrompt ? { wakePrompt } : {}),
              at: now,
            };
            try {
              ok = await sendWake!(payload);
            } catch (error) {
              logWarn(hbLogger, `[r4] 心跳：${groupId} wake 入队抛错 → 视为失败：${error instanceof Error ? error.message : String(error)}`);
              ok = false;
            }
            if (ok) {
              // ★ 记账：只有记下「入队前的 lastBotMessageAt」，将来 wake-failed 回执到达时
              //   才能把假时间恢复回去（拿不到旧值就只回滚 dailyCount，绝不写 0）。
              recordWakePending(groupId, payload, state.lastBotMessageAt);
            }
          } else {
            ok = await sendDirect!(groupId, rawText);
          }
          if (ok) {
            if (useWake) {
              // wake 成功 = **已入队**；真正投递与"说不说"由扩展桥 + agent 决定。
              logInfo(hbLogger, `[r4] 心跳：${groupId} wake 指令已入队（等待扩展桥注入，非已送达；tag=${generated.tag ?? '未标注'}，当日 ${verdict.next.dailyCount}/${config.heartbeat_config.max_daily}）`);
              reports.push({ groupId, skipped: false, sent: false, queued: true, delivered: false, dailyCount: verdict.next.dailyCount });
            } else {
              logInfo(hbLogger, `[r4] 心跳：${groupId} 已发送（tag=${generated.tag ?? '未标注'}，当日 ${verdict.next.dailyCount}/${config.heartbeat_config.max_daily}）`);
              reports.push({ groupId, skipped: false, sent: true, queued: true, delivered: true, dailyCount: verdict.next.dailyCount });
            }
          } else {
            // 回滚：以「发送前的 state」为底，只撤销 waiting 那一步（合并，不整份覆写）。
            // ★ 契约 §4：sendWake 返回 false 也走**这同一条**回滚分支（不另起一套语义）。
            const rollback: HeartbeatState = {
              ...state,
              date: verdict.next.date,
              dailyCount: Math.max(0, Number(verdict.next.dailyCount) - 1),
              state: 'normal',
              waitingUntil: 0,
            };
            const rolled = writeHeartbeat(groupId, rollback, root, hbLogger);
            logWarn(hbLogger, `[r4] 心跳：${groupId} ${useWake ? 'wake 入队失败' : '发送失败'} → 已回滚（${rolled ? 'ok' : '回滚写盘失败'}）`);
            reports.push({ groupId, skipped: false, reason: `${useWake ? 'wake 入队失败' : '发送失败'}已回滚`, sent: false, queued: false, delivered: false, dailyCount: rollback.dailyCount });
          }
        } catch (error) {
          logWarn(hbLogger, `[r4] 心跳：${groupId} tick 异常（已跳过）：${error instanceof Error ? error.message : String(error)}`);
        }
      }
      return reports;
    } finally {
      ticking = false;
    }
  };

  /** 提取单轮：每天 `run_daily_at` 后跑一次；`lastRunDate == 今天` 跳过；失败也写今天。 */
  const runExtractionOnce = async (): Promise<ExtractionRunReport> => {
    const config = deps.extraction.config;
    const root = deps.extraction.root;
    const now = nowFn();
    const date = dayKeyOf(now, config.timezone || 'Asia/Shanghai');
    const empty: ExtractionRunReport = { date, skipped: false, groups: 0, notes: [], failed: false };

    try {
      const state = readExtractionState(root, exLogger);
      if (state.lastRunDate === date) {
        logInfo(exLogger, `[r4] 提取：今天（${date}）已跑过 → 跳过`);
        return { ...empty, skipped: true, notes: ['今天已跑过'] };
      }
      let groups: string[] = [];
      try { groups = deps.extraction.listGroups(); } catch (error) {
        logWarn(exLogger, `[r4] 提取：列出群失败：${error instanceof Error ? error.message : String(error)}`);
      }
      const notes: string[] = [];
      let totalTags = 0;
      for (const groupId of groups) {
        try {
          const messages = deps.extraction.readMessages(groupId, config.extraction_config.max_messages_per_day);
          if (messages.length === 0) {
            notes.push(`${groupId}: 无语料`);
            continue;
          }
          const result = await deps.extraction.extract({ groupId, messages });
          totalTags += result?.accepted ?? 0;
          notes.push(`${groupId}: ${result?.accepted ?? 0} tag`);
        } catch (error) {
          notes.push(`${groupId}: 失败（已跳过）`);
          logWarn(exLogger, `[r4] 提取：${groupId} 失败（已跳过，不阻塞其它群）：${error instanceof Error ? error.message : String(error)}`);
        }
      }
      // 成功也写、失败也写（图纸 4.3：失败不自动重试，次日再跑）
      writeExtractionState({ lastRunDate: date }, root, exLogger);
      logInfo(exLogger, `[r4] 提取：${date} 完成，${groups.length} 个群 / ${totalTags} 个 tag`);
      return { ...empty, groups: groups.length, notes };
    } catch (error) {
      logWarn(exLogger, `[r4] 提取：整体异常（已记录 lastRunDate 并跳过，不重试）：${error instanceof Error ? error.message : String(error)}`);
      writeExtractionState({ lastRunDate: date }, root, exLogger);
      return { ...empty, failed: true, notes: ['整体异常'] };
    }
  };

  /** 心跳定时器自我续排。 */
  const scheduleHeartbeat = (): void => {
    if (stopped) return;
    const delay = nextIntervalMs(deps.heartbeat.config.heartbeat_config, randomFn);
    heartbeatTimer = setTimeout(() => {
      void (async () => {
        try { await tickHeartbeatOnce(); } catch (error) {
          logWarn(hbLogger, `[r4] 心跳：定时轮异常（已忽略）：${error instanceof Error ? error.message : String(error)}`);
        } finally {
          scheduleHeartbeat();
        }
      })();
    }, delay);
    heartbeatTimer.unref?.();
  };

  /** 提取定时器自我续排（每天一次）。 */
  const scheduleExtraction = (): void => {
    if (stopped) return;
    const delay = msUntilNextDailyRun(nowFn(), deps.extraction.config.extraction_config.run_daily_at, deps.extraction.config.timezone);
    extractionTimer = setTimeout(() => {
      void (async () => {
        try { await runExtractionOnce(); } catch (error) {
          logWarn(exLogger, `[r4] 提取：定时轮异常（已忽略）：${error instanceof Error ? error.message : String(error)}`);
        } finally {
          scheduleExtraction();
        }
      })();
    }, delay);
    extractionTimer.unref?.();
  };

  return {
    get running() { return running; },
    start: () => {
      if (running || stopped) return;
      running = true;
      /**
       * ★ 2026-11-05 阶段 5：有外部驱动 → 只登记、不自己排定时器。
       *
       * 注意这里**没有**「启动时先跑一次」——因为两个 hook/执行器在任务中心里的
       * 启动补偿（`catchUpOnStart`）会处理「今天/这一轮漏跑」的情况；
       * 而且 `runExtractionOnce` 内部本来就有 `lastRunDate === date → 跳过` 的判据，
       * 多跑一次也不会重复提取。心跳 `tickHeartbeatOnce` 同理有重入锁 + 状态机保护。
       */
      if (externalDriver) {
        externalDriver.registerHeartbeat(() => tickHeartbeatOnce());
        externalDriver.registerExtraction(() => runExtractionOnce());
        logInfo(
          hbLogger,
          `[r4] 调度器已登记到任务中心（节律由 任务中心/tasks.json 驱动）：`
          + `心跳 ${deps.heartbeat.config.heartbeat_config.interval_minutes}`
          + `±${deps.heartbeat.config.heartbeat_config.jitter_minutes} 分钟（随机抖动）`
          + ` / 提取每天 ${deps.extraction.config.extraction_config.run_daily_at}`,
        );
        return;
      }
      // 无外部驱动（测试/降级）→ 保持原行为：自我续排 setTimeout
      scheduleHeartbeat();
      scheduleExtraction();
      logInfo(hbLogger, `[r4] 调度器已启动：心跳 ${deps.heartbeat.config.heartbeat_config.interval_minutes}±${deps.heartbeat.config.heartbeat_config.jitter_minutes} 分钟 / 提取每天 ${deps.extraction.config.extraction_config.run_daily_at}`);
    },
    tickHeartbeatOnce,
    runExtractionOnce,
    stop: () => {
      if (stopped) return;
      stopped = true;
      running = false;
      try { if (heartbeatTimer) clearTimeout(heartbeatTimer); } catch { /* ignore */ }
      try { if (extractionTimer) clearTimeout(extractionTimer); } catch { /* ignore */ }
      heartbeatTimer = undefined;
      extractionTimer = undefined;
      logInfo(hbLogger, '[r4] 调度器已停止');
    },
  };
}
