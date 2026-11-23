/**
 * events-store — 结构化事件表 IO（R4.3 / F1 记忆关联）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 批次 B：**完整实现**（阶段 A1 曾为骨架）。
 * 功能开关仍由 `features_config.memory_link` 控制（默认关闭，行为不变）。
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 数据布局：`{PERSONA_DATA_ROOT}/state/events/{userId}.json`
 *
 * ⚠️ **跨群隔离**（最高风险项）：
 *   文件按 userId 分，但每个事件带 `groupId`。
 *   召回时必须 `event.groupId === 当前群 && event.userId === 当前发言人` **双重校验**，
 *   否则群 A 的私事会跑到群 B 去说 —— 那比不记得还糟。
 *   本模块只负责「安全地读写 + 校验字段」，隔离红线由 `events-recall` 执行。
 *
 * 红线：
 *   · 读缺失 / 损坏 / 字段不合法 → 空表，**绝不抛**；
 *   · 写失败 → `false`，**绝不抛**；
 *   · 写前做两件事：`done` 超期清理、`max_per_user` 上限淘汰；
 *   · 所有 IO 全同步（与 r4 其它 store 一致，调用方无需 await）。
 */

import { join } from 'node:path';
import { isPlainObject, readJsonSafe, writeJsonAtomic } from './atomic.js';
import { DEFAULT_CONFIG } from './config.js';
import { closeExpired, markDone } from './events-close.js';
import { logWarn, type R4Logger } from './logger.js';
import { sanitizeId } from './paths.js';
import type { EventFile, EventRecord, EventType, EventsConfig } from './types.js';

/** 事件文件格式版本；版本不符 → 按空表处理（不猜测迁移）。 */
export const EVENTS_VERSION = 1;

/** 一天毫秒数（本模块所有窗口都以天为单位配置）。 */
const DAY_MS = 86_400_000;

/** 合法事件类型（与 types.ts 的 `EventType` 一一对应）。 */
const EVENT_TYPES: readonly EventType[] = [
  'exam',
  'project',
  'interview',
  'trip',
  'health',
  'move',
  'game',
  'other',
];

/** 合法状态。 */
const EVENT_STATUSES: readonly EventRecord['status'][] = ['open', 'done', 'expired'];

/**
 * 事件表路径（按用户分文件）。
 * **userId 拼路径前必须净化**：非法身份 → 空串（调用方必须判空）。
 */
export function eventsPath(userId: string, root: string): string {
  const id = sanitizeId(userId);
  if (!id) return '';
  return join(root, 'state', 'events', `${id}.json`);
}

/** 取非空字符串（去首尾空白）；非字符串 → 空串。 */
function textOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** 取有限数字；不适格 → `null`。 */
function numberOf(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return value;
}

/** 校验并规整提及链：坏条目直接丢弃（不让一条脏数据毁掉整张表）。 */
function parseMentions(raw: unknown): EventRecord['mentions'] {
  if (!Array.isArray(raw)) return [];
  const mentions: EventRecord['mentions'] = [];
  for (const item of raw) {
    if (!isPlainObject(item)) continue;
    const at = numberOf(item.at);
    const text = textOf(item.text);
    if (at === null || at < 0 || !text) continue;
    mentions.push({ at, text });
  }
  return mentions;
}

/** 校验并规整关键词：只保留非空字符串，去重（保持首次出现顺序）。 */
function parseKeywords(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const keywords: string[] = [];
  for (const item of raw) {
    const keyword = textOf(item);
    if (!keyword || seen.has(keyword)) continue;
    seen.add(keyword);
    keywords.push(keyword);
  }
  return keywords;
}

/**
 * 逐条校验事件记录。
 *
 * 缺 `id/userId/groupId/type/summary` 任一项、状态非法、时间戳非法 → `null`（该条丢弃）。
 * `keywords` / `mentions` 缺失按空数组处理（老数据兼容）。
 *
 * 注意：**不校验记录 userId 是否等于文件 userId** —— 跨用户隔离由 recall 的
 * `event.userId === input.userId` 执行；这里丢掉记录反而可能把正常数据清空。
 */
function parseRecord(raw: unknown): EventRecord | null {
  if (!isPlainObject(raw)) return null;
  const id = textOf(raw.id);
  const userId = textOf(raw.userId);
  const groupId = textOf(raw.groupId);
  const summary = textOf(raw.summary);
  const type = textOf(raw.type);
  if (!id || !userId || !groupId || !summary) return null;
  if (!EVENT_TYPES.includes(type as EventType)) return null;

  const status = textOf(raw.status);
  if (!EVENT_STATUSES.includes(status as EventRecord['status'])) return null;

  const createdAt = numberOf(raw.createdAt);
  const updatedAt = numberOf(raw.updatedAt);
  if (createdAt === null || createdAt < 0 || updatedAt === null || updatedAt < 0) return null;

  const lastReferencedAt = numberOf(raw.lastReferencedAt);
  const record: EventRecord = {
    id,
    userId,
    groupId,
    type: type as EventType,
    keywords: parseKeywords(raw.keywords),
    summary,
    mentions: parseMentions(raw.mentions),
    status: status as EventRecord['status'],
    createdAt,
    updatedAt,
    lastReferencedAt: lastReferencedAt !== null && lastReferencedAt >= 0 ? lastReferencedAt : 0,
  };
  const closeWhy = textOf(raw.closeWhy);
  if (closeWhy) record.closeWhy = closeWhy;
  return record;
}

