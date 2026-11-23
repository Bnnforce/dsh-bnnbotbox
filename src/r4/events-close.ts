/**
 * events-close — 事件闭环判定（R4.3 / F1）
 *
 * 批次 B：**完整实现**（阶段 A1 曾为骨架）。
 *
 * 闭环的意义：一条「要考试」的事件如果永远 open，会一直挂着被召回，
 * 半个月后提起来就很怪。所以要有明确的收口：
 *   · 用户自述完成（"考完了/结束了/通过了"）→ done
 *   · 超过 expire_days 仍未闭环 → expired（惰性判定，不新增定时任务）
 *
 * ⚠️ 误判防护：只有 **type 匹配 + 关键词命中** 双满足才关，不确定就不关。
 *   （"过了"这类词太常见，必须靠事件关键词兜底；关键词一个都不出现就不动手。）
 *
 * 本文件是纯函数：不改入参、不读写盘、不取当前时间（时间由调用方传入）。
 */

import type { EventRecord, EventType, EventsConfig } from './types.js';

/** 一天毫秒数（与配置单位一致）。 */
const DAY_MS = 86_400_000;

/** `closeExpired` 的兜底过期天数（与 `DEFAULT_CONFIG.events_config.expire_days` 一致，仅防非法 config）。 */
const FALLBACK_EXPIRE_DAYS = 4;

/**
 * 完成词表（按事件类型分组）。
 *
 * 注意：只放「基本不歧义」的完成表达；"过了"单独看很歧义，
 * 但必须同时命中事件关键词才会关，因此可以接受。
 */
const DONE_WORDS: Record<EventType, readonly string[]> = {
  exam: ['考完', '考了', '写完了', '结束了'],
  project: ['过了', '上线', '交付了', '验收了'],
  interview: ['面完了', '面试完'],
  trip: ['回来了', '到了'],
  health: ['好了', '出院了'],
  move: ['搬完了'],
  game: ['打完了', '赢了'],
  other: [],
};

/** 统计 `words` 中有多少个（去重后）出现在正文里。含英文字母时忽略大小写。 */
function countHits(words: readonly string[], body: string): number {
  if (!body) return 0;
  const haystack = body.toLowerCase();
  const seen = new Set<string>();
  for (const raw of words) {
    const word = String(raw ?? '').trim();
    if (!word) continue;
    const key = word.toLowerCase();
    if (seen.has(key)) continue;
    if (haystack.includes(key)) seen.add(key);
  }
  return seen.size;
}

/**
 * 正文暗示事件完成 → 把对应事件置 `done`。
 *
 * 匹配规则（三条同时满足）：
 *   ① 事件 `open` 且 type 对应的完成词出现在正文；
 *   ② 该事件的 `keywords` 至少一个出现在正文（防误判）；
 *   ③ 一次只关最匹配的 1 条（关键词命中数多者优先，同分取 updatedAt 较新者）。
 *
 * @returns 新数组（不原地改入参）
 */
export function markDone(events: EventRecord[], text: string, now: number): EventRecord[] {
  const source = Array.isArray(events) ? events : [];
  try {
    const body = String(text ?? '');
    if (!body) return source.slice();
    const stamp = Number.isFinite(now) ? now : Date.now();

    let bestIndex = -1;
    let bestHits = 0;
    let bestUpdatedAt = Number.NEGATIVE_INFINITY;
    let bestWord = '';

    for (let index = 0; index < source.length; index += 1) {
      const event = source[index];
      if (!event || event.status !== 'open') continue;

      const words = DONE_WORDS[event.type] ?? [];
      const word = words.find((candidate) => body.includes(candidate));
      if (!word) continue;

      const hits = countHits(event.keywords, body);
      if (hits <= 0) continue;

      const updatedAt = Number.isFinite(event.updatedAt) ? event.updatedAt : event.createdAt;
      // 命中关键词多的优先；同分时优先最近有进展的那条。
      if (hits > bestHits || (hits === bestHits && updatedAt > bestUpdatedAt)) {
        bestIndex = index;
        bestHits = hits;
        bestUpdatedAt = updatedAt;
        bestWord = word;
      }
    }

    if (bestIndex < 0) return source.slice();

    const result = source.slice();
    const target = result[bestIndex];
    if (!target) return result;
    result[bestIndex] = {
      ...target,
      status: 'done',
      closeWhy: `正文命中完成词「${bestWord}」`,
      updatedAt: stamp,
    };
    return result;
  } catch {
    return Array.isArray(events) ? events.slice() : [];
  }
}

/**
 * 过期判定（**惰性**：读取时算，不依赖定时任务）。
 *
 * `status === 'open'` 且 `now - createdAt > expire_days * DAY` → `'expired'`。
 * 已 done / 已 expired 的记录保持原状；不改 `updatedAt`（纯状态迁移）。
 *
 * @returns 新数组（不原地改入参）
 */
export function closeExpired(events: EventRecord[], now: number, config: EventsConfig): EventRecord[] {
  const source = Array.isArray(events) ? events : [];
  try {
    const stamp = Number.isFinite(now) ? now : Date.now();
    const configured = config && typeof config.expire_days === 'number' && Number.isFinite(config.expire_days) && config.expire_days > 0
      ? config.expire_days
      : FALLBACK_EXPIRE_DAYS;
    const expireMs = configured * DAY_MS;

    return source.map((event): EventRecord => {
      if (!event || event.status !== 'open') return event;
      if (!Number.isFinite(event.createdAt)) return event;
      if (stamp - event.createdAt <= expireMs) return event;
      return { ...event, status: 'expired' };
    });
  } catch {
    return Array.isArray(events) ? events.slice() : [];
  }
}
