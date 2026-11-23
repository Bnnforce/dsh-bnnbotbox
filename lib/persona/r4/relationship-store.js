/**
 * R4.0 关系网入库编排（写盘侧）：把「消息判定 → 计分/衰减 → 原子写」串起来。
 *
 * 模块四（relationship.ts）是纯函数；本文件负责 IO 与「三选一计分」的业务判定。
 */
import { readRelationships, mutateRelationship, mutateProfileIndex } from './state.js';
import { logInfo, logWarn } from './logger.js';
import { applyDecay, canScore, presentLowLevelUsers, scoreEvent, setTemporaryCold, lazyExpireAttitude, relationshipTag, shouldInjectContest, levelForScore, } from './relationship.js';
import { markTagMentioned } from './profile.js';
/** 判定一条消息属于哪种计分类型；null = 都不属于。 */
export function classifyScoreKind(input) {
    if (input.quoteBot)
        return 'mention';
    if (input.atBot)
        return 'bot';
    const text = String(input.text ?? '');
    if (text && input.memeWords.some((w) => w && text.includes(w)))
        return 'reply';
    return null;
}
/** 对某用户计一次分（含衰减、冷却、升降级）。**原子写失败 → warn 返回 scored:false**。 */
export function applyScore(input) {
    const { groupId, userId, kind, root, now, cfg, logger } = input;
    const initial = { level: cfg.initial_level, score: cfg.initial_score };
    let before;
    let scoreBefore;
    let scored = false;
    let reason;
    // 读-改-写一体（2026-11-03 修复 P2-2）：避免 await 窗口外整份覆盖别处更新。
    const result = mutateRelationship(groupId, userId, root, initial, (base) => {
        const decayed = lazyExpireAttitude(applyDecay(base, now, cfg), now);
        before = decayed.level;
        scoreBefore = decayed.score;
        if (!canScore(decayed, kind, now, cfg)) {
            // 冷却中：仍落盘衰减后的分数（衰减本身是写入时机之一），但不算分。
            reason = '冷却中（scoreCooldowns 未到期）';
            return decayed;
        }
        const next = scoreEvent(decayed, kind, now, cfg);
        scored = true;
        return next;
    }, logger);
    if (!result.ok) {
        logWarn(logger, `[r4] 关系：${groupId}/${userId} 计分写盘失败 → 本次跳过（不重试）`);
        return { scored: false, kind, reason: '写盘失败', before, scoreBefore };
    }
    const after = result.entry;
    if (scored && after && before && after.level !== before) {
        logInfo(logger, `[r4] 关系：${groupId}/${userId} ${before} → ${after.level}（${scoreBefore} → ${after.score}，${kind}）`);
    }
    if (!scored)
        return { scored: false, kind, reason: reason ?? '未计分', before, scoreBefore };
    return {
        scored: true,
        kind,
        before,
        after: after?.level,
        scoreBefore,
        scoreAfter: after?.score,
    };
}
/** 越界行为 → 临时「冷淡」（不改 level/score）。 */
export function applyTemporaryCold(input) {
    const { groupId, userId, root, now, cfg, logger } = input;
    const initial = { level: cfg.initial_level, score: cfg.initial_score };
    const result = mutateRelationship(groupId, userId, root, initial, (base) => setTemporaryCold({ entry: base, now }), logger);
    if (result.ok)
        logInfo(logger, `[r4] 关系：${groupId}/${userId} 已标记「冷淡」`);
    return result.ok;
}
/** 争宠上下文：返回 { presentLow, contest }。 */
export function contestContext(input) {
    const { groupId, currentUserId, messages, root, now, cfg, logger } = input;
    const file = readRelationships(groupId, root, { level: cfg.initial_level, score: cfg.initial_score }, logger);
    const current = file[currentUserId];
    const currentLevel = current?.level;
    const presentLow = presentLowLevelUsers({ messages, relationships: file, now });
    return { presentLow, contest: shouldInjectContest({ currentLevel, presentLow }), currentLevel };
}
/** 按群+用户取关系标签文本（读侧；缺失按 L2）。 */
export function readRelationshipTag(input) {
    const { groupId, userId, root, cfg, levels, logger } = input;
    const file = readRelationships(groupId, root, { level: cfg.initial_level, score: cfg.initial_score }, logger);
    const entry = file[userId];
    // 契约：level 缺省 → 按 L2 文案（`[当前关系标签：普通]`）。
    return relationshipTag(entry?.level ?? 'L2', levels);
}
/** 其他在场标签（读侧）：当前群在场但有关系记录的其他用户，按字典序。 */
export function readOtherTags(input) {
    const { groupId, currentUserId, messages, root, now, cfg, levels, logger } = input;
    const file = readRelationships(groupId, root, { level: cfg.initial_level, score: cfg.initial_score }, logger);
    const present = new Set(messages
        .filter((m) => !m.self && now - m.at <= 30 * 60 * 1000)
        .map((m) => m.senderId));
    const out = [];
    for (const [userId, entry] of Object.entries(file)) {
        if (userId === currentUserId)
            continue;
        if (!present.has(userId))
            continue;
        const name = levels[entry.level] ?? levels.L2;
        out.push({ userId, text: `[${userId}：${name}]` });
    }
    return out.sort((a, b) => a.userId.localeCompare(b.userId)).slice(0, 5);
}
/** 记录「AI 主动提及某 tag」（画像模块的 lastMentionedTags）。 */
export function markTagMentionsByReply(input) {
    const { userId, tags, root, now, logger } = input;
    const listed = tags.filter(Boolean);
    if (listed.length === 0)
        return;
    // 读-改-写一体（2026-11-03 修复 P2-2）：与 persistExtraction 的 coldStartUntil 写入不互相覆盖。
    const ok = mutateProfileIndex(root, (index) => {
        let next = index;
        for (const tag of listed)
            next = markTagMentioned({ index: next, userId, tag, now });
        return next;
    }, logger);
    if (!ok)
        logWarn(logger, '[r4] 画像：lastMentionedTags 写盘失败');
}
/** 把分数重算等级（供测试/迁移）。 */
export function normalizeLevel(score, cfg) {
    return levelForScore(score, cfg.level_bounds);
}