/** 取配置里的正数；非法 → 回落默认值（配置加载层已做范围校验，这里只做兜底）。 */
function positiveFromConfig(value: unknown, fallback: number, integer: boolean): number {
  const n = typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
  return integer ? Math.max(1, Math.floor(n)) : Math.max(1, n);
}

/**
 * 读取某用户的事件表。
 * 缺失 / 损坏 / version 不符 / `events` 不是数组 / 单条字段不合法 → 降级（**绝不抛**）。
 *
 * 说明：这里**不做时间过期过滤**（函数签名没有 `now` / 配置）。
 * 事件过期是惰性动作，由调用方在合适时机调 `events-close.closeExpired`。
 */
export function readEventFile(userId: string, root: string): EventFile {
  const requested = String(userId ?? '').trim();
  const empty = (): EventFile => ({ version: EVENTS_VERSION, userId: requested, events: [] });
  try {
    const path = eventsPath(userId, root);
    if (!path) return empty();
    const raw = readJsonSafe<unknown>(path);
    if (!isPlainObject(raw)) return empty();
    if (raw.version !== EVENTS_VERSION || !Array.isArray(raw.events)) return empty();

    const events: EventRecord[] = [];
    for (const item of raw.events) {
      const record = parseRecord(item);
      if (record) events.push(record);
    }
    return { version: EVENTS_VERSION, userId: requested, events };
  } catch {
    // readJsonSafe 本身不抛；这里只兜「校验逻辑自身意外」——绝不把异常交给调用方。
    return empty();
  }
}

/**
 * 写入某用户的事件表（**原子写**）；失败返回 false（绝不抛）。
 *
 * 写入前做两件事（顺序有讲究：先清理已完成的，再按上限淘汰）：
 *   ① `status === 'done'` 且 `updatedAt` 超过 `expire_days` 天 → 删除；
 *   ② 超过 `max_per_user` 条 → 淘汰最旧（按 `createdAt`，同时间按原顺序）。
 *
 * @param config 运行时 `events_config`；缺省用 `DEFAULT_CONFIG.events_config`
 *               （阶段 A 锁定的签名没有配置参数，这里做向后兼容的可选扩展）。
 */
