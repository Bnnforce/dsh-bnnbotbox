/**
 * milestones — 关系事实（R4.3 / F3）
 *
 * 阶段 C：**实现**（阶段 A 接口锁定）。
 *
 * ⚠️ 硬约束（主人明确要求）：
 *   · **不做等级播报**（绝不说「我们关系达到 Lv.3」）
 *   · 只产出「**可引用的关系事实**」：第一次聊到 X 是 N 天前 / 已经聊过 N 次
 *   · **冷启动 <3 天不注入**（不硬编亲密）
 *   · 同一事实 14 天只出一次（`phrase-cooldown`）
 *   · 惰性计算 + 按用户缓存（不新增定时任务）
 *
 * 数据来源（按优先级合并，缺失即降级）：
 *   ① `state/relationships/{groupId}.json` 里该用户的**可选**扩展字段
 *      `firstMetAt` / `messageCount` / `topicFirstSeen`（施工图纸 3.1 设计，但
 *      阶段 A 的 `RelationshipEntry` 类型未包含；这里按宽松类型只读，绝不写关系文件）；
 *   ② `state/milestone-cache.json` 的按用户缓存（`firstMetAt` 的长期兜底、
 *      topic 首次出现时间、`messageCount` 的历史最大值）；
 *   ③ `elysia/profiles/index.json` 的 `lastMentionedTags`（只取 tag 名做话题匹配）。
 *
 * 注意：关系文件的写路径（`state.ts`）只认识已声明字段，会在下一次计分时把
 * ①②里的扩展字段抹掉 —— 所以 `milestone-cache.json` 才是**持久真源**，
 * 关系文件字段只在「第一次观测到」时被采纳进缓存。任何异常 → `null`，绝不抛。
 */
import { join } from 'node:path';
import { isPlainObject, mutateJsonAtomic, readJsonSafe } from '../../shared/atomic.js';
import { relationshipsPath, profilesIndexPath, sanitizeId } from './paths.js';
import { pickUnused, markUsed } from './phrase-cooldown.js';
const DAY_MS = 24 * 60 * 60 * 1000;
/** 冷启动门槛（天）：认识不满 3 天 → 完全不出事实（不硬编亲密）。 */
const COLD_START_DAYS = 3;
/** 同一 kind 的冷却（天）。 */
const COOLDOWN_DAYS = 14;
/** 缓存文件版本（便于以后迁移；读侧不校验，向后兼容）。 */
const CACHE_VERSION = 1;
/** 时间戳上限（ms）：约 2100 年。超出视为脏数据（与 state.ts 口径一致）。 */
const MAX_TS = 4_102_444_800_000;
function addTopicPatch(patch, topic, at) {
    const topics = patch.topicFirstSeen ?? {};
    topics[topic] = at;
    patch.topicFirstSeen = topics;
}
/** 时间戳收敛到 `[0, MAX_TS]` 的整数；非法 → 0。 */
function toTs(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0 || n > MAX_TS)
        return 0;
    return Math.round(n);
}
/** 计数收敛到非负整数；非法 → 0。 */
function toCount(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0)
        return 0;
    return Math.floor(n);
}
/** 两个「首次时间」取更早的正数；任一为 0 取另一个。 */
function earliestPositive(a, b) {
    if (a > 0 && b > 0)
        return Math.min(a, b);
    return a > 0 ? a : b;
}
function cachePathOf(root) {
    return join(root, 'state', 'milestone-cache.json');
}
function normalizeUserCache(raw) {
    const user = { firstMetAt: 0, messageCount: 0, topicFirstSeen: {} };
    if (!isPlainObject(raw))
        return user;
    user.firstMetAt = toTs(raw.firstMetAt);
    user.messageCount = toCount(raw.messageCount);
    const topicsRaw = raw.topicFirstSeen;
    if (isPlainObject(topicsRaw)) {
        for (const [key, value] of Object.entries(topicsRaw)) {
            const topic = String(key ?? '').trim();
            const at = toTs(value);
            if (topic && at > 0)
                user.topicFirstSeen[topic] = at;
        }
    }
    return user;
}
/** 把任意磁盘内容收敛成可用的缓存结构（坏文件 → 空缓存）。 */
function normalizeCache(raw) {
    const file = { version: CACHE_VERSION, users: {} };
    if (!isPlainObject(raw))
        return file;
    const usersRaw = raw.users;
    if (!isPlainObject(usersRaw))
        return file;
    for (const [key, value] of Object.entries(usersRaw)) {
        const id = String(key ?? '').trim();
        if (!id)
            continue;
        file.users[id] = normalizeUserCache(value);
    }
    return file;
}
function readCache(root) {
    try {
        return normalizeCache(readJsonSafe(cachePathOf(root)));
    }
    catch {
        return normalizeCache(undefined);
    }
}
/**
 * 合并写缓存（读-改-写一体，避免覆盖别处更新）。
 * 合并规则：firstMetAt 取更早、messageCount 取更大、topicFirstSeen 取更早。
 * 写失败静默（最多下次重新观测，不影响主聊天）。
 */
