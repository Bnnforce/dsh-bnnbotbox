/**
 * memory-recall-host — 宿主侧「记忆联想」适配器（2026-11-08）
 *
 * 职责边界：
 *   · `r4/memory-recall/*` = 纯逻辑（无 cordis、无文件系统写、可单测）；
 *   · **本文件** = 把 cordis 服务 `qqMemory`、插件配置、诊断落盘接起来，
 *     交给 `R4MountDeps.getMemoryRecall` 一个 `(groupId, userId) => string`。
 *
 * 三重防御（记忆插件是**另一个插件**，可缺席 / 版本不匹配 / 内部报错）：
 *   ① `ctx.get('qqMemory')` 本身可能抛 → try/catch；
 *   ② 服务对象可能没有 `list`/`read` → 结构检查；
 *   ③ 任何一次读盘/解析异常 → 降级为空串，本轮不注入。
 *
 * 缓存：`PersonCardIndex` 实例**跨轮共享**（TTL 5 分钟），避免每条消息都扫目录。
 *
 * 诊断：`<dsh-data>/dsh-anti-ai-persona/memory-recall.log`，超 256KB 轮转到 `.1`。
 *   ★ 节流：assemble 每轮都会调，**不能**每轮写一行 —— 只在「结果变化」或
 *     超过 `LOG_MIN_INTERVAL_MS` 时写一次，失败也只记一次/分钟。
 */

import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { buildMemoryRecall, MEMORY_RECALL_DEFAULTS, type MemoryRecallConfig } from './r4/memory-recall/index.js';
import { PersonCardIndex, type MemoryServiceLike } from './r4/memory-recall/person-card.js';

/** 记忆服务最小可选面（cordis `qqMemory` 的实现细节不在这里耦合）。 */
type MaybeService = Partial<MemoryServiceLike> | undefined | null;

export interface MemoryRecallHostDeps {
  /** 插件 logger。 */
  logger?: { info?: (m: string) => void; warn?: (m: string) => void };
  /** 取记忆服务（每次调用都取一次 —— 服务可能晚于本插件挂载，不能缓存 undefined）。 */
  getService: () => unknown;
  /** 配置（缺省走 MEMORY_RECALL_DEFAULTS）。 */
  config?: Partial<MemoryRecallConfig> | undefined;
  /** 当前时间（测试注入）。 */
  now?: () => number;
  /** 诊断落盘目录（缺省 `<DSH_HOME>/data/dsh-anti-ai-persona`）。 */
  diagDir?: string;
}

export interface MemoryRecallHost {
  /** 供 `R4MountDeps.getMemoryRecall` 使用。 */
  recall: (groupId: string, userId: string) => string;
  /**
   * 第二层「主动惦记」用：openid → 本群显示名（读人物卡，命中 recall 的同一份缓存）。
   * @returns 显示名；没有档案 / 服务不可用 → 空串
   */
  personName: (groupId: string, userId: string) => string;
  /**
   * 第二层「主动惦记」用：本群生日清单（`events/birthdays/MM-DD-名.md`）。
   * @returns `[{ name, month, day }]`；读不到 → 空数组
   */
  birthdays: (groupId: string) => Array<{ name: string; month: number; day: number }>;
  /** 诊断快照（运维/测试）。 */
  diagnostics: () => Record<string, unknown>;
}

/** 诊断轮转阈值（与 life-stream.log 保持一致）。 */
const LOG_ROTATE_BYTES = 256 * 1024;
/** 同一 key 的诊断最小间隔（毫秒）—— 防止每条消息写一行。 */
const LOG_MIN_INTERVAL_MS = 5 * 60 * 1000;
/** 缓存目录上限（人多时也只留最近这些 key 的日志节流状态）。 */
const LOG_STATE_MAX = 200;

const LOG_FILE = 'memory-recall.log';