export function writeEventFile(
  file: EventFile,
  root: string,
  config: EventsConfig = DEFAULT_CONFIG.events_config,
  logger?: R4Logger,
): boolean {
  try {
    if (!isPlainObject(file) || !Array.isArray(file.events)) return false;
    const id = sanitizeId(file.userId);
    const path = id ? eventsPath(id, root) : '';
    if (!path) return false;

    const cfg = config ?? DEFAULT_CONFIG.events_config;
    const maxPerUser = positiveFromConfig(cfg.max_per_user, DEFAULT_CONFIG.events_config.max_per_user, true);
    const expireDays = positiveFromConfig(cfg.expire_days, DEFAULT_CONFIG.events_config.expire_days, false);
    const now = Date.now();

    // 先校验/规整，再谈淘汰 —— 脏记录不占用名额。
    let events: EventRecord[] = [];
    for (const item of file.events) {
      const record = parseRecord(item);
      if (record) events.push(record);
    }

    // ① done 超期清理（只清 done；open 交给 closeExpired 判 expired）。
    const expireMs = expireDays * DAY_MS;
    events = events.filter((event) => !(event.status === 'done' && now - event.updatedAt > expireMs));

    // ② 上限淘汰：删最旧的若干条，保留其余记录的原有顺序。
    if (events.length > maxPerUser) {
      const order = events
        .map((event, index) => ({ event, index }))
        .sort((a, b) => a.event.createdAt - b.event.createdAt || a.index - b.index);
      const drop = new Set(order.slice(0, events.length - maxPerUser).map((item) => item.index));
      events = events.filter((_event, index) => !drop.has(index));
    }

    return writeJsonAtomic(path, { version: EVENTS_VERSION, userId: id, events }, logger);
  } catch (error) {
    logWarn(logger, `[r4] 事件表：写入失败（已跳过）：${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

/**
 * 标记某个事件「已被引用」→ 写回 `lastReferencedAt`。
 *
 * ★ 2026-11-05（批次 B 报告发现的高危缺口）：
 *   原先全仓库**没有任何地方**写这个字段，`events-recall` 里的
 *   `cooldown_days` 过滤因此永远不会触发 —— 同一件旧事会被反复召回。
 *   所以「真正把 hint 注入出去」的那一刻必须回头标记它。
 *
 * @returns true = 找到并写盘成功
 */
export function markEventReferenced(
  userId: string,
  eventId: string,
  root: string,
  now = Date.now(),
  config: EventsConfig = DEFAULT_CONFIG.events_config,
  logger?: R4Logger,
): boolean {
  try {
    const target = String(eventId ?? '').trim();
    if (!target) return false;
    const file = readEventFile(userId, root);
    const record = file.events.find((event) => event.id === target);
    if (!record) return false;
    record.lastReferencedAt = Number(now) || Date.now();
    return writeEventFile(file, root, config, logger);
  } catch {
    return false;
  }
}

/* ───────── R4.3 / D2：事件提取接入（F1 的「生产者」）───────── */

/** 归一化事件类型（模型可能给中文或未知值）；未知 → `other`。 */
function normalizeType(raw: unknown): EventType {
  const s = String(raw ?? '').trim().toLowerCase();
  if ((EVENT_TYPES as readonly string[]).includes(s)) return s as EventType;
  const alias: Record<string, EventType> = {
    考试: 'exam', 测验: 'exam', 期末: 'exam', 期中: 'exam',
    项目: 'project', 工作: 'project', 上线: 'project',
    面试: 'interview', 笔试: 'interview',
    出差: 'trip', 旅行: 'trip', 旅游: 'trip',
    健康: 'health', 看病: 'health', 手术: 'health', 体检: 'health',
    搬家: 'move',
    游戏: 'game', 比赛: 'game',
  };
  return alias[s] ?? 'other';
}

/** 两个事件是否在聊同一件事（关键词有交集）。 */
function sameTopic(event: EventRecord, keywords: string[]): boolean {
  if (keywords.length === 0) return false;
  const set = new Set(event.keywords.map((k) => k.toLowerCase()));
  return keywords.some((k) => set.has(k.toLowerCase()));
}

/** 生成事件 ID：`evt_<YYYYMMDD>_<时间戳后4位>_<随机2位>`。 */
function newEventId(now: number): string {
  const d = new Date(now);
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const tail = String(now).slice(-4);
  const rnd = Math.random().toString(36).slice(2, 4).padEnd(2, '0');
  return `evt_${ymd}_${tail}_${rnd}`;
}

/**
 * 把模型提取出来的事件合并进事件表（**F1 的唯一生产者**）。
 *
 * ★ 2026-11-05（批次 C 报告指出的致命缺口）：
 *   没有这一步，`events.csv` 永远是空的，F1 打开后也不会有任何产出。
 *
 * 合并规则（事件提及链）：
 *   · 同群 + 同 type + **关键词有交集** + `status==='open'` → 视为同一件事 → 追加 mention
 *   · 否则新建一条事件
 *
 * 安全边界：
 *   · 单次最多收 5 条（防模型刷屏）
 *   · summary 截 40 字、keywords 最多 6 个、mentions 最多保留 10 条
 *   · 任何异常 → 返回 0，**绝不影响画像提取**
 */
export function mergeExtractedEvents(input: {
  userId: string;
  groupId: string;
  extracted: unknown;
  root: string;
  now: number;
  config: EventsConfig;
  logger?: R4Logger;
}): number {
  try {
    const list = Array.isArray(input.extracted) ? input.extracted : [];
    if (list.length === 0) return 0;
    const userId = sanitizeId(input.userId);
    const groupId = String(input.groupId ?? '').trim();
    if (!userId || !groupId) return 0;

    const now = Number(input.now) || Date.now();
    const file = readEventFile(userId, input.root);
    /**
     * ★ 2026-11-05 F1 闭环（P1 修复②之一）：**合并前先做惰性过期**。
     *
     * 为什么必须放在这里：`mergeExtractedEvents` 只挑 `status==='open'` 的事件合并，
     * 而此前 `closeExpired` 全仓库零调用 → 一条超过 `expire_days` 的 open 事件
     * 会继续吸走新提及（提及越新、事件越像"活着"，但其实永远进不了召回窗口）。
     * 合并本来就要写盘，这里顺手过期**不增加任何 IO**。
     */
    file.events = closeExpired(file.events, now, input.config);
    let added = 0;

    for (const raw of list.slice(0, 5)) {
      if (!isPlainObject(raw)) continue;
      const type = normalizeType(raw.type);
      const summary = String(raw.summary ?? '').trim().slice(0, 40);
      if (!summary) continue;
      const keywords = Array.isArray(raw.keywords)
        ? raw.keywords.map((k) => String(k ?? '').trim()).filter(Boolean).slice(0, 6)
        : [];

      const existing = file.events.find(
        (event) => event.groupId === groupId
          && event.type === type
          && event.status === 'open'
          && sameTopic(event, keywords),
      );
      if (existing) {
        existing.mentions.push({ at: now, text: summary });
        if (existing.mentions.length > 10) existing.mentions = existing.mentions.slice(-10);
        existing.updatedAt = now;
        if (keywords.length > 0) {
          const merged = [...new Set([...existing.keywords, ...keywords])];
          existing.keywords = merged.slice(0, 8);
        }
        continue;
      }

      file.events.push({
        id: newEventId(now),
        userId,
        groupId,
        type,
        keywords,
        summary,
        mentions: [{ at: now, text: summary }],
        status: 'open',
        createdAt: now,
        updatedAt: now,
        lastReferencedAt: 0,
      });
      added += 1;
    }

    if (added > 0 || file.events.length > 0) {
      writeEventFile(file, input.root, input.config, input.logger);
    }
    return added;
  } catch {
    return 0;
  }
}

/* ───────── R4.3 / F1 闭环接入：done / expired 的**生产写回入口** ───────── */

/**
 * 统计「状态发生变化」的条数（用于判断是否值得写盘）。
 * 两个数组长度不一致时，多/少的部分也计入变化（防御性兜底，正常不会发生）。
 */
function countStatusChanges(before: EventRecord[], after: EventRecord[]): number {
  let changed = Math.abs(before.length - after.length);
  const total = Math.min(before.length, after.length);
  for (let index = 0; index < total; index += 1) {
    if (before[index]?.status !== after[index]?.status) changed += 1;
  }
  return changed;
}

/**
 * 惰性过期（`events-close.closeExpired` 的**唯一生产调用点**）。
 *
 * ★ 2026-11-05 修复 P1（事件永不闭环）：
 *   `closeExpired` 此前全仓库零调用 → 超过 `events_config.expire_days` 的 open 事件
 *   永远不会变 `expired`，配置形同虚设。现在由调用方在**每次读事件前**调一次。
 *
 * 语义：
 *   · 只在**真的有状态变化**时原子写回（读多写少，不刷盘）；
 *   · 读/写/判定全部走既有函数，任何异常 → 返回 0，**绝不抛**；
 *   · 不改 `updatedAt`（纯状态迁移，与 `closeExpired` 一致）。
 *
 * @returns 本次被置为 `expired` 的条数（0 = 无需过期 / 已处理过 / 写失败）
 */
export function expireStaleEvents(
  userId: string,
  root: string,
  now: number,
  config: EventsConfig = DEFAULT_CONFIG.events_config,
  logger?: R4Logger,
): number {
  try {
    const file = readEventFile(userId, root);
    if (file.events.length === 0) return 0;
    const next = closeExpired(file.events, now, config);
    const changed = countStatusChanges(file.events, next);
    if (changed === 0) return 0;
    return writeEventFile({ ...file, events: next }, root, config, logger) ? changed : 0;
  } catch (error) {
    logWarn(logger, `[r4] 事件表：过期判定失败（已跳过）：${error instanceof Error ? error.message : String(error)}`);
    return 0;
  }
}

/**
 * 完结闭环（`events-close.markDone` 的**唯一生产调用点**）。
 *
 * ★ 2026-11-05 修复 P1（事件永不闭环）：
 *   `markDone` 此前全仓库零调用 → 用户说「考完了/搞定了」也不会把事件置 done，
 *   后续提及继续被合并进这条永远 open 的旧链，最终拖出召回窗口而永久失忆。
 *
 * 判定**完全本地**：events-close 的固定完成词表 + 事件关键词双命中，**不采信模型输出**
 * （审查标准四.1）。这里只负责「读 → 判定 → 有变化才原子写回」。
 *
 * @param text 本轮消息正文（调用方传入原始语料；本函数只做子串匹配）
 * @returns 本次被置为 `done` 的条数（0 = 无完结信号 / 无变化 / 写失败）
 */
export function closeEventsByText(
  userId: string,
  text: string,
  root: string,
  now: number,
  config: EventsConfig = DEFAULT_CONFIG.events_config,
  logger?: R4Logger,
): number {
  try {
    const body = typeof text === 'string' ? text : '';
    if (!body.trim()) return 0;
    const file = readEventFile(userId, root);
    if (file.events.length === 0) return 0;
    const next = markDone(file.events, body, now);
    const changed = countStatusChanges(file.events, next);
    if (changed === 0) return 0;
    return writeEventFile({ ...file, events: next }, root, config, logger) ? changed : 0;
  } catch (error) {
    logWarn(logger, `[r4] 事件表：完结判定失败（已跳过）：${error instanceof Error ? error.message : String(error)}`);
    return 0;
  }
}
