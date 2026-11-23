/**
 * R4.0 画像入库编排（写盘侧）：把「模型输出 → 校验 → 合并 → 原子写」串起来。
 *
 * 模块三（profile.ts）是**纯函数**；本文件负责 IO 与「只存 event / 够 3 次才写 md」的分支，
 * 并保证任何一步失败都只 warn 跳过（红线 0.1/0.2）。
 */

import { logInfo, logWarn, type R4Logger } from './logger.js';
import { mkdirSync } from 'node:fs';
import { profilePath, profilesDir, profilesIndexPath } from './paths.js';
import { readProfileEvents, readProfileIndex, writeProfileEvents, writeProfileIndex, mutateProfileIndex } from './state.js';
import { writeTextAtomic, isPlainObject, mutateJsonAtomic } from './atomic.js';
import { buildProfileText, applyExtraction, touchColdStart, canInjectProfile } from './profile.js';
import { readTextSafe } from './atomic.js';
import type { Dictionaries, ProfileIndex, ProfileIndexEntry } from './types.js';

/** 一次入库的结果（诊断用）。 */
export interface ProfileWriteResult {
  /** 处置结论：written（写入了 md）/ events-only（只存事件）/ skipped（整次非法）。 */
  action: 'written' | 'events-only' | 'skipped';
  accepted: number;
  rejected: number;
  /** md 里实际使用的 tag 数。 */
  usedTags: number;
  /**
   * ★ 2026-11-04 双层记忆：本次入库的**永久标签**条数（写进 md 的就是这些）。
   * 临时事件只进 events，不进 md。
   */
  permanent: number;
  /** 失败原因（读/写失败时）。 */
  error?: string;
}

/**
 * 处理某个用户的一次提取输出。
 *
 * 图纸 3.3：**≥3 次才允许写入 `profiles/{userId}.md`**；不足 3 次只存 event。
 * 图纸 3.5：首次写入 md 时设 `coldStartUntil = now + 3 天`。
 *
 * 2026-11-03 修复 P2-9：`coldStartUntil` 只在「缺失/<=0」时才设置（`touchColdStart` 内已保证），
 * 而本函数把它并入**读-改-写一体**流程，写 md 之前先把冷启动时间落盘 —— 即使 md 写失败，
 * 也不会出现「md 在、index 无 → 冷启动无限续期」的脏状态。
 */
export function persistExtraction(input: {
  userId: string;
  output: { tags?: Array<{ tag?: string; category?: string; permanent?: unknown }> } | undefined;
  dictionaries: Dictionaries;
  privacyWhitelist: string[];
  root: string;
  now: number;
  logger?: R4Logger;
  index?: ProfileIndex;
}): ProfileWriteResult {
  const { userId, output, dictionaries, privacyWhitelist, root, now, logger } = input;
  const existing = readProfileEvents(userId, root, logger);
  const applied = applyExtraction({
    userId,
    output,
    existing,
    dictionaries,
    privacyWhitelist,
    now,
  });
  const permanentCount = applied.accepted.filter((tag) => tag.permanent).length;

  if (applied.rejected.some((r) => r.reason === 'tags 不是数组') && applied.accepted.length === 0) {
    logWarn(logger, `[r4] 画像：${userId} 模型输出非法（tags 不是数组）→ 整次跳过，未写入`);
    return { action: 'skipped', accepted: 0, rejected: applied.rejected.length, usedTags: 0, permanent: 0 };
  }

  // 先写 events（失败就别往下走，md 也不写）
  const eventsOk = writeProfileEvents(userId, applied.events, root, logger);
  if (!eventsOk) {
    logWarn(logger, `[r4] 画像：${userId} 事件写入失败 → 本次跳过（不重试）`);
    return { action: 'events-only', accepted: applied.accepted.length, rejected: applied.rejected.length, usedTags: 0, permanent: 0, error: 'events write failed' };
  }

  // 统计画像正文：**只收永久标签**（2026-11-04 双层记忆）。
  // 临时事件已在上面写进 events，这里不再考虑它们。
  const { text, usedTags } = buildProfileText({ events: applied.events, now });
  if (!text.trim()) {
    // 没有永久标签 → 只存事件（临时事件永远不进 md）。
    logInfo(
      logger,
      `[r4] 画像：${userId} 本轮 ${applied.accepted.length} 个 tag 入库`
      + `（永久 ${permanentCount} / 临时 ${applied.accepted.length - permanentCount}），无永久标签 → 只存事件`,
    );
    return { action: 'events-only', accepted: applied.accepted.length, rejected: applied.rejected.length, usedTags: 0, permanent: permanentCount };
  }

  // 冷启动：首次写 md 时设 coldStartUntil（3 天）
  // 2026-11-03 修复 P2-2：改成「读-改-写一体」，避免与本模块之外的
  // `markTagMentionsByReply` 互相覆盖 lastMentionedTags。
  let willInject = true;
  const indexOk = mutateProfileIndex(root, (index) => {
    const nextIndex = touchColdStart({ index, userId, now });
    const entryAfter = nextIndex[userId];
    // 若该用户仍在冷启动期（coldStartUntil > now），**照写但只写不用**（图纸 3.5「只写不用」）
    willInject = canInjectProfile(entryAfter, now);
    return nextIndex;
  }, logger);

  const mdPath = profilePath(userId, root);
  if (!mdPath) {
    logWarn(logger, `[r4] 画像：${userId} 身份非法 → 跳过写盘`);
    return { action: 'events-only', accepted: applied.accepted.length, rejected: applied.rejected.length, usedTags: usedTags.length, permanent: permanentCount, error: 'illegal userId' };
  }
  const ok = writeTextAtomic(mdPath, `${text}\n`, logger);
  if (!ok) {
    logWarn(logger, `[r4] 画像：${userId} 画像正文写入失败 → 跳过（不重试）`);
    return { action: 'events-only', accepted: applied.accepted.length, rejected: applied.rejected.length, usedTags: usedTags.length, permanent: permanentCount, error: 'md write failed' };
  }
  if (!indexOk) {
    logWarn(logger, `[r4] 画像：${userId} index 写入失败（md 已写）→ 冷启动时间未记录`);
  } else {
    logInfo(
      logger,
      `[r4] 画像：${userId} 已更新（${usedTags.length} 个永久 tag / ${[...text].length} 字`
      + `，本轮永久 ${permanentCount} / 临时 ${applied.accepted.length - permanentCount}）`
      + `，冷启动${willInject ? '已过（可注入）' : '中（只写不用）'}`,
    );
  }
  return { action: 'written', accepted: applied.accepted.length, rejected: applied.rejected.length, usedTags: usedTags.length, permanent: permanentCount };
}

