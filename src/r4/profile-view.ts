/**
 * profile-view — 画像的「读」路径：正文渲染、统计、冷启动、提及记录
 *
 * 从 `r4/profile.ts` 拆出（重构阶段 2 / 批次 B）。
 * 图纸 3.4/3.5：永久标签进正文、临时事件只做琐事摘要、冷启动 3 天只写不用。
 *
 * 纪律：不做 IO、不用 `Date.now()`、不用随机数；`now` 一律入参，返回新对象。
 */

import type { ProfileEventsFile, ProfileIndex, ProfileIndexEntry } from './types.js';
import {
  DAY_MS,
  DEFAULT_COLD_START_DAYS,
  DEFAULT_MAX_PROFILE_CHARS,
  DEFAULT_RETENTION_DAYS,
} from './profile-types.js';
import { charLength, cloneEventsFile, cloneIndex, maxOf } from './profile-utils.js';

/** 近 `days` 天出现次数（`now - t <= days*86400000`，7 天整点算内）。 */
export function countRecent(timestamps: number[], now: number, days = DEFAULT_RETENTION_DAYS): number {
  if (!Array.isArray(timestamps)) return 0;
  const windowMs = days * DAY_MS;
  let count = 0;
  for (const t of timestamps) {
    const value = Number(t);
    if (!Number.isFinite(value)) continue;
    if (now - value <= windowMs) count += 1;
  }
  return count;
}

/**
 * ★ 2026-11-04 双层记忆：取「近 N 天的临时事件 tag」供注入层做**琐事摘要**。
 *
 * 这是需求 §3 触发点的实现基础（决策点 ③ 方案 A）：
 *   - 只返回 tag 文本，**不返回原文**（红线：不要把长篇历史塞进 Prompt）；
 *   - 按最近提及时间降序，最多 `limit` 个；
 *   - 永久标签**不在此列**（它们已经在画像正文里了，再列一遍是浪费预算）。
 *
 * 注入层把它渲染成一句话（如「最近聊过：加班、考试」），
 * 由模型自己按记忆法则决定要不要"装糊涂"。
 */
export function recentTempEventsOf(input: {
  events: ProfileEventsFile;
  now: number;
  days?: number;
  limit?: number;
}): string[] {
  const now = Number(input.now);
  const windowMs = (input.days ?? DEFAULT_RETENTION_DAYS) * DAY_MS;
  const limit = Math.max(0, input.limit ?? 5);
  if (limit === 0) return [];

  const hits: Array<{ tag: string; last: number }> = [];
  for (const event of cloneEventsFile(input.events).events) {
    if (!event.tag) continue;
    if (event.permanent === true) continue; // 永久标签不进琐事摘要
    const recent = event.timestamps
      .map((t) => Number(t))
      .filter((value) => Number.isFinite(value) && value > 0 && now - value <= windowMs);
    if (recent.length === 0) continue;
    hits.push({ tag: event.tag, last: maxOf(recent) });
  }

  hits.sort((a, b) => b.last - a.last || a.tag.localeCompare(b.tag, 'zh'));
  return hits.slice(0, limit).map((item) => item.tag);
}

/** 画像里永久标签的条数（诊断/上限用）。 */
export function countPermanentTags(events: ProfileEventsFile): number {
  return cloneEventsFile(events).events.filter((event) => event.permanent === true).length;
}

/**
 * 画像正文：**只收永久标签**；排序「频次降序 → 最近提及时间降序 → 字典序」；
 * 按 tag 整体累加到 `maxChars`（默认 80 字），超了就停止，绝不截断半个 tag。
 *
 * ★ 2026-11-04 双层记忆（决策点 ①，主人已确认）：
 *  - **永久标签**（`permanent:true`）：**取消「近 7 天 ≥3 次」门槛** —— 出现 1 次即进正文，
 *    且不受 7 天窗口限制（7 天前出现过的永久标签仍算数）。
 *    理由：性格/偏好/梗是模型判定的稳定特征，靠 category 白名单 + 敏感词校验把关；
 *    要求"说 3 次才记住"会让"她永远记得你"这个设定落空。
 *  - **临时事件**（`permanent:false`）：**完全不进正文**。它们是"昨天吃了什么"这类琐事，
 *    只在被追问时由注入层按需浮现（见 inject.ts 的临时事件摘要），不写进长期画像。
 *
 * 注：图纸 3.3 的「≥3 次才进正文」原意是防幻觉（防止模型一次臆测就写死），
 * 该防线现在由「category 白名单 + 敏感词 + 单次 5 条 + 冷启动 3 天只写不用」继续承担。
 */
