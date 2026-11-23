/**
 * R4.0 状态读写层（阶段一基建）：把四个持久化对象包成「读失败 → 默认/跳过 + warn」。
 *
 * 红线（0.1 / 0.2）：所有读 try-catch；所有写原子；**绝不抛到顶层**。
 * 本文件**不做业务判定**（那属于各模块纯函数），只负责「磁盘 ↔ 内存对象」。
 */
import { readJsonSafe, writeJsonAtomic, isPlainObject, mutateJsonAtomic } from '../../shared/atomic.js';
import { extractionStatePath, heartbeatPath, profileEventsPath, profilesIndexPath, relationshipsPath, } from './paths.js';
import { logWarn } from './logger.js';
import { EMPTY_HEARTBEAT_STATE, SCORE_KINDS, emptyRelationshipEntry, } from './types.js';
/* ───────────── heartbeat ───────────── */
/** 时间戳上限（ms）：约 2100 年。超出的时间戳一律按 0（脏数据），防「永久跳过」死锁。 */
const MAX_TS = 4_102_444_800_000;
/** 把可能损坏的时间戳收敛到 [0, MAX_TS]（`Infinity`/`NaN`/负数/极远未来 → 0）。 */
function toTs(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0 || n > MAX_TS)
        return 0;
    return Math.round(n);
}
/** 读心跳状态；缺失/损坏 → 空状态（date 留空，交给 resetIfNewDay）。 */
export function readHeartbeat(groupId, root, logger) {
    const path = heartbeatPath(groupId, root);
    if (!path) {
        logWarn(logger, `[r4] 心跳：groupId 非法（${short(groupId)}）→ 按空状态处理`);
        return { ...EMPTY_HEARTBEAT_STATE };
    }
    const raw = readJsonSafe(path);
    if (!isPlainObject(raw))
        return { ...EMPTY_HEARTBEAT_STATE };
    const state = String(raw.state ?? '');
    const s = {
        date: typeof raw.date === 'string' ? raw.date : '',
        dailyCount: toInt(raw.dailyCount, 0),
        lastNonBotMessageAt: toTs(raw.lastNonBotMessageAt),
        lastBotMessageAt: toTs(raw.lastBotMessageAt),
        state: state === 'waiting' || state === 'cooldown' ? state : 'normal',
        cold: raw.cold === true,
        coldSetAt: toTs(raw.coldSetAt),
        waitingUntil: toTs(raw.waitingUntil),
        cooldownUntil: toTs(raw.cooldownUntil),
    };
    return s;
}
/** 原子写心跳状态；失败 warn 并返回 false（调用方据此不发送）。 */
export function writeHeartbeat(groupId, state, root, logger) {
    const path = heartbeatPath(groupId, root);
    if (!path) {
        logWarn(logger, `[r4] 心跳：groupId 非法（${short(groupId)}）→ 不写盘`);
        return false;
    }
    return writeJsonAtomic(path, state, logger);
}
/* ───────────── relationships ───────────── */
function relationshipEntryOf(raw, initial) {
    const base = emptyRelationshipEntry(initial.level, initial.score);
    if (!isPlainObject(raw))
        return base;
    const cooldowns = isPlainObject(raw.scoreCooldowns) ? raw.scoreCooldowns : {};
    const out = {
        ...base,
        level: pickLevel(raw.level) ?? base.level,
        score: clampScore(toInt(raw.score, base.score)),
        lastDecayAt: toInt(raw.lastDecayAt, 0),
        updatedAt: toInt(raw.updatedAt, 0),
        temporaryAttitude: typeof raw.temporaryAttitude === 'string' ? raw.temporaryAttitude : '',
        temporaryAttitudeExpiresAt: toInt(raw.temporaryAttitudeExpiresAt, 0),
        /**
         * ★ 2026-11-05 R4.3（F3）：关系统计字段**必须原样保留**。
         *   关系写路径是「读整份 → 改 → 写整份」，这里若不保留，
         *   每次 applyScore 都会把 firstMetAt / messageCount 抹掉。
         */
        firstMetAt: toInt(raw.firstMetAt, 0),
        messageCount: toInt(raw.messageCount, 0),
    };
    for (const kind of SCORE_KINDS)
        out.scoreCooldowns[kind] = toInt(cooldowns[kind], 0);
    return out;
}
/** 读整份 relationships；缺失 → 空对象（不 warn）。 */
export function readRelationships(groupId, root, initial, logger) {
    const path = relationshipsPath(groupId, root);
    if (!path) {
        logWarn(logger, `[r4] 关系：groupId 非法（${short(groupId)}）→ 按空对象处理`);
        return {};
    }
    const raw = readJsonSafe(path);
    if (!isPlainObject(raw))
        return {};
    const out = {};
    for (const [userId, entry] of Object.entries(raw)) {
        const id = String(userId ?? '').trim();
        if (!id)
            continue;
        out[id] = relationshipEntryOf(entry, initial);
    }
    return out;
}
/** 原子写整份 relationships。 */
export function writeRelationships(groupId, file, root, logger) {
    const path = relationshipsPath(groupId, root);
    if (!path) {
        logWarn(logger, `[r4] 关系：groupId 非法（${short(groupId)}）→ 不写盘`);
        return false;
    }
    return writeJsonAtomic(path, file, logger);
}
/**
 * 关系计分的**读-改-写**一体入口（2026-11-03 修复 P2-2 覆盖风险）。
 *
 * 在同一个同步原子段内「读整份文件 → 算单条 → 写回」，杜绝
 * 「先 read 拿到快照、await 之后整份写回」覆盖别处对同一文件的更新。
 *
 * @returns `{ ok, scored, entryBefore }`；身份非法或写盘失败 → `ok: false`（不抛）。
 */