/** 归一化配置：全部走默认值兜底，非法数字一律回落（**零魔法数字**）。 */
export function normalizeMemoryRecallConfig(raw?: Partial<MemoryRecallConfig> | undefined): MemoryRecallConfig {
  const d = MEMORY_RECALL_DEFAULTS;
  const n = (v: unknown, fallback: number, min: number, max: number): number => {
    const num = typeof v === 'number' ? v : Number(v);
    if (!Number.isFinite(num)) return fallback;
    return Math.min(max, Math.max(min, Math.round(num)));
  };
  return {
    enabled: raw?.enabled !== false,
    budgetChars: n(raw?.budgetChars, d.budgetChars, 40, 700),
    personChars: n(raw?.personChars, d.personChars, 20, 300),
    groupChars: n(raw?.groupChars, d.groupChars, 10, 200),
    eventsChars: n(raw?.eventsChars, d.eventsChars, 20, 300),
    recentDays: n(raw?.recentDays, d.recentDays, 1, 30),
    cacheTtlMs: n(raw?.cacheTtlMs, d.cacheTtlMs, 10_000, 60 * 60 * 1000),
    maxPersonFiles: n(raw?.maxPersonFiles, d.maxPersonFiles, 1, 200),
    maxEvents: n(raw?.maxEvents, d.maxEvents, 0, 10),
  };
}

/** 记忆 scope 的唯一构造点（与 dsh-qq-memory 的 scope 约定保持一致）。 */
function scopeOf(groupId: string): unknown {
  return { type: 'group', id: groupId };
}

/** 结构检查：服务存在且真的具备 list/read（版本不匹配时可能就是空对象）。 */
function usableService(raw: unknown): MemoryServiceLike | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const svc = raw as MaybeService;
  if (typeof svc?.list !== 'function' || typeof svc?.read !== 'function') return undefined;
  return svc as MemoryServiceLike;
}

/** 诊断目录解析。 */
function resolveDiagDir(explicit?: string): string {
  if (explicit && explicit.trim()) return explicit.trim();
  return join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'data', 'dsh-anti-ai-persona');
}

/** 生日文件名：`events/birthdays/MM-DD-昵称.md`（实测格式）。 */
const BIRTHDAY_FILE_RE = /^events\/birthdays\/(\d{2})-(\d{2})-(.+)\.md$/u;

/**
 * 创建宿主侧记忆联想适配器。
 *
 * 返回值**永不抛错**：任何情况下 `recall()` 都返回字符串（最差是空串）。
 */