/** 读当前用户的画像正文（供注入）。冷启动期或缺失 → 空串。 */
export function readProfileTextForInject(userId: string, root: string, now: number, logger?: R4Logger): string {
  try {
    const index = readProfileIndex(root, logger);
    if (!canInjectProfile(index[userId], now)) {
      logInfo(logger, `[r4] 画像：${userId} 冷启动中 → 不注入`);
      return '';
    }
    const path = profilePath(userId, root);
    if (!path) return '';
    return readTextSafe(path).trim();
  } catch (error) {
    logWarn(logger, `[r4] 画像：读 ${userId} 画像失败（已跳过）：${error instanceof Error ? error.message : String(error)}`);
    return '';
  }
}

/**
 * 确保画像目录存在（首次启动）。失败不抛。
 *
 * 2026-11-03 修复 P3：原先靠「原子写一个 `__ensure__.md` 空文件」来建目录 —— 那会**永久留下**
 * 一个垃圾文件，且 `writeJsonAtomic`/`writeTextAtomic` 内部本来就 `mkdirSync`。
 * 现在直接 `mkdirSync(recursive)`。
 */
export function ensureProfilesDir(root: string, logger?: R4Logger): void {
  try {
    mkdirSync(profilesDir(root), { recursive: true });
  } catch (error) {
    logWarn(logger, `[r4] 画像：建目录失败（已忽略）：${error instanceof Error ? error.message : String(error)}`);
  }
}

/* ───────────── lastMentionedTags 兼容结构（R4.3 / F2） ───────────── */
/*
 * ⚠️ 类型缺口（已上报 Lead，未擅自改 types.ts）：
 *   `ProfileIndexEntry.lastMentionedTags` 仍声明为 `Record<string, number>`，
 *   而本结构写盘时是 `{ at: number; count: number }`。因此这里一律用宽松类型
 *   做「读兼容 + 写升级」，不修改 `types.ts`：
 *     · 旧数据（裸数字）= 最后提及时间，次数按 1 计；
 *     · 新数据（对象）= `{ at, count }`。
 *
 * ⚠️ 落盘真源说明：
 *   现网 `readProfileIndex` / `mutateProfileIndex`（state.ts）会把对象值收敛成 0，
 *   现有写入方 `markTagMentioned`（profile-view.ts）也仍写裸数字 —— 两者都不在本
 *   批次白名单内，**保持原样不动**。F2 接线上线时如需读写这一结构，应：
 *     读 → `readJsonSafe<unknown>(profilesIndexPath(root))` 后调 `tagMentionStats(entry, tag)`；
 *     写 → 调本文件的 `recordTagMention(...)`。
 *   否则新格式经 `readProfileIndex` 会被读成 `{ at: 0, count: 1 }`（见交付报告）。
 */