function persistCache(root, cacheKey, patch) {
    try {
        mutateJsonAtomic(cachePathOf(root), (previous) => {
            const file = normalizeCache(previous);
            const current = file.users[cacheKey] ?? { firstMetAt: 0, messageCount: 0, topicFirstSeen: {} };
            const merged = {
                firstMetAt: earliestPositive(current.firstMetAt, patch.firstMetAt ?? 0),
                messageCount: Math.max(current.messageCount, patch.messageCount ?? 0),
                topicFirstSeen: { ...current.topicFirstSeen },
            };
            const pendingTopics = patch.topicFirstSeen ?? {};
            for (const [topic, at] of Object.entries(pendingTopics)) {
                merged.topicFirstSeen[topic] = earliestPositive(merged.topicFirstSeen[topic] ?? 0, at);
            }
            file.users[cacheKey] = merged;
            return file;
        });
    }
    catch {
        /* 缓存写失败不阻塞事实生成；下次调用会重新观测 */
    }
}
/** 读关系记录里的可选扩展字段（类型未声明，宽松读取；缺失 → 0/空）。 */
function readRelationshipExtras(groupId, userId, root) {
    const out = { firstMetAt: 0, messageCount: 0, topicFirstSeen: {} };
    try {
        const path = relationshipsPath(groupId, root);
        if (!path)
            return out;
        const raw = readJsonSafe(path);
        if (!isPlainObject(raw))
            return out;
        const entry = raw[userId];
        if (!isPlainObject(entry))
            return out;
        out.firstMetAt = toTs(entry.firstMetAt);
        out.messageCount = toCount(entry.messageCount);
        const topicsRaw = entry.topicFirstSeen;
        if (isPlainObject(topicsRaw)) {
            for (const [key, value] of Object.entries(topicsRaw)) {
                const topic = String(key ?? '').trim();
                const at = toTs(value);
                if (topic && at > 0)
                    out.topicFirstSeen[topic] = at;
            }
        }
    }
    catch {
        /* 关系文件读不到 = 当作没有扩展字段（缓存兜底） */
    }
    return out;
}
/** 读画像索引里该用户已有的 tag 名（只取键；值格式新旧都无影响）。 */
function readProfileTags(userId, root) {
    const tags = new Set();
    try {
        const raw = readJsonSafe(profilesIndexPath(root));
        if (!isPlainObject(raw))
            return tags;
        const entry = raw[userId];
        if (!isPlainObject(entry))
            return tags;
        const tagsRaw = entry.lastMentionedTags;
        if (!isPlainObject(tagsRaw))
            return tags;
        for (const tag of Object.keys(tagsRaw)) {
            const name = String(tag ?? '').trim();
            if (name)
                tags.add(name);
        }
    }
    catch {
        /* 画像索引不可读 → 只是没有 first_topic 候选 */
    }
    return tags;
}
/**
 * 当前话题与画像 tag 匹配：先精确匹配，再允许「短话题被长 tag 包含」。
 * 单字话题只接受精确匹配，避免「猫」匹配到「猫图/猫咪/熊猫」造成误报。
 */
function matchProfileTag(topic, tags) {
    if (tags.has(topic))
        return topic;
    for (const tag of tags) {
        if (topic.length >= 2 && tag.includes(topic))
            return tag;
        if (tag.length >= 2 && topic.includes(tag))
            return tag;
    }
    return '';
}
/**
 * 取一条当前可用的关系事实。
 * @returns `null` = 本轮不注入（冷启动 / 无数据 / 冷却中 / 任何异常）
 */
