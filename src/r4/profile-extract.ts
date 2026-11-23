/**
 * profile-extract — 模型输出的校验、归一化、合并与清理（「写」路径）
 *
 * 从 `r4/profile.ts` 拆出（重构阶段 2 / 批次 B）。
 * 图纸 3.1–3.4：校验从严 → 归一化 → 合并事件 → 7 天 / 50 tag 清理。
 * 所有计数一律**本地统计**，模型输出里的任何计数一律忽略。
 *
 * 纪律：不做 IO、不用 `Date.now()`、不用随机数；`now` 一律入参，返回新对象。
 */

import type { Dictionaries, ExtractedTag, ProfileEventsFile } from './types.js';
import {
  DAY_MS,
  DEFAULT_MAX_PERMANENT_PER_USER,
  DEFAULT_MAX_TAGS_PER_EXTRACTION,
  DEFAULT_MAX_TAGS_PER_USER,
  DEFAULT_MAX_TAG_CHARS,
  DEFAULT_RETENTION_DAYS,
  resolvePermanent,
} from './profile-types.js';
import {
  charLength,
  cloneEventsFile,
  hitSensitiveWord,
  lookupSynonym,
  maxOf,
  toHalfWidth,
} from './profile-utils.js';

/** 非法整体输出的占位 tag（图纸 3.2：整次提取跳过）。 */
const WHOLE_OUTPUT_TAG = '<整体>';

/** 归一化：全半角 → 英文小写 → trim → 同义词映射。空/纯空白 → 空串。 */
export function normalizeTag(raw: string, synonyms: Record<string, string>): string {
  const text = toHalfWidth(String(raw ?? '')).toLowerCase().trim();
  if (!text) return '';
  return lookupSynonym(text, synonyms);
}

/**
 * 校验单条 tag：非空 → 长度 ≤20（按字符计）→ category ∈ 白名单 → 不命中敏感词。
 * 顺序即拒因优先级（空 tag → 超长 → category 不在白名单 → 命中敏感词）。
 */
export function validateExtractedTag(input: {
  tag: string;
  category: string;
  privacyWhitelist: string[];
  sensitiveWords: string[];
  maxTagChars?: number;
}): { ok: boolean; reason?: string } {
  const tag = String(input.tag ?? '').trim();
  const category = String(input.category ?? '').trim();
  const maxTagChars = input.maxTagChars ?? DEFAULT_MAX_TAG_CHARS;
  const whitelist = Array.isArray(input.privacyWhitelist) ? input.privacyWhitelist : [];
  const sensitiveWords = Array.isArray(input.sensitiveWords) ? input.sensitiveWords : [];

  if (!tag) return { ok: false, reason: '空 tag' };
  if (charLength(tag) > maxTagChars) return { ok: false, reason: '超长' };
  if (!whitelist.includes(category)) return { ok: false, reason: 'category 不在白名单' };
  if (hitSensitiveWord(tag, sensitiveWords) !== null) return { ok: false, reason: '命中敏感词' };
  return { ok: true };
}

/**
 * 应用一次模型输出（校验 → 归一化 → 合并事件 → 7 天/50 tag 清理）。
 * 不写盘：返回新对象。
 */
export function applyExtraction(input: {
  userId: string;
  output: { tags?: Array<{ tag?: string; category?: string; permanent?: unknown }> } | undefined;
  existing: ProfileEventsFile;
  dictionaries: Dictionaries;
  privacyWhitelist: string[];
  now: number;
  maxTagsPerExtraction?: number;
  retentionDays?: number;
  maxTagsPerUser?: number;
  maxTagChars?: number;
  maxPermanentPerUser?: number;
}): {
  events: ProfileEventsFile;
  accepted: ExtractedTag[];
  rejected: Array<{ tag: string; reason: string }>;
} {
  const events = cloneEventsFile(input.existing);
  const accepted: ExtractedTag[] = [];
  const rejected: Array<{ tag: string; reason: string }> = [];

  const now = Number(input.now);
  const maxTagsPerExtraction = input.maxTagsPerExtraction ?? DEFAULT_MAX_TAGS_PER_EXTRACTION;
  const retentionDays = input.retentionDays ?? DEFAULT_RETENTION_DAYS;
  const maxTagsPerUser = input.maxTagsPerUser ?? DEFAULT_MAX_TAGS_PER_USER;
  const maxTagChars = input.maxTagChars ?? DEFAULT_MAX_TAG_CHARS;
  const maxPermanentPerUser = input.maxPermanentPerUser ?? DEFAULT_MAX_PERMANENT_PER_USER;

  const dictionaries = input.dictionaries ?? { sensitiveWords: [], synonyms: {}, negativeWords: [], memes: [], missing: [] };
  const synonyms = dictionaries.synonyms ?? {};
  const sensitiveWords = dictionaries.sensitiveWords ?? [];

  // 图纸 3.2：非 JSON / 解析失败 / tags 不是数组 → 整次提取跳过，不写入（events 原样）。
  const tags = (input.output as { tags?: unknown } | undefined)?.tags;
  if (!Array.isArray(tags)) {
    return {
      events,
      accepted,
      rejected: [{ tag: WHOLE_OUTPUT_TAG, reason: 'tags 不是数组' }],
    };
  }

  // 同一次提取里同一 normalized tag 只 push 一次时间戳（图纸 3.3 的 set 去重）。
  // 注：**跨次提取不去重** —— 图纸口径是「近 7 天出现 ≥3 次」，单位是「次提及」而非自然日；
  // 三次提取都提到同一 tag = 3 次，应当进正文（见 test-r4/r4-profile.mjs 的用例）。
  const pushedInThisRun = new Set<string>();

  for (const item of tags as Array<{ tag?: string; category?: string; permanent?: unknown } | null | undefined>) {
    // `item` 可能是 null/undefined（模型输出不可信）→ 先归一化成字符串再校验。
    const rawTag = typeof item?.tag === 'string' ? item.tag : String(item?.tag ?? '');
    const rawCategory = typeof item?.category === 'string' ? item.category : '';
    const normalized = normalizeTag(rawTag, synonyms);
    const category = rawCategory.trim();
    const rejectTag = normalized || rawTag.trim();

    const verdict = validateExtractedTag({
      tag: normalized,
      category,
      privacyWhitelist: input.privacyWhitelist ?? [],
      sensitiveWords,
      maxTagChars,
    });
    if (!verdict.ok) {
      rejected.push({ tag: rejectTag, reason: verdict.reason ?? '校验未通过' });
      continue;
    }

    // 图纸 3.2：单次最多 5 个 tag，按模型输出顺序取前 5，其余拒绝。
    if (accepted.length >= maxTagsPerExtraction) {
      rejected.push({ tag: normalized, reason: '超出单次 5 条上限' });
      continue;
    }

    // ★ 2026-11-04 双层记忆：永久/临时分流（category 硬规则优先于模型判断）。
    const permanent = resolvePermanent(category, item?.permanent);

    accepted.push({ tag: normalized, category, permanent });

    let event = events.events.find((candidate) => candidate.tag === normalized);
    if (!event) {
      event = { tag: normalized, category, timestamps: [], permanent };
      events.events.push(event);
    }
    // ★ 已存在的事件：**只允许「升格」**（临时 → 永久），不允许「降格」。
    //   理由：一个 tag 一旦被判定为稳定特征，后续某次模型误标 false 不该把它打回临时
    //   （否则画像正文会莫名其妙丢内容，且用户侧表现为"她突然忘记我"）。
    if (permanent && event.permanent !== true) {
      event.permanent = true;
      event.category = category;
    }
    if (!pushedInThisRun.has(normalized)) {
      pushedInThisRun.add(normalized);
      event.timestamps.push(now);
    }
  }

  const pruned = pruneEvents({ events, now, retentionDays, maxTagsPerUser, maxPermanentPerUser });
  return { events: pruned, accepted, rejected };
}

