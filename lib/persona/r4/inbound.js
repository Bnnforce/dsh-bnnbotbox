/**
 * r4/inbound — 逐条入站真人消息的处理入口
 *
 * 从 `r4/index.ts` 拆出（重构阶段 2 / 批次 C）。
 * 由 `src/index.ts` 的 `session/event` 监听器调用，负责：关系计分 / 凌晨装死 / 临时冷淡。
 */
import { sanitizeId } from './paths.js';
import { zonedTime, isSleepWindow, sleepWokeText, resolveTimeZone, shouldWake } from './time.js';
import { dayKeyOf } from './sample.js';
import { readHeartbeat, writeHeartbeat, readRelationships, writeRelationships } from './state.js';
import { resetIfNewDay } from './heartbeat.js';
import { HEARTBEAT_WAKE_MARKER } from './heartbeat-gen.js';
import { applyScore, classifyScoreKind, applyTemporaryCold } from './relationship-store.js';
import { emptyRelationshipEntry } from './types.js';
/** 粗暴但保守的越界判定：只认明确辱骂/攻击人格的词，避免误伤日常吐槽。 */
const ABUSE_RE = /(傻逼|煞笔|沙比|草泥马|操你妈|你妈死了|死全家|去死吧|滚出群|你就是个垃圾|破ai|垃圾ai)/iu;
function isAbusive(text) {
    return ABUSE_RE.test(String(text ?? ''));
}
function randomFnOf(host) {
    return host.random ?? Math.random;
}
/**
 * R4 处理一条入站真人消息（由 `src/index.ts` 的 `session/event` 监听器调用）。
 *
 * 对应图纸：
 *  - 4.1 计分：命中梗词典/关键词 → `reply`；引用 bot → `mention`；@bot → `bot`；
 *  - 4.2 越界（辱骂/刷屏/攻击人格）→ 临时「冷淡」；
 *  - 2.3 时间字段：更新 `lastNonBotMessageAt`；
 *  - 模块一 凌晨装死：处于 02:00-06:00 时按 `wake_probability` 决定这条是否放行。
 *
 * @returns 是否放行（false = 应静默丢弃，但仍然更新 lastNonBotMessageAt）；
 *          `wokeText` 非空 = 本次是「凌晨被吵醒后放行」，注入层应追加该状态文案（图纸模块一）。
 */
export function handleIncomingMessage(runtime, input) {
    // ═══════════════════════════════════════════════════════════════════════
    // ★ 2026-11-05 心跳 wake 守卫（第二道；第一道在 `review-collector.ts`）
    //
    //   心跳 wake 注入的是一条 `source.kind='user'` 的消息，但**不是真人发言**：
    //     · 不写 `lastNonBotMessageAt` —— 否则心跳自己给自己续命，死群判定永久失效
    //     · 不计分、不改任何 state（关系统计 / 凌晨装死 / 冷淡全部跳过）
    //   标记常量必须引用 `heartbeat-gen` 导出，禁止硬编码。
    // ═══════════════════════════════════════════════════════════════════════
    if (String(input.text ?? '').startsWith(HEARTBEAT_WAKE_MARKER)) {
        return { allow: false, scored: false, reason: '心跳唤醒内部指令，非真人发言' };
    }
    const { host, root, config, dicts, logger } = runtime;
    const now = input.now ?? (host.now ? host.now() : Date.now());
    const gid = sanitizeId(input.groupId);
    const uid = sanitizeId(input.userId);
    if (!gid || !uid)
        return { allow: true, scored: false, reason: '身份非法（已跳过 R4 处理）' };
    const tz = resolveTimeZone(config.timezone);
    // ① 时间字段：收到任意非 bot 消息 → lastNonBotMessageAt = now（含凌晨被丢弃的消息）
    //    图纸 2.4「跨天重置」在这里也要跑一次，否则新建的状态文件会留下 date 空串。
    try {
        const today = dayKeyOf(now, tz);
        const state = resetIfNewDay(readHeartbeat(gid, root, logger), { date: today, at: now });
        writeHeartbeat(gid, { ...state, lastNonBotMessageAt: now }, root, logger);
    }
    catch { /* 时间字段失败不影响主链 */ }
    /**
     * ★ 2026-11-05 R4.3（F3）：关系统计 —— 首见时间 + 累计消息数。
     *
     * 这是「认识 N 天」「聊过 N 次」的**唯一数据来源**（批次 C 报告指出原先没有任何写入方）。
     *   · 只在 `features_config.milestones` 开启时才写（关着时零 IO）；
     *   · 老用户 firstMetAt=0 → 首次观测时补上（所以 N 从启用日起算，会偏小，已知限制）；
     *   · 失败静默：统计丢了最多是 N 偏小，**绝不阻塞主链**。
     */
    if (config.features_config.milestones) {
        try {
            const relCfg = config.relationship_config;
            const initial = { level: relCfg.initial_level, score: relCfg.initial_score };
            const rels = readRelationships(gid, root, initial, logger);
            const entry = rels[uid] ?? emptyRelationshipEntry(relCfg.initial_level, relCfg.initial_score);
            if (!(Number(entry.firstMetAt) > 0))
                entry.firstMetAt = now;
            entry.messageCount = Math.max(0, Number(entry.messageCount) || 0) + 1;
            rels[uid] = entry;
            writeRelationships(gid, rels, root, logger);
        }
        catch { /* 统计失败不影响主链 */ }
    }
    // ② 凌晨装死：02:00-06:00 内按 wake_probability 决定放行/丢弃
    const zt = zonedTime(now, tz);
    const asleep = isSleepWindow(zt.hour);
    let wokeText;
    if (asleep) {
        const allow = shouldWake(config.time_config.wake_probability, randomFnOf(host));
        if (!allow)
            return { allow: false, scored: false, reason: '凌晨装死：静默丢弃（仍已更新 lastNonBotMessageAt）' };
        // 2026-11-03 修复 P1-8：装死被吵醒放行 → 带出图纸模块一的固定状态文案。
        wokeText = sleepWokeText();
    }
    // ③ 越界行为 → 临时冷淡（不改 level/score）
    const text = String(input.text ?? '');
    if (isAbusive(text)) {
        const cold = applyTemporaryCold({ groupId: gid, userId: uid, root, now, cfg: config.relationship_config, logger });
        return { allow: true, scored: false, coldApplied: cold, reason: '越界行为 → 临时冷淡', wokeText };
    }
    // ④ 关系计分：三种类型判定（梗词典/引用/@）
    const kind = classifyScoreKind({
        text,
        atBot: input.atBot === true,
        quoteBot: input.quoteBot === true,
        memeWords: dicts.memes,
    });
    if (!kind)
        return { allow: true, scored: false, reason: '不命中任何计分类型', wokeText };
    const outcome = applyScore({ groupId: gid, userId: uid, kind, root, now, cfg: config.relationship_config, logger });
    return { allow: true, scored: outcome.scored, kind, reason: outcome.reason, wokeText };
}