export function createMemoryRecallHost(deps: MemoryRecallHostDeps): MemoryRecallHost {
  const logger = deps.logger ?? {};
  const cfg = normalizeMemoryRecallConfig(deps.config);
  const now = deps.now ?? (() => Date.now());
  const diagDir = resolveDiagDir(deps.diagDir);

  /** 跨轮共享的人物索引（缓存就靠它，绝不能每次 new）。 */
  const personIndex = new PersonCardIndex({
    cacheTtlMs: cfg.cacheTtlMs,
    perItemChars: cfg.personChars,
    maxFiles: cfg.maxPersonFiles,
    logger,
  });

  interface LogState { text: string; at: number }
  const logState = new Map<string, LogState>();

  const writeDiag = (event: string, data: Record<string, unknown>): void => {
    try {
      mkdirSync(diagDir, { recursive: true });
      const file = join(diagDir, LOG_FILE);
      try {
        if (statSync(file).size > LOG_ROTATE_BYTES) {
          try { renameSync(file, `${file}.1`); } catch { /* ignore */ }
        }
      } catch { /* 文件不存在 → 不轮转 */ }
      appendFileSync(file, `${JSON.stringify({ at: new Date(now()).toISOString(), event, ...data })}\n`, 'utf8');
    } catch { /* 诊断失败绝不影响主链 */ }
  };

  /** 节流后的诊断（结果未变且未超时 → 不写）。 */
  const diagThrottled = (key: string, event: string, data: Record<string, unknown>): void => {
    try {
      const sentinel = `${event}|${JSON.stringify(data)}`;
      const prev = logState.get(key);
      const at = now();
      if (prev && prev.text === sentinel && at - prev.at < LOG_MIN_INTERVAL_MS) return;
      if (logState.size > LOG_STATE_MAX && !logState.has(key)) {
        // 超上限：清掉最旧的一半（Map 迭代序 = 插入序，够用）
        let drop = Math.floor(logState.size / 2);
        for (const k of logState.keys()) {
          if (drop-- <= 0) break;
          logState.delete(k);
        }
      }
      logState.set(key, { text: sentinel, at });
      writeDiag(event, data);
    } catch { /* ignore */ }
  };

  const stats = { calls: 0, injected: 0, empty: 0, failed: 0 };
  let lastPresent: { person: boolean; group: boolean; events: number } = { person: false, group: false, events: 0 };

  const recall = (groupId: string, userId: string): string => {
    stats.calls += 1;
    try {
      if (!cfg.enabled) return '';
      const gid = String(groupId ?? '').trim();
      if (!gid) return ''; // 拿不到群号（Web 会话等）→ 不注入

      // ① 取服务（可能晚挂载 → 每次现取）
      let raw: unknown;
      try {
        raw = deps.getService();
      } catch (err) {
        stats.failed += 1;
        diagThrottled('service', 'recall:fail', { reason: 'get-service', err: String(err) });
        return '';
      }
      // ② 结构检查
      const service = usableService(raw);
      if (!service) {
        stats.empty += 1;
        diagThrottled('service', 'recall:skip', { reason: raw ? 'bad-service' : 'no-service' });
        return '';
      }

      const result = buildMemoryRecall({
        service,
        scope: scopeOf(gid),
        userId: String(userId ?? '').trim(),
        now: now(),
        config: cfg,
        personIndex,
        logger,
        // buildMemoryRecall 内部只报事件名，这里统一加节流 + 落盘
        diag: (event, data) => diagThrottled(`diag:${gid}:${event}`, event, { gid, ...data }),
      });

      lastPresent = result.present;
      if (!result.text) {
        stats.empty += 1;
        return '';
      }
      stats.injected += 1;
      diagThrottled(
        `ok:${gid}:${userId}`,
        'recall:hit',
        { gid, uid: String(userId ?? '').trim(), used: result.used, ...result.present },
      );
      return result.text;
    } catch (err) {
      stats.failed += 1;
      diagThrottled('unexpected', 'recall:fail', { reason: 'unexpected', err: String(err) });
      logger.warn?.(`[memory-recall] 宿主适配异常（已降级为空）：${err instanceof Error ? err.message : String(err)}`);
      return '';
    }
  };

  /**
   * openid → 显示名（第二层用）。
   *
   * ★ 与 recall 共用 personIndex 缓存：本群最近说过话的人通常刚被 recall 查过，
   *   这里基本是**零 IO**。
   */
  const personName = (groupId: string, userId: string): string => {
    try {
      if (!cfg.enabled) return '';
      const gid = String(groupId ?? '').trim();
      const uid = String(userId ?? '').trim();
      if (!gid || !uid) return '';
      let raw: unknown;
      try { raw = deps.getService(); } catch { return ''; }
      const service = usableService(raw);
      if (!service) return '';
      return personIndex.findName(service, scopeOf(gid), uid, now());
    } catch (err) {
      stats.failed += 1;
      diagThrottled('name', 'name:fail', { err: String(err) });
      return '';
    }
  };

  /** 本群生日清单（第二层用）。 */
  const birthdays = (groupId: string): Array<{ name: string; month: number; day: number }> => {
    try {
      const gid = String(groupId ?? '').trim();
      if (!gid) return [];
      let raw: unknown;
      try { raw = deps.getService(); } catch { return []; }
      const service = usableService(raw);
      if (!service) return [];
      const listed = service.list(scopeOf(gid), 'events');
      if (!listed?.ok || !Array.isArray(listed.files)) return [];
      const out: Array<{ name: string; month: number; day: number }> = [];
      for (const rel of listed.files) {
        if (typeof rel !== 'string') continue;
        const m = BIRTHDAY_FILE_RE.exec(rel);
        if (!m) continue;
        const month = Number(m[1]);
        const day = Number(m[2]);
        const name = String(m[3] ?? '').replace(/^群成员[-_\s]*/u, '').trim();
        if (!name || !(month >= 1 && month <= 12) || !(day >= 1 && day <= 31)) continue;
        out.push({ name, month, day });
      }
      return out;
    } catch (err) {
      diagThrottled('birthdays', 'birthday:fail', { err: String(err) });
      return [];
    }
  };

  return {
    recall,
    personName,
    birthdays,
    diagnostics: () => ({
      enabled: cfg.enabled,
      budgetChars: cfg.budgetChars,
      personChars: cfg.personChars,
      groupChars: cfg.groupChars,
      eventsChars: cfg.eventsChars,
      recentDays: cfg.recentDays,
      cacheTtlMs: cfg.cacheTtlMs,
      maxPersonFiles: cfg.maxPersonFiles,
      maxEvents: cfg.maxEvents,
      logFile: join(diagDir, LOG_FILE),
      ...stats,
      lastPresent,
    }),
  };
}