/** 单个 tag 的提及统计（`at` = 最后提及时间 ms，`count` = 累计次数）。 */
export interface TagMentionStats {
  at: number;
  count: number;
}

/** 磁盘上的旧（裸数字）/ 新（`{at,count}`）两种提及条目。 */
type LooseTagMention = number | { at?: unknown; count?: unknown };
type LooseTagMentionMap = Record<string, LooseTagMention>;

/** 提及时间收敛：非负整数 ms；非法 → 0。 */
function mentionTs(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.round(n);
}

/** 提及次数收敛：正整数；非法/非正 → 0。 */
function mentionCount(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n);
}

/** 取 entry 里的 lastMentionedTags（宽松类型；缺失/损坏 → 空表）。 */
function mentionMapOf(entry: ProfileIndexEntry | undefined): LooseTagMentionMap {
  const raw = (entry as unknown as { lastMentionedTags?: unknown } | undefined)?.lastMentionedTags;
  return isPlainObject(raw) ? (raw as LooseTagMentionMap) : {};
}

/** 在宽松提及表里读一个 tag 的统计（纯函数，绝不抛）。 */
function statsOfMap(map: LooseTagMentionMap, tag: string): TagMentionStats {
  const raw = map[tag];
  if (typeof raw === 'number') {
    // 旧格式：裸数字 = 最后提及时间，次数按 1 计。
    return { at: mentionTs(raw), count: 1 };
  }
  if (isPlainObject(raw)) {
    // 新格式：{ at, count }。缺 count 时按「提过 1 次」兼容。
    const at = mentionTs(raw.at);
    const count = raw.count === undefined ? (at > 0 ? 1 : 0) : mentionCount(raw.count);
    return { at, count };
  }
  return { at: 0, count: 0 };
}

/**
 * 读一个 tag 的提及统计（F2 判断用）。
 *
 * - 旧数据 `{ "猫图": 1793500000000 }` → `{ at: 1793500000000, count: 1 }`
 * - 新数据 `{ "猫图": { "at": 1793500000000, "count": 3 } }` → `{ at, count: 3 }`
 * - 缺失/损坏 → `{ at: 0, count: 0 }`（调用方按「从未提及」处理）
 *
 * **不抛**：任何异常都返回 `{ at: 0, count: 0 }`。
 */
export function tagMentionStats(entry: ProfileIndexEntry | undefined, tag: string): TagMentionStats {
  try {
    const key = String(tag ?? '').trim();
    if (!key) return { at: 0, count: 0 };
    return statsOfMap(mentionMapOf(entry), key);
  } catch {
    return { at: 0, count: 0 };
  }
}

/**
 * 记录一次 tag 提及（结构升级的唯一写入口）。
 *
 * 统一写 `{ at: now, count: 旧 count + 1 }`：
 *   - 旧裸数字 → 先按 count=1 读，再累加成 2；
 *   - 新对象 → 直接累加；
 *   - 不存在的 tag → `{ at: now, count: 1 }`。
 *
 * 读-改-写一体，保留该用户其它字段（`coldStartUntil` 等）与其它用户条目原样。
 * 写失败/参数非法 → `false`，不抛、不重试。
 */
export function recordTagMention(input: {
  root: string;
  userId: string;
  tag: string;
  now: number;
  logger?: R4Logger;
}): boolean {
  try {
    const root = String(input?.root ?? '');
    const userId = String(input?.userId ?? '').trim();
    const tag = String(input?.tag ?? '').trim();
    const now = mentionTs(input?.now);
    if (!root || !userId || !tag || now <= 0) return false;
    const path = profilesIndexPath(root);
    if (!path) return false;
    const result = mutateJsonAtomic<unknown>(path, (previous) => {
      // 保留整份索引：非对象/损坏 → 从空表重建（不抛）。
      const file: Record<string, unknown> = isPlainObject(previous) ? { ...previous } : {};
      const prevEntry = file[userId];
      const entry: Record<string, unknown> = isPlainObject(prevEntry) ? { ...prevEntry } : {};
      const prevTags = entry.lastMentionedTags;
      const statsMap: LooseTagMentionMap = isPlainObject(prevTags)
        ? { ...(prevTags as LooseTagMentionMap) }
        : {};
      const before = statsOfMap(statsMap, tag);
      statsMap[tag] = { at: now, count: before.count + 1 };
      entry.lastMentionedTags = statsMap;
      file[userId] = entry;
      return file;
    }, input.logger);
    return result.ok;
  } catch {
    return false;
  }
}