export function buildProfileText(input: {
  events: ProfileEventsFile;
  now: number;
  maxChars?: number;
  retentionDays?: number;
}): { text: string; usedTags: string[] } {
  const now = Number(input.now);
  const maxChars = input.maxChars ?? DEFAULT_MAX_PROFILE_CHARS;
  const retentionDays = input.retentionDays ?? DEFAULT_RETENTION_DAYS;
  const windowMs = retentionDays * DAY_MS;

  const candidates: Array<{ tag: string; count: number; last: number }> = [];
  for (const event of cloneEventsFile(input.events).events) {
    const tag = event.tag;
    if (!tag) continue;
    if (event.permanent === true) {
      // 永久标签：不限窗口、不设门槛。count 仍用于排序（越常说越靠前）。
      const all = event.timestamps
        .map((t) => Number(t))
        .filter((value) => Number.isFinite(value) && value > 0);
      candidates.push({ tag, count: Math.max(1, all.length), last: maxOf(all) });
      continue;
    }
    // 临时事件不进正文（它们由注入层的「最近琐事」摘要承担，见 inject.ts）。
  }

  candidates.sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    if (b.last !== a.last) return b.last - a.last;
    return a.tag.localeCompare(b.tag, 'zh');
  });

  let text = '';
  const usedTags: string[] = [];
  for (const candidate of candidates) {
    const next = usedTags.length === 0 ? candidate.tag : `${text}、${candidate.tag}`;
    if (charLength(next) > maxChars) break; // 图纸 3.4：超字数停止，不截断 tag 本身。
    text = next;
    usedTags.push(candidate.tag);
  }

  return { text, usedTags };
}

/** 是否允许注入该用户画像：条目缺失或冷启动未结束（coldStartUntil > now）都不注入。 */
export function canInjectProfile(entry: ProfileIndexEntry | undefined, now: number): boolean {
  if (!entry) return false;
  return !(Number(entry.coldStartUntil) > Number(now));
}

/** 首次写入画像正文时设 coldStartUntil = now + 3 天；已有（>0）则保留。返回深拷贝。 */
export function touchColdStart(input: {
  index: ProfileIndex;
  userId: string;
  now: number;
  days?: number;
}): ProfileIndex {
  const index = cloneIndex(input.index);
  const userId = String(input.userId ?? '');
  const days = input.days ?? DEFAULT_COLD_START_DAYS;
  const existing = index[userId];
  if (existing) {
    if (!(Number(existing.coldStartUntil) > 0)) {
      existing.coldStartUntil = Number(input.now) + days * DAY_MS;
    }
  } else {
    index[userId] = {
      lastMentionedTags: {},
      coldStartUntil: Number(input.now) + days * DAY_MS,
    };
  }
  return index;
}

/**
 * AI 主动提及/追问某 tag 时更新 `lastMentionedTags[tag]`。返回深拷贝。
 *
 * ★ 2026-11-05 R4.3 修（批次 C 报告指出的闭环缺口）：
 *   原先写裸数字 —— 新格式 `{at,count}` 一旦被读回再写就会被降级回数字，F2 的提及次数永久丢失。
 *   现在统一写 `{ at, count }`，旧裸数字按 `count: 1` 兼容累加。
 */
export function markTagMentioned(input: {
  index: ProfileIndex;
  userId: string;
  tag: string;
  now: number;
}): ProfileIndex {
  const index = cloneIndex(input.index);
  const userId = String(input.userId ?? '');
  const tag = String(input.tag ?? '');
  const entry = index[userId] ?? { lastMentionedTags: {}, coldStartUntil: 0 };
  if (tag) {
    const prev = entry.lastMentionedTags[tag];
    const prevCount = typeof prev === 'number' ? 1 : Number(prev?.count ?? 0);
    entry.lastMentionedTags[tag] = {
      at: Number(input.now),
      count: (Number.isFinite(prevCount) && prevCount > 0 ? prevCount : 0) + 1,
    };
  }
  index[userId] = entry;
  return index;
}

/** ★ 2026-11-05 F2：最近提过的 tag「降权」窗口（天）。由调用方按需覆盖（`days` 参数）。 */
export const MENTION_DEMOTE_DAYS = 14;