export function mutateRelationship(groupId, userId, root, initial, mutate, logger) {
    const path = relationshipsPath(groupId, root);
    if (!path) {
        logWarn(logger, `[r4] 关系：groupId 非法（${short(groupId)}）→ 跳过`);
        return { ok: false };
    }
    const id = String(userId ?? '').trim();
    if (!id)
        return { ok: false };
    let next;
    const result = mutateJsonAtomic(path, (previous) => {
        const file = {};
        if (isPlainObject(previous)) {
            for (const [key, value] of Object.entries(previous)) {
                const k = String(key ?? '').trim();
                if (!k)
                    continue;
                file[k] = relationshipEntryOf(value, initial);
            }
        }
        const base = file[id] ? relationshipEntryOf(file[id], initial) : emptyRelationshipEntry(initial.level, initial.score);
        next = mutate(base, file);
        file[id] = next;
        return file;
    }, logger);
    return result.ok && next ? { ok: true, entry: next } : { ok: false };
}
/* ───────────── profiles/index ───────────── */
function indexEntryOf(raw) {
    if (!isPlainObject(raw))
        return { lastMentionedTags: {}, coldStartUntil: 0 };
    const tagsRaw = isPlainObject(raw.lastMentionedTags) ? raw.lastMentionedTags : {};
    /**
     * ★ 2026-11-05 R4.3 修（批次 C 报告指出的闭环缺口）：
     *   原先这里对所有值 `toInt(at, 0)` —— 新的 `{at,count}` 对象会被读成 0，
     *   等于把 F2 的提及次数永久归零。现在**两种形态都保留**：
     *     · 裸数字（旧数据）→ 原样保留
     *     · `{at,count}`（新数据）→ 结构校验后保留
     */
    const tags = {};
    for (const [tag, at] of Object.entries(tagsRaw)) {
        const t = String(tag ?? '').trim();
        if (!t)
            continue;
        if (isPlainObject(at)) {
            tags[t] = { at: toInt(at.at, 0), count: Math.max(0, toInt(at.count, 0)) };
        }
        else {
            tags[t] = toInt(at, 0);
        }
    }
    return { lastMentionedTags: tags, coldStartUntil: toInt(raw.coldStartUntil, 0) };
}
/** 读 `profiles/index.json`；缺失 → 空对象。 */
export function readProfileIndex(root, logger) {
    const path = profilesIndexPath(root);
    if (!path)
        return {};
    const raw = readJsonSafe(path);
    if (!isPlainObject(raw))
        return {};
    const out = {};
    for (const [userId, entry] of Object.entries(raw)) {
        const id = String(userId ?? '').trim();
        if (!id)
            continue;
        out[id] = indexEntryOf(entry);
    }
    return out;
}
/** 原子写 `profiles/index.json`。 */
export function writeProfileIndex(index, root, logger) {
    const path = profilesIndexPath(root);
    if (!path)
        return false;
    return writeJsonAtomic(path, index, logger);
}
/**
 * `profiles/index.json` 的**读-改-写**一体入口（2026-11-03 修复 P2-2）。
 *
 * `markTagMentionsByReply` 与 `persistExtraction` 都会改这份文件；
 * 各自「读快照 → 写整份」会互相丢更新（lastMentionedTags 丢失 / 冷启动被覆盖）。
 */