export function milestoneFor(input) {
    try {
        if (!input || typeof input !== 'object')
            return null;
        const now = toTs(input.now);
        if (now <= 0)
            return null;
        const groupId = sanitizeId(input.groupId);
        const userId = sanitizeId(input.userId);
        if (!groupId || !userId)
            return null;
        const root = String(input.root ?? '');
        if (!root)
            return null;
        const cacheKey = `${groupId}:${userId}`;
        const cached = readCache(root).users[cacheKey]
            ?? { firstMetAt: 0, messageCount: 0, topicFirstSeen: {} };
        const rel = readRelationshipExtras(groupId, userId, root);
        // ① 认识时间：关系文件（若被外部写入）优先，缓存兜底；都没有 → 本轮首次观测。
        let firstMetAt = earliestPositive(rel.firstMetAt, cached.firstMetAt);
        if (firstMetAt <= 0)
            firstMetAt = now;
        // ② 消息数：取关系文件与缓存的历史最大值（没有数据源就是 0）。
        const messageCount = Math.max(rel.messageCount, cached.messageCount);
        // ③ topic 首次出现：关系文件 + 缓存合并。
        const topicFirstSeen = { ...cached.topicFirstSeen };
        for (const [topic, at] of Object.entries(rel.topicFirstSeen)) {
            topicFirstSeen[topic] = earliestPositive(topicFirstSeen[topic] ?? 0, at);
        }
        // 合并结果里相对缓存有新增 → 本轮落盘（冷启动返回前也要落，保证起点固定）。
        const patch = {};
        if (firstMetAt !== cached.firstMetAt)
            patch.firstMetAt = firstMetAt;
        if (messageCount !== cached.messageCount)
            patch.messageCount = messageCount;
        for (const [topic, at] of Object.entries(topicFirstSeen)) {
            if ((cached.topicFirstSeen[topic] ?? 0) !== at) {
                addTopicPatch(patch, topic, at);
            }
        }
        // 当前话题命中画像 tag → 记录（或取出）该话题的首次出现时间。
        // 没有传 topics（现网 index.ts 就没传）→ 连画像索引都不读，省一次 IO。
        const topics = Array.isArray(input.topics) ? input.topics : [];
        const tags = topics.length > 0 ? readProfileTags(userId, root) : new Set();
        const matched = [];
        for (const rawTopic of topics) {
            const topic = String(rawTopic ?? '').trim();
            if (!topic || !matchProfileTag(topic, tags))
                continue;
            const known = topicFirstSeen[topic] ?? 0;
            if (known <= 0) {
                // 第一次在对话里观测到该话题：只记录，不立刻说「0 天前」。
                topicFirstSeen[topic] = now;
                addTopicPatch(patch, topic, now);
                continue;
            }
            matched.push({ topic, at: known });
        }
        if (patch.firstMetAt !== undefined || patch.messageCount !== undefined || patch.topicFirstSeen) {
            persistCache(root, cacheKey, patch);
        }
        // 冷启动：认识不满 3 天 → 一条事实都不出。
        if (now - firstMetAt < COLD_START_DAYS * DAY_MS)
            return null;
        // 候选事实（优先级从高到低；同一轮只取 1 条）。
        const candidates = [];
        if (matched.length > 0) {
            matched.sort((a, b) => (a.at - b.at) || a.topic.localeCompare(b.topic));
            const chosen = matched[0];
            if (chosen) {
                const days = Math.floor((now - chosen.at) / DAY_MS);
                if (days >= 1) {
                    candidates.push({
                        kind: 'first_topic',
                        text: `你们第一次聊到「${chosen.topic}」是 ${days} 天前`,
                        at: now,
                    });
                }
            }
        }
        const knownDays = Math.floor((now - firstMetAt) / DAY_MS);
        if (knownDays >= COLD_START_DAYS) {
            candidates.push({ kind: 'days_known', text: `你们认识 ${knownDays} 天了`, at: now });
        }
        if (messageCount > 0) {
            candidates.push({ kind: 'message_count', text: `你们已经聊过 ${messageCount} 次了`, at: now });
        }
        for (const candidate of candidates) {
            const key = `milestone:${groupId}:${userId}:${candidate.kind}`;
            // 同一 kind 14 天只出一次；不同 kind 的 key 不同，互不影响。
            if (!pickUnused([key], COOLDOWN_DAYS, root, now, () => 0))
                continue;
            markUsed(key, root, now);
            return candidate;
        }
        return null;
    }
    catch {
        // 红线：绝不抛到调用方。
        return null;
    }
}