/** 提及时间收敛：兼容旧裸数字与新 `{ at, count }` 两种形态；非法 → 0。 */
function mentionAtOf(raw: unknown): number {
  if (typeof raw === 'number') return Number.isFinite(raw) && raw > 0 ? raw : 0;
  if (raw && typeof raw === 'object') {
    const at = Number((raw as { at?: unknown }).at);
    return Number.isFinite(at) && at > 0 ? at : 0;
  }
  return 0;
}

/**
 * ★ 2026-11-05 F2「记忆表达分级」—— **简化一层（token 优先）**：
 * 把「最近 `days` 天内已经提过」的画像 tag **降权**（移到正文末尾）。
 *
 * 背景（P0 修复）：`lastMentionedTags` 之前全链路零写入（永远空），
 * F2 的分级规则没有数据可依。写入链接线后这里才有意义。
 *
 * 为什么只做「移到末尾」而不「删除」：
 *   - 画像 = 她对你的记忆。「提过就忘」会把「她永远记得你」的核心设定打掉；
 *   - 画像正文有 80 字预算（`buildProfileText`），排到末尾 = 同等预算下
 *     **没提过的 tag 先占用**，已提过的让位 —— 这就是成本最低的降权；
 *   - 不做三级措辞、不调模型、不增加任何 prompt 内容（**零额外 token**）。
 *
 * 纯函数、无 IO、永不抛：输入非法 / 只有一行没有分隔符 / 全部都是最近提过的
 * → 原样返回正文（顺序不变），但 `tags` 仍会返回（供调用方记录提及）。
 *
 * @returns `text` = 降权后的正文；`tags` = 正文里的全部 tag（按最终顺序）；
 *          `demoted` = 被移到末尾的 tag（诊断用）。
 */
export function demoteRecentlyMentionedTags(input: {
  text: string;
  lastMentionedTags?: Record<string, unknown> | undefined;
  now: number;
  days?: number;
}): { text: string; tags: string[]; demoted: string[] } {
  const raw = String(input?.text ?? '');
  if (!raw.trim()) return { text: raw, tags: [], demoted: [] };
  try {
    const now = Number(input?.now) || 0;
    const windowMs = Math.max(1, Number(input?.days ?? MENTION_DEMOTE_DAYS)) * DAY_MS;
    const map = input?.lastMentionedTags && typeof input.lastMentionedTags === 'object'
      ? input.lastMentionedTags
      : {};

    // 画像正文的格式是「tag1、tag2、…」（`buildProfileText` 用「、」拼接）。
    // 这里同时容忍换行（手写/旧文件），归一化后仍用「、」输出。
    const parts = raw.split(/[、\n\r]+/u).map((part) => part.trim()).filter(Boolean);
    if (parts.length === 0) return { text: raw, tags: [], demoted: [] };

    const normal: string[] = [];
    const demoted: string[] = [];
    for (const tag of parts) {
      const at = mentionAtOf(map[tag]);
      // 只认「过去 14 天内」的提及；未来时间戳（时钟回拨）不算。
      if (at > 0 && now > 0 && at <= now && now - at < windowMs) demoted.push(tag);
      else normal.push(tag);
    }
    const tags = [...normal, ...demoted];
    if (demoted.length === 0) return { text: raw, tags, demoted };
    return { text: tags.join('、'), tags, demoted };
  } catch {
    return { text: raw, tags: [], demoted: [] };
  }
}

/**
 * 3 天不追问清单：`lastMentionedTags[tag]` 缺失（从未追问）也算 stale；
 * `now - v >= days*86400000` 算 stale。按入参 tags 顺序返回。
 */
export function staleTagsFor(input: {
  entry: ProfileIndexEntry | undefined;
  now: number;
  tags: string[];
  days?: number;
}): string[] {
  const lastMentionedTags = input.entry?.lastMentionedTags ?? {};
  const windowMs = (input.days ?? DEFAULT_COLD_START_DAYS) * DAY_MS;
  const now = Number(input.now);
  const stale: string[] = [];
  for (const tag of Array.isArray(input.tags) ? input.tags : []) {
    const raw = lastMentionedTags[tag];
    // ★ 2026-11-05 R4.3：兼容旧裸数字与新 `{at,count}` 两种形态。
    const mentionedAt = typeof raw === 'number' ? raw : Number((raw as { at?: unknown } | undefined)?.at ?? 0);
    if (raw === undefined || !Number.isFinite(mentionedAt) || mentionedAt <= 0) {
      stale.push(tag); // 从未追问过 / 值损坏 → stale
      continue;
    }
    if (now - mentionedAt >= windowMs) stale.push(tag);
  }
  return stale;
}