export function mutateProfileIndex(root, mutate, logger) {
    const path = profilesIndexPath(root);
    if (!path)
        return false;
    let next;
    const result = mutateJsonAtomic(path, (previous) => {
        const index = {};
        if (isPlainObject(previous)) {
            for (const [userId, entry] of Object.entries(previous)) {
                const id = String(userId ?? '').trim();
                if (!id)
                    continue;
                index[id] = indexEntryOf(entry);
            }
        }
        next = mutate(index);
        return next;
    }, logger);
    return result.ok && next !== undefined;
}
/* ───────────── profile-events ───────────── */
/** 读某用户的事件文件；缺失/损坏 → 空。 */
export function readProfileEvents(userId, root, logger) {
    const path = profileEventsPath(userId, root);
    if (!path) {
        logWarn(logger, `[r4] 画像：userId 非法（${short(userId)}）→ 按空事件处理`);
        return { events: [] };
    }
    const raw = readJsonSafe(path);
    if (!isPlainObject(raw) || !Array.isArray(raw.events))
        return { events: [] };
    const events = [];
    for (const item of raw.events) {
        if (!isPlainObject(item))
            continue;
        const tag = String(item.tag ?? '').trim();
        const category = String(item.category ?? '').trim();
        if (!tag)
            continue;
        const timestamps = Array.isArray(item.timestamps)
            ? item.timestamps.map((t) => toTs(t)).filter((t) => t > 0)
            : [];
        // ★ 2026-11-04 双层记忆：permanent 必须原样保留（缺省 false = 临时事件，向后兼容）。
        events.push({ tag, category, timestamps, permanent: item.permanent === true });
    }
    return { events };
}
/** 原子写某用户的事件文件。 */
export function writeProfileEvents(userId, file, root, logger) {
    const path = profileEventsPath(userId, root);
    if (!path) {
        logWarn(logger, `[r4] 画像：userId 非法（${short(userId)}）→ 不写盘`);
        return false;
    }
    return writeJsonAtomic(path, file, logger);
}
/* ───────────── extraction-state ───────────── */
/** 读提取状态；缺失 → `{lastRunDate:''}`。 */
export function readExtractionState(root, logger) {
    const raw = readJsonSafe(extractionStatePath(root));
    if (!isPlainObject(raw))
        return { lastRunDate: '' };
    return { lastRunDate: typeof raw.lastRunDate === 'string' ? raw.lastRunDate : '' };
}
/** 原子写提取状态（成功或失败都写「今天」）。 */
export function writeExtractionState(state, root, logger) {
    return writeJsonAtomic(extractionStatePath(root), state, logger);
}
/* ───────────── 小工具 ───────────── */
function toInt(value, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n))
        return fallback;
    return Math.round(n);
}
function clampScore(n) {
    return Math.max(-100, Math.min(100, n));
}
function pickLevel(value) {
    const s = String(value ?? '').trim().toUpperCase();
    return s === 'L0' || s === 'L1' || s === 'L2' || s === 'L3' ? s : undefined;
}
/** 便于调用方一次性拿「该用户的条目」（不存在就按初始值造一条，不写盘）。 */
export function entryForUser(file, userId, initial) {
    return file[userId] ? { ...file[userId], scoreCooldowns: { ...file[userId].scoreCooldowns } } : emptyRelationshipEntry(initial.level, initial.score);
}
/** 把一条更新过的记录放回去（返回新对象，便于原子写）。 */
export function putEntry(file, userId, entry) {
    return { ...file, [userId]: entry };
}
/** 分数对应的计分量（`reply`/`mention`/`bot`）。 */
export function scoreDelta(kind, cfg) {
    if (kind === 'reply')
        return cfg.score_reply;
    if (kind === 'mention')
        return cfg.score_mention;
    return cfg.score_bot;
}
/** 诊断：把可能含敏感内容的字符串截短（日志用）。 */
export function short(value, max = 40) {
    const s = String(value ?? '').replace(/\s+/gu, ' ').trim();
    const chars = [...s];
    return chars.length <= max ? s : `${chars.slice(0, max).join('')}…`;
}