/**
 * 清理与淘汰：每个 tag 的 timestamps 只保留最近 `retentionDays` 天；
 * 过滤后为空的 tag 整条删除；tag 数超过 `maxTagsPerUser` 按最近提及时间降序保留前 N。
 * 不原地修改入参。
 */
export function pruneEvents(input: {
  events: ProfileEventsFile;
  now: number;
  retentionDays?: number;
  maxTagsPerUser?: number;
  maxPermanentPerUser?: number;
}): ProfileEventsFile {
  const now = Number(input.now);
  const windowMs = (input.retentionDays ?? DEFAULT_RETENTION_DAYS) * DAY_MS;
  const maxTagsPerUser = input.maxTagsPerUser ?? DEFAULT_MAX_TAGS_PER_USER;
  const maxPermanentPerUser = input.maxPermanentPerUser ?? DEFAULT_MAX_PERMANENT_PER_USER;

  const pruned: ProfileEventsFile = { events: [] };
  for (const event of cloneEventsFile(input.events).events) {
    // ★ 2026-11-04 双层记忆：**永久标签的时间戳永不过期** —— 7 天窗口对它不生效。
    //   否则"她永远记得你"会在 7 天后失效（快捷键：这里不能沿用 kept.length === 0 的删除逻辑）。
    if (event.permanent === true) {
      pruned.events.push({ ...event, timestamps: event.timestamps.slice() });
      continue;
    }
    // 临时事件：照旧「只保留最近 retentionDays 天的时间戳，过滤后为空的整条删除」。
    const kept = event.timestamps.filter((t) => {
      const value = Number(t);
      return Number.isFinite(value) && now - value <= windowMs;
    });
    if (kept.length === 0) continue; // 图纸 3.4：过滤后空 timestamps 的 tag 整条删除。
    pruned.events.push({ tag: event.tag, category: event.category, timestamps: kept, permanent: false });
  }

  // 总 tag 数上限（临时 + 永久一起算）：超过按最近提及时间降序保留前 N。
  if (pruned.events.length > maxTagsPerUser) {
    const ranked = pruned.events
      .map((event, index) => ({
        index,
        last: maxOf(event.timestamps),
      }))
      .sort((a, b) => b.last - a.last || a.index - b.index);
    const keepIndexes = new Set(ranked.slice(0, maxTagsPerUser).map((item) => item.index));
    pruned.events = pruned.events.filter((_event, index) => keepIndexes.has(index));
  }

  // ★ 永久标签单独上限（防无限膨胀）：超出时淘汰「最久未被提及」的永久标签。
  //   注意顺序：先按总上限裁完，再裁永久；避免永久标签把临时事件的额度吃光后又被总上限误杀。
  const permanents = pruned.events
    .map((event, index) => ({ event, index }))
    .filter((item) => item.event.permanent === true);
  if (permanents.length > maxPermanentPerUser) {
    const ranked = permanents
      .map((item) => ({ index: item.index, last: maxOf(item.event.timestamps) }))
      .sort((a, b) => b.last - a.last || a.index - b.index);
    const keep = new Set(ranked.slice(0, maxPermanentPerUser).map((item) => item.index));
    pruned.events = pruned.events.filter((event, index) => event.permanent !== true || keep.has(index));
  }

  return pruned;
}
