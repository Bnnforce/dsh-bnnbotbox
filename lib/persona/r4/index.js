/**
 * R4.0 主接线（阶段四交付清单的编排层）— **统一出口门面**
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 重构阶段 2 / 批次 C（2026-11-05）：
 *   本文件原来是 711 行的单体，现按「运行时主体 / 入站 / 出站 / 类型 / 小工具」拆开：
 *
 *     host-types.ts     R4Host / R4Handle 契约类型（抽出来打断循环依赖）
 *     message-utils.ts  消息层小工具（isNonBot / lastNonBotOf / hitNegative /
 *                       stripCodeFence / EXTRACTION_SYSTEM）
 *     inbound.ts        handleIncomingMessage（关系计分 / 凌晨装死 / 临时冷淡）
 *     outbound.ts       decorateOutgoingText（小脾气前缀）
 *     index.ts（本文件）createR4Runtime 主体 + 原有 re-export 块
 *
 *   `createR4Runtime` **没有拆**：它是一整个运行时对象，内部状态（配置/字典/画像/
 *   关系/心跳/冷却/注入回调）高度交织，硬拆只能靠传递大量闭包，收益小风险大。
 *   只把已经独立成大函数的两个入口搬出去。
 *
 *   对外 API 面完全不变：`R4Host` / `R4Handle` / `handleIncomingMessage` /
 *   `decorateOutgoingText` 都仍然从本文件导出。
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 职责：
 *   ① 读配置 + 字典（阶段一）；
 *   ② 挂 `system-prompt/assemble`，按图纸 3.1 顺序 + 3.2 熔断注入；
 *   ③ 监听 `session/event`，把消息转成「有人回复 / 画像提取语料 / 关系计分」的输入；
 *   ④ 启动心跳定时器与凌晨提取定时器（阶段四 ③④）。
 *
 * 纪律（图纸 0.1/0.2/0.4/0.5）：
 *   - 所有异常吞掉 + warn，**绝不阻塞主聊天**；
 *   - 不修改/删除 judge / overlay / highlights 旧文件（只读）；
 *   - `useLegacyAffinity: false`，旧 `affinity.json` 只读；
 *   - 不向 dshqqbot 目录写任何新模块数据（`PERSONA_DATA_ROOT` 隔离）；
 *   - `groupId`/`userId` 拼路径前必 sanitize。
 */
import { resolveDataRoot } from '../../shared/paths.js';
import { loadConfig } from './config.js';
import { loadDictionaries } from './dicts.js';
import { personaDataRoot, sanitizeId } from './paths.js';
import { logInfo, logWarn } from './logger.js';
import { buildInjection, describeInjection, otherTagText, relationshipTagOf, r4SectionName } from './inject.js';
import { zonedTime, timeBlockText, isSleepWindow, DEFAULT_TIME_ZONE, resolveTimeZone } from './time.js';
// ★ 2026-11-09 R4.1：新人识别（纯函数判定 + 提示文案 + 节流诊断落盘）
import { detectNewcomer, newcomerHintText, makeNewcomerDiag } from './newcomer.js';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { hasSomeoneReplied } from './reply-detect.js';
import { evaluateTick, rollbackWaitSent, resolveWaitingMinutes } from './heartbeat.js';
import { shouldInjectSulk, withSulkPrefix, keepColdWhenSkipped, clearCold, SULK_PREFIX } from './sulk.js';
import { readHeartbeat, writeHeartbeat, readRelationships, writeRelationships } from './state.js';
import { contestContext, readOtherTags, readRelationshipTag, applyScore, classifyScoreKind, applyTemporaryCold, markTagMentionsByReply } from './relationship-store.js';
import { readProfileTextForInject, persistExtraction } from './profile-store.js';
import { buildProfileText, recentTempEventsOf } from './profile.js';
// ★ 2026-11-05 F2：画像 tag 的「最近提过 → 降权」（纯函数，profile-view 内实现）。
import { demoteRecentlyMentionedTags } from './profile-view.js';
import { readProfileEvents, readProfileIndex } from './state.js';
// ★ 2026-11-04 生活痕迹抽卡（纯函数层 + IO 层分开，index 只做编排）
import { ensureDailyMood, readDailyMood } from './life-store.js';
import { record, recordSkip, recordError, noteFailure, noteSuccess, isDegraded } from './feature-diag.js';
// ★ 2026-11-21 v3：mood-tint.js 已删除（死代码，见 R5.4 v3 方案 §5）
// ★ 2026-11-20 R5.4：四维心理状态（替代单维 mood-tint 的注入内容）
import { buildText as buildAxesText, extractSignals as extractAxesSignals, extractDialogueSignals, mergeSignals, drift as driftAxes, applyBaseline as applyAxesBaseline, normalizeAxes, describeAxes, MIN_SAMPLES as AXES_MIN_SAMPLES } from './mood-axis.js';
import { readAxes, writeAxes } from './mood-store.js';
import { readRelationLayer } from './mood-official.js';
import { applyRelation } from './mood-axis.js';
import { slotOfTs, computeDayBaseline, computeMaterialLayer, computeExternalLayer, mergeLayers } from './mood-life.js';
import { startOwnTime } from './own-time.js';
import { isMaterialUsed, readLifeStreamState } from './life-stream-state.js';
import { currentSlotEvent, lifeBackgroundText, recentPastEvents } from './life-events.js';
import { createScheduler, resolveGenerationMode } from './scheduler.js';
import { readRecentMessages, listHistorySessions, dayKeyOf } from './sample.js';
import { parseHeartbeatOutput, buildHeartbeatPrompt, HEARTBEAT_SYSTEM, isUsableHeartbeatText, withTimeout, buildWakePrompt } from './heartbeat-gen.js';
import { resolveBotOpenidCached } from './bot-identity.js';
import { handleIncomingMessage } from './inbound.js';
import { decorateOutgoingText } from './outbound.js';
import { lastNonBotOf, hitNegative, stripCodeFence, EXTRACTION_SYSTEM } from './message-utils.js';
// ── R4.3 新模块（阶段 A2 接线；功能默认关闭 + 骨架返回空 → 行为完全不变）──
import { recallEvents } from './events-recall.js';
import { closeEventsByText, expireStaleEvents, markEventReferenced, mergeExtractedEvents } from './events-store.js';
import { milestoneFor } from './milestones.js';
import { pushHint, ritualHint } from './chat-push.js';
// ★ 2026-11-05 心跳 wake：outbox 写入的真实现（`sendWakeToGroup`）在 r4-bridge.ts。
//   只 import 工厂、不碰 r4 实例，不构成循环（r4-bridge 不 import 本文件）。
import { createR4Bridge } from '../r4-bridge.js';
export { handleIncomingMessage, decorateOutgoingText };
/**
 * P1「她自己的时间」调度器工厂（2026-11-16）。
 *
 * 为什么是**工厂**而不是在 createR4Runtime 里直接启动：
 *   · 它需要宿主提供 deliver（把提示送进上下文）—— 这个能力只有宿主有；
 *   · 默认关闭（config.features.ownTime=false）→ 返回 noop，零开销；
 *   · 独立于心跳状态机，出问题不影响主聊天。
 *
 * 用法（宿主侧）：
 *   const stop = mountOwnTime(dataRoot, { enabled: true }, { deliver: async (t) => {...} });
 *   // 卸载时 stop()
 */
export function mountOwnTime(dataRoot, cfg, hooks) {
    try {
        return startOwnTime(dataRoot, cfg, {
            ...hooks,
            onDiag: (rec) => record(dataRoot, { feature: "P1", on: rec.on, reason: rec.reason, chars: Number(rec.detail?.chars ?? 0), detail: rec.detail }, diagOn()),
        });
    }
    catch (err) {
        recordError(dataRoot, "P1", err, diagOn());
        return () => { };
    }
}
/**
 * 创建 R4 运行时。
 *
 * @param host  宿主能力
 * @param root  数据根（默认 `PERSONA_DATA_ROOT`）
 * @param options.persona 人格 id（默认 elysia）
 */
/**
 * 「好久没见」提示（P4，2026-11-16）。
 *
 * 读 state/relationships/{gid}.json 里这个人上次互动的时间（updatedAt），
 * 距今超过 ABSENCE_DAYS 天 → 返回一句提示；否则返回空串。
 *
 * ⚠️ 纪律：
 *   · **零新增存储**（用现成的 relationships 数据）
 *   · **零额外 LLM 调用**（纯本地读 + 比较）
 *   · 读不到 / 数据脏 → 返回空串（绝不抛错、绝不影响正常注入）
 *   · 只给**语境提示**，说不说由模型决定（硬塞会显得刻意）
 */
const ABSENCE_DAYS = 3;
/**
 * 诊断总开关（工业标准 ④：关闭 = 零开销）。
 * 缺省开启——可观测是默认要求，而不是可选项。
 */
function diagOn() {
    return true;
}
function absenceHintOf(dataRoot, groupId, userId, now) {
    if (!dataRoot || !groupId || !userId)
        return '';
    try {
        const dir = join(dataRoot, 'state', 'relationships');
        const file = join(dir, `${groupId}.json`);
        const raw = JSON.parse(readFileSync(file, 'utf8'));
        const rec = raw?.[userId];
        if (!rec)
            return '';
        const lastAt = Number(rec.updatedAt);
        if (!Number.isFinite(lastAt) || lastAt <= 0)
            return '';
        const days = Math.floor((now - lastAt) / 86400_000);
        // 差 1-2 天不提（天天说"好久不见"很假）；超过门槛才提
        if (days < ABSENCE_DAYS)
            return '';
        // 说得越久，语气越自然；超过 30 天就别提具体天数了（显得计算过）
        const span = days > 30 ? '挺久' : `${days} 天`;
        return `（这个人上次说话是 ${span} 前了——如果合适，可以自然提一句"好久没见"，不用刻意）`;
    }
    catch {
        return '';
    }
}
export function createR4Runtime(host, root = personaDataRoot(), options = {}) {
    const persona = options.persona ?? 'elysia';
    const logger = host.logger;
    const nowFn = () => (host.now ? host.now() : Date.now());
    const randomFn = () => (host.random ? host.random() : Math.random());
    const cfgResult = loadConfig(persona, root);
    const config = cfgResult.config;
    for (const warning of cfgResult.warnings)
        logWarn(logger, warning);
    const dicts = loadDictionaries(config, root);
    if (dicts.missing.length > 0) {
        logWarn(logger, `[r4] 字典缺失（已降级）：${dicts.missing.join(', ')}`);
    }
    /**
     * ★ 2026-11-09 R4.1：新人识别诊断落盘。
     * 走独立文件 + 节流（同一人 5 分钟一行），否则每轮都写会把日志刷爆。
     */
    const newcomerDiag = makeNewcomerDiag({
        dir: resolveDataRoot(),
        now: nowFn,
    });
    const timeZone = resolveTimeZone(config.timezone || DEFAULT_TIME_ZONE);
    const levels = config.relationship_levels;
    const relCfg = config.relationship_config;
    /**
     * bot 自身 openid（A 判定 `@bot` 用；2026-11-03 修复 P1-1）。
     * 懒解析 + 带持久缓存（`state/bot-identity.json`），失败返回空串（A 退化为只看标记）。
     */
    let botOpenidCache;
    const botOpenid = () => {
        if (botOpenidCache !== undefined)
            return botOpenidCache;
        try {
            botOpenidCache = resolveBotOpenidCached({ qqbotDataRoot: host.qqbotDataRoot, root, logger });
        }
        catch {
            botOpenidCache = '';
        }
        return botOpenidCache;
    };
    /**
     * 给采样结果补 bot 相关标记（`mentionedBot`；`quoteOfSelf` 只能由宿主结构体提供）。
     * 采样层保留的 `mentioned` 列表是**原始 `<@…>`**，这里只做比对，不改写正文。
     */
    const markBotMentions = (messages) => {
        const botId = botOpenid();
        if (!botId)
            return messages;
        for (const m of messages) {
            if (m.self)
                continue;
            if (Array.isArray(m.mentioned) && m.mentioned.includes(botId))
                m.mentionedBot = true;
        }
        return messages;
    };
    const groups = () => {
        try {
            if (host.listGroups)
                return host.listGroups();
            return listHistorySessions(host.qqbotDataRoot, logger)
                .filter((s) => s.scope === 'group')
                .map((s) => s.peerId);
        }
        catch (error) {
            logWarn(logger, `[r4] 列群失败：${error instanceof Error ? error.message : String(error)}`);
            return [];
        }
    };
    const messagesOf = (groupId, withinMs = 30 * 60 * 1000) => {
        try {
            // ★ root 传入后，采样层会**优先读**扩展包写入的全量台账
            //   （state/r4-group-history/，含"没 @她"的群闲聊），读不到再回落 QQBot 的 msg-history。
            const list = readRecentMessages('group', groupId, {
                qqbotDataRoot: host.qqbotDataRoot,
                root,
                withinMs,
                now: nowFn(),
                logger,
            });
            return markBotMentions(list);
        }
        catch (error) {
            logWarn(logger, `[r4] 读 ${groupId} 消息失败（已跳过）：${error instanceof Error ? error.message : String(error)}`);
            return [];
        }
    };
    /**
     * 「凌晨被吵醒」状态文案的短时记忆（2026-11-03 修复 P1-8）。
     *
     * `handleIncomingMessage` 在装死窗内放行时会返回 `wokeText`，但注入发生在**下一轮**
     * `system-prompt/assemble`，两者之间没有直接参数传递通道。这里按 groupId 记一条，
     * **只在下一次注入时消费并立即清除**（不跨轮残留），带过期兜底防内存泄漏。
     */
    const WOKE_TTL_MS = 10 * 60 * 1000;
    const wokePending = new Map();
    const takeWokeText = (groupId) => {
        const hit = wokePending.get(groupId);
        if (!hit)
            return '';
        wokePending.delete(groupId);
        if (nowFn() - hit.at > WOKE_TTL_MS)
            return '';
        return hit.text;
    };
    const putWokeText = (groupId, text) => {
        if (!text)
            return;
        // 上限保护：正常只有极少数群会同时处于装死被吵醒态。
        if (wokePending.size > 64) {
            const oldest = wokePending.keys().next().value;
            if (oldest !== undefined)
                wokePending.delete(oldest);
        }
        wokePending.set(groupId, { text, at: nowFn() });
    };
    /**
     * ★ 2026-11-05 R4.3 F1：待注入的「旧事召回」结果。
     *
     * 为什么要中转：入站（`onMessage`，有用户消息文本）和注入（`assemble`，没有）
     * 是两个阶段，中间没有参数通道。所以入站时召回 → 暂存 → 注入时消费并立刻清除
     * （TTL 60 秒，绝不跨轮残留）。
     */
    const RECALL_TTL_MS = 60 * 1000;
    /**
     * ★ 2026-11-05 修（批次 B 报告发现的高危缺口）：
     *   key 必须是 **`${groupId}:${userId}`** —— 原先只按 `groupId` 存，
     *   同一群里 A 的旧事会在 60 秒内被注入到 B 的回复里（**跨用户泄漏**）。
     */
    const pendingRecall = new Map();
    const recallKey = (groupId, userId) => `${groupId}:${String(userId ?? '').trim()}`;
    const takeRecallHint = (groupId, userId) => {
        const uid = String(userId ?? '').trim();
        if (!uid)
            return '';
        const key = recallKey(groupId, uid);
        const hit = pendingRecall.get(key);
        if (!hit)
            return '';
        pendingRecall.delete(key);
        if (nowFn() - hit.at > RECALL_TTL_MS)
            return '';
        /**
         * ★ 2026-11-05 修（批次 B 报告发现的高危缺口）：
         *   原先**没有任何地方**写 `lastReferencedAt`，导致 `cooldown_days` 过滤永不生效
         *   ⇒ 同一件旧事会被每轮反复召回。真正注入出去的这一刻必须回头标记它。
         */
        try {
            markEventReferenced(uid, hit.hint.eventId, root, nowFn(), config.events_config, logger);
        }
        catch { /* 标记失败不影响本次注入 */ }
        const h = hit.hint;
        return [
            '[可接可不接的旧事]',
            `ta 在 ${h.daysAgo} 天前提过「${h.summary}」。`,
            '如果这句话和当前话题自然相关，可以顺口接一句；不相关就完全忽略。',
            '绝不要生硬提起，也不要说「我记得你说过」这类暴露记录的话。',
        ].join('\n');
    };
    /**
     * ★ 2026-11-05 R4.3 F4：同一群同一人的「连续对话轮数」。
     *
     * 为什么需要它：批次 D 的实现里 `consecutiveTurns < 1` 会直接返回空，
     * 阶段 A 的占位接线固定传 0 ⇒ **开关打开也不会生效**（批次 D 报告指出）。
     * 这里用「2 分钟内有来往」作为连续对话的判据，足够简单且不引入新状态文件。
     */
    const CONV_WINDOW_MS = 2 * 60 * 1000;
    const CONV_MAP_LIMIT = 200;
    const conversationTurns = new Map();
    const noteConversation = (groupId, userId) => {
        const key = `${groupId}:${userId}`;
        const at = nowFn();
        const prev = conversationTurns.get(key);
        const turns = prev && at - prev.at < CONV_WINDOW_MS ? prev.turns + 1 : 1;
        conversationTurns.set(key, { turns, at });
        if (conversationTurns.size > CONV_MAP_LIMIT) {
            const oldest = conversationTurns.keys().next().value;
            if (oldest !== undefined)
                conversationTurns.delete(oldest);
        }
    };
    /* ───── 注入（图纸 3.1/3.2）───── */
    const assemble = (context) => {
        try {
            const sessionId = String(context?.agent?.session?.id ?? '');
            const groupId = host.resolveGroupId ? String(host.resolveGroupId(sessionId) ?? '') : '';
            const gid = sanitizeId(groupId);
            if (!gid)
                return ''; // 拿不到群号 / 非法 → 不注入（例如 Web 会话）
            const userId = host.resolveSenderId ? sanitizeId(host.resolveSenderId(sessionId)) : null;
            const now = nowFn();
            const zt = zonedTime(now, timeZone);
            /**
             * ★ 2026-11-05 F2 写入链（P0 修复）· 暂存「本轮画像实际用到的 tag」。
             *
             * 为什么需要这个闭包变量：`getProfile` 在 `buildInjection` 内部调用，
             * 拿到的画像正文只有字符串、没有 tag 列表（`inject.ts` 的契约不改）。
             * 这里在回调里顺手记下本轮的 userId + tag，注入完成后确认这些 tag
             * **真的进了最终注入文本**，再写回 `lastMentionedTags`。
             *
             * token 纪律：全部是本地字符串处理，**不调模型、不改 prompt、不增加任何字符**。
             */
            const mentionCapture = { userId: '', tags: [] };
            const out = buildInjection({
                groupId: gid,
                userId: userId ?? '',
                persona,
                levels,
                // ★ 2026-11-05 参数解耦：熔断预算来自配置（`inject_config.fuse_budget`）
                fuseBudget: config.inject_config?.fuse_budget,
                sources: {
                    getProfile: (uid) => {
                        if (!uid)
                            return '';
                        const text = readProfileTextForInject(uid, root, now, logger);
                        if (!text)
                            return '';
                        /**
                         * ★ 2026-11-05 F2「记忆表达分级」· 简化一层：
                         *   最近 14 天内提过的 tag 移到正文末尾（降权），没提过的优先占位。
                         *   同一段文字、字数不变 ⇒ **零额外 token**；不调模型；失败退回原文。
                         */
                        let body = text;
                        let tags = [];
                        if (config.features_config.memory_tier) {
                            try {
                                const index = readProfileIndex(root, logger);
                                const demoted = demoteRecentlyMentionedTags({
                                    text,
                                    lastMentionedTags: index[uid]?.lastMentionedTags,
                                    now,
                                });
                                body = demoted.text;
                                tags = demoted.tags;
                            }
                            catch {
                                body = text;
                                tags = [];
                            }
                        }
                        mentionCapture.userId = uid;
                        mentionCapture.tags = tags;
                        /**
                         * ── P4「好久没见」（2026-11-16）─────────────────────────────────────
                         *
                         * 为什么：她记得群友（qq_memory 有卡、relationships 有 firstMetAt/updatedAt/
                         *   messageCount），但**不会想起来主动提**。真人隔了几天见到同一个人，
                         *   会自然说一句"好久没见"——她没有这个意识。
                         *
                         * 数据来源：state/relationships/{gid}.json 里现成有 updatedAt（最近互动时间），
                         *   **零新增存储、零额外 LLM 调用**。
                         *
                         * 门槛：超过 ABSENCE_DAYS 天没互动才提；差 1 天不提（不然天天"好久不见"很假）。
                         *   ⚠️ 只给**提示**，说不说由模型按语境决定，不是硬塞。
                         */
                        try {
                            if (!config.features_config.absence_hint) {
                                // P4 关闭 → 零开销（不读盘）
                            }
                            else if (isDegraded('P4')) {
                                // 已降级：跳过（不再 try 这个功能，防每轮炸）
                            }
                            else {
                                const away = absenceHintOf(root, gid, uid, now);
                                if (away)
                                    body = `${away}\n${body}`;
                                noteSuccess('P4');
                                record(root, {
                                    feature: 'P4',
                                    on: Boolean(away),
                                    chars: away ? [...away].length : 0,
                                    reason: away ? '' : 'not-away',
                                }, diagOn());
                            }
                        }
                        catch (err) {
                            recordError(root, 'P4', err, diagOn());
                            // 连续 5 次失败 → 本进程内降级（工业标准 ⑤）
                            if (noteFailure('P4'))
                                recordSkip(root, 'P4', 'degraded-after-5-failures', diagOn());
                        }
                        // 图纸 3.6：禁止说「根据画像」，自然流露
                        return `[当前画像]\n${body}\n（自然地流露，不要说「根据画像」这类话。）`;
                    },
                    /**
                     * ★ 2026-11-04 双层记忆 · 最近琐事摘要（决策点 ③ 方案 A）。
                     *
                     * 这个回调**同时承担两个职责**：
                     *  ① 给模型"最近聊过什么琐事"的清单（只给 tag，不给原文，控 token）；
                     *  ② 它是**触发开关** —— 返回非空 ⇔ inject.ts 会挂上【记忆法则】。
                     *
                     * 判据：该 user 有近 7 天的**临时事件**才返回。
                     * 纯新用户 / 只聊过一次性格的人 → 返回空 → 不挂法则（省 225 字）。
                     */
                    getTempEvents: (uid) => {
                        if (!uid)
                            return '';
                        try {
                            const events = readProfileEvents(uid, root, logger);
                            const tags = recentTempEventsOf({ events, now, days: 7, limit: 5 });
                            if (tags.length === 0)
                                return '';
                            const joined = tags.join('、');
                            // 再兜一层长度：即便 5 个 tag 每个都接近 20 字，也不让摘要失控。
                            const cut = [...joined].length > 60 ? `${[...joined].slice(0, 60).join('')}…` : joined;
                            return [
                                '[最近聊过的琐事（模糊印象即可，不必报流水账）]',
                                cut,
                                '（以上是最近几天的事。被问起时按记忆法则第 2/3 条处理：可以模糊、可以故意装傻逗他。）',
                            ].join('\n');
                        }
                        catch {
                            return '';
                        }
                    },
                    getOverlay: (g, p) => (host.readOverlay ? String(host.readOverlay(g, p) ?? '').trim() : ''),
                    getRelationshipTag: (g, uid) => (uid ? readRelationshipTag({ groupId: g, userId: uid, root, cfg: relCfg, levels, logger }) : ''),
                    getContestHint: (g, uid) => {
                        if (!uid)
                            return '';
                        const messages = messagesOf(g);
                        const ctx = contestContext({ groupId: g, currentUserId: uid, messages, root, now: nowFn(), cfg: relCfg, logger });
                        return ctx.contest ? '[提示：对低互动对象保持礼貌但简短，不得贬低、嘲讽或公开区别对待。]' : '';
                    },
                    getOtherTags: (g, uid) => {
                        if (!uid)
                            return [];
                        return readOtherTags({ groupId: g, currentUserId: uid, messages: messagesOf(g), root, now: nowFn(), cfg: relCfg, levels, logger });
                    },
                    getHighlights: () => (host.readHighlights ? String(host.readHighlights(2) ?? '').trim() : ''),
                    /**
                     * ★ 2026-11-08 记忆联想化（第一层）：人物卡 / 群卡摘要。
                     *
                     * 与 `getLifeBackground` 的区别：
                     *   · 生活痕迹 = 「我今天在干嘛」（自身状态，按小时变）
                     *   · 记忆联想 = 「我记得你是谁」（对他人的认知，按人变）
                     * 两者互不替代，各自独立预算（记忆 220 字 / 四段 140 字）。
                     *
                     * 全链路 try/catch：宿主没实现 / 记忆插件没装 / 存储读失败 → 返回空串，
                     * 本轮不注入，绝不影响主聊天。
                     */
                    getMemoryRecall: () => {
                        try {
                            if (!host.getMemoryRecall)
                                return '';
                            return String(host.getMemoryRecall(gid, userId ?? '') ?? '').trim();
                        }
                        catch (error) {
                            logWarn(logger, `[r4] 记忆联想注入失败（已跳过）：${error instanceof Error ? error.message : String(error)}`);
                            return '';
                        }
                    },
                    /**
                     * ★ 2026-11-04 生活痕迹「隐藏背景板」。
                     *
                     * 每次 assemble 调一次：
                     *   ① `ensureDailyMood` 保证当天已抽卡（跨天自动重抽并落盘；当天已抽只读一个小 JSON）；
                     *   ② 按当前小时取该时段事件（**02:00-06:00 装死窗口不注入**，主人已确认）；
                     *   ③ 渲染成 `[你的隐藏背景板：xxx]` + 强约束文案。
                     *
                     * 全链路失败都返回空串 → 该轮不注入，绝不影响主聊天。
                     */
                    getLifeBackground: () => {
                        try {
                            if (!config.life_events?.enabled)
                                return '';
                            // P2 开关：关闭后不再带跨天旧事（但生活背景板仍按 life_events 走）
                            const p2on = config.features_config.life_continuity;
                            // 装死窗口内不抽也不注入（连读盘都省掉；状态照样会在白天首轮补抽）
                            if (isSleepWindow(zt.hour))
                                return '';
                            const today = dayKeyOf(now, timeZone);
                            const state = ensureDailyMood({
                                root,
                                today,
                                now,
                                random: randomFn,
                                config: config.life_events,
                                logger,
                                // ★ P5（2026-11-16）：装死窗口的 late_night 段抽了也不会注入
                                //   （currentSlotEvent 在 02:00-06:00 返回空）→ 生产路径显式跳过，避免白浪费 1/4 素材。
                                //   底层仍是通用工具（默认不跳），策略只在这里开。
                                skipSlots: config.features_config.life_slot_fix ? ['late_night'] : [],
                            });
                            const event = currentSlotEvent(state, zt.hour, config.life_events);
                            if (!event)
                                return '';
                            // ⭐ 2026-11-07 素材互斥（life-stream 引入后新增）：
                            //   同一条素材如果已经被「主动开口」用掉了，就**不再当隐藏背景板注入**，
                            //   否则同一件事会在群里说两遍（一次是随口说出，一次是"流露"）。
                            //   读不到状态时按「没用过」处理（宁可多注入一次，也不误吞正常注入）。
                            try {
                                const ls = readLifeStreamState(root, logger);
                                if (isMaterialUsed(ls, event))
                                    return '';
                            }
                            catch { /* 读不到 → 不做互斥，继续注入 */ }
                            // ── 跨天延续（2026-11-16）：带一句「前两天的旧事」，让生活有连续性 ──
                            //   为什么：原来每天独立抽卡 → 今天追萤火虫、明天泡茶，读起来像随机台词。
                            //   真人会说「昨天那只夜蝶还在不在」。这里把 recent 里的旧条目带进提示，
                            //   **让模型自己决定要不要提**（不是硬塞进正文，所以不会显得刻意）。
                            let carried = '';
                            let carriedCount = 0;
                            try {
                                const past = p2on ? recentPastEvents(state, today, 2) : [];
                                if (past.length > 0) {
                                    carried = past.map((p) => `- ${p.date}：${p.text}`).join('\n');
                                    carriedCount = past.length;
                                }
                            }
                            catch (err) {
                                recordError(root, 'P2', err, diagOn());
                            }
                            const out = lifeBackgroundText(event, carried);
                            // ── 可观测（工业标准 ②）：每次注入决策留痕 ──
                            if (isDegraded('P2'))
                                return out; // 已降级 → 不再记日志（防刷屏）
                            record(root, {
                                feature: 'P2',
                                on: out.length > 0,
                                chars: [...out].length,
                                reason: out.length > 0 ? '' : 'no-event',
                                detail: { carried: carriedCount, recentTotal: Array.isArray(state.recent) ? state.recent.length : 0 },
                            }, diagOn());
                            noteSuccess('P2');
                            return out;
                        }
                        catch (error) {
                            logWarn(logger, `[r4] 生活痕迹注入失败（已跳过）：${error instanceof Error ? error.message : String(error)}`);
                            return '';
                        }
                    },
                    /**
                     * ★ 2026-11-16 P3：情绪底色（慢漂移，无数字）。
                     *
                     * 数据来源：本进程内维护一个环形缓冲，每次注入时用**上一轮她的回复**算信号。
                     *   · 第 1 层：本地模型判出的 emo（four-source.jsonl 的 replyEmo）—— 实测多为 undefined
                     *   · 第 2 层：从回复文本抽软信号（长度/语气词/标点）
                     *   · 都拿不到 → 不注入（宁可不给，也不瞎猜）
                     *
                     * ⚠️ 与"数值心情系统"的区别：无数字、无评分、明说"以当下语境为准"。
                     */
                    getMoodTint: () => {
                        // P3 开关（关闭 = 零开销：不读盘、不记录）
                        if (!config.features_config.mood_tint)
                            return "";
                        try {
                            // ★ 2026-11-20 R5.4：四维状态（替代单维）
                            const axes = readAxes(root, logger);
                            const text = buildAxesText(axes);
                            if (isDegraded("P3"))
                                return "";
                            record(root, {
                                feature: "P3",
                                on: text.length > 0,
                                chars: [...text].length,
                                reason: text ? "" : `samples=${axes.samples}/${AXES_MIN_SAMPLES}`,
                                // ★ 2026-11-21 v3：诊断字段扩到八维（可观测性要求 §9.5）
                                detail: {
                                    mood: Number(axes.mood.toFixed(2)),
                                    energy: Number(axes.energy.toFixed(2)),
                                    connection: Number(axes.connection.toFixed(2)),
                                    composure: Number(axes.composure.toFixed(2)),
                                    closeness: Number(axes.closeness.toFixed(2)),
                                    patience: Number(axes.patience.toFixed(2)),
                                    confidence: Number(axes.confidence.toFixed(2)),
                                    focus: Number(axes.focus.toFixed(2)),
                                    samples: axes.samples,
                                },
                            }, diagOn());
                            noteSuccess("P3");
                            return text;
                        }
                        catch (err) {
                            recordError(root, "P3", err, diagOn());
                            if (noteFailure("P3"))
                                recordSkip(root, "P3", "degraded", diagOn());
                            return "";
                        }
                    },
                    // 时间状态：绝对最后，永不丢。
                    // 2026-11-03 修复 P1-8：装死窗内若刚被吵醒 → 追加图纸固定文案 `[状态：熟睡被吵醒，语气朦胧]`。
                    getTimeState: () => {
                        const woke = takeWokeText(gid);
                        if (woke)
                            return woke;
                        return isSleepWindow(zt.hour) ? '' : timeBlockText(zt);
                    },
                    // ── ★ 2026-11-05 R4.3：四个调味段落 ──
                    //   开关全 false 时全部返回空串 ⇒ 与加这些代码之前**行为完全一致**。
                    //   骨架阶段内部实现也返回空，等 B/C/D 批次填充。
                    // ★ key 必须是 (groupId, userId)：只按群存会把 A 的旧事注入给 B。
                    getRecallHint: (_g, uid) => (config.features_config.memory_link ? takeRecallHint(gid, uid) : ''),
                    getMilestoneHint: (g, uid) => {
                        if (!config.features_config.milestones || !uid)
                            return '';
                        try {
                            /**
                             * topics 取自该用户最近提到的琐事 tag —— 供 `first_topic` 类事实使用。
                             * ★ 2026-11-05（批次 C 报告指出）：不传 topics 时 first_topic 永远不触发。
                             */
                            let topics = [];
                            try {
                                const events = readProfileEvents(uid, root, logger);
                                topics = recentTempEventsOf({ events, now, days: 7, limit: 3 });
                            }
                            catch {
                                topics = [];
                            }
                            const fact = milestoneFor({ groupId: g, userId: uid, root, now, topics });
                            return fact ? `[关系事实（可引用，也可以不提）]\n${fact.text}` : '';
                        }
                        catch {
                            return '';
                        }
                    },
                    /**
                     * ★ 2026-11-09 R4.1：新人识别（这个人刚来，别装熟）。
                     *
                     * 数据来源与 `milestoneFor` **同一份**（关系文件的 `firstMetAt` / `messageCount`），
                     * 但判据相反：milestone 在「认识 <3 天」时**故意不出事实**（不硬编亲密），
                     * 新人识别正是要在那个窗口里给一句「别装熟」。
                     *
                     * 纪律：任何异常 → 空串（不注入），绝不影响主链。
                     */
                    getNewcomerHint: (g, uid) => {
                        if (!config.features_config.newcomer || !uid)
                            return '';
                        try {
                            const rels = readRelationships(g, root, { level: config.relationship_config.initial_level, score: config.relationship_config.initial_score }, logger);
                            const entry = rels[uid];
                            if (!entry)
                                return '';
                            const verdict = detectNewcomer(
                            // 关系条目里这两个字段是**可选**的（老数据可能没有）→ 缺失按 0 处理，
                            // detectNewcomer 见 firstMetAt=0 会直接返回 null（绝不猜）。
                            { firstMetAt: entry.firstMetAt ?? 0, messageCount: entry.messageCount ?? 0, now }, {
                                enabled: config.features_config.newcomer,
                                newcomerDays: config.features_config.newcomer_days,
                                newcomerMaxMessages: config.features_config.newcomer_max_messages,
                            });
                            const hint = newcomerHintText(verdict);
                            // 诊断：让「新人提示到底命中没有」可验证（否则又是一次静默失效）
                            if (hint) {
                                newcomerDiag('hit', {
                                    gid: g.slice(-6), uid: uid.slice(-6),
                                    days: verdict?.daysKnown, msgs: verdict?.messageCount,
                                });
                            }
                            return hint;
                        }
                        catch {
                            return '';
                        }
                    },
                    getPushHint: (_g, uid) => {
                        if (!config.features_config.push || !uid)
                            return '';
                        try {
                            // 连续对话轮数由 onMessage 维护（2 分钟内有来往算连续）。
                            const turns = conversationTurns.get(`${gid}:${uid}`)?.turns ?? 0;
                            // lastWasQuestion 本轮先传 false（判断「上一轮是否提问」需要额外状态，
                            // 而且 F4 本身有「文案 3 天冷却 + 动态概率」两层压制，不会刷屏）。
                            return pushHint({ root, now, lastWasQuestion: false, consecutiveTurns: turns });
                        }
                        catch {
                            return '';
                        }
                    },
                    getRitualHint: () => {
                        if (!config.features_config.ritual)
                            return '';
                        try {
                            // 装死窗口（02:00-06:00）内本来就不注入时间状态，仪式句也不该出现。
                            if (isSleepWindow(zt.hour))
                                return '';
                            /**
                             * isFirstToday / isLastToday 传 true = **允许**在对应时段说这句话。
                             * 真正的「说一次就够」由 `phrase-cooldown` 的 3 天冷却保证 ——
                             * 若严格判断「当天第一/最后一轮」，需要在 outbound 侧记录、跨天状态文件，
                             * 复杂度和收益不成比例，这里用冷却代替。
                             */
                            return ritualHint({ root, groupId: gid, now, isFirstToday: true, isLastToday: true, hour: zt.hour });
                        }
                        catch {
                            return '';
                        }
                    },
                },
            });
            if (!out.text)
                return '';
            /**
             * ★ 2026-11-05 F2 写入链（P0 修复）：把「本轮画像实际用到的 tag」写回
             * `profiles/index.json` 的 `lastMentionedTags`。
             *
             * 为什么放在 assemble 完成之后：
             *   · 这是 R4 里**唯一**能确定「画像段真的进了本轮 prompt」的位置
             *     （`decorateOutgoing` 只有 {groupId,text}、没有 userId，且普通聊天回复
             *     根本不经过它 —— 它只覆盖心跳发送）；
             *   · 只记录**真正活着进入最终注入文本**的 tag：画像段可能被 `fuse` 熔断
             *     整段丢弃或截断（截断后 tag 名不完整），`out.text.includes(tag)` 正好过滤掉；
             *   · 纯本地字符串 + 一次原子写盘，**不调模型、不增加任何 prompt 内容**。
             *
             * 安全边界：功能开关关闭 / 没有画像 / 没有 tag → 什么都不做；异常只 warn。
             */
            if (config.features_config.memory_tier) {
                try {
                    const captured = mentionCapture;
                    if (captured.userId && captured.tags.length > 0) {
                        const usedTags = captured.tags.filter((tag) => out.text.includes(tag));
                        if (usedTags.length > 0) {
                            markTagMentionsByReply({ userId: captured.userId, tags: usedTags, root, logger, now });
                        }
                    }
                }
                catch (error) {
                    logWarn(logger, `[r4] 画像：提及写回失败（已跳过）：${error instanceof Error ? error.message : String(error)}`);
                }
            }
            logInfo(logger, describeInjection(out));
            return out.text;
        }
        catch (error) {
            logWarn(logger, `[r4] 注入失败（已跳过，不影响主聊天）：${error instanceof Error ? error.message : String(error)}`);
            return '';
        }
    };
    /* ───── 心跳 ───── */
    /**
     * ★ 2026-11-05 心跳 wake：outbox 写入通道（真实现 = `r4-bridge.ts#sendWakeToGroup`）。
     *
     * 契约（共享契约 §3/§5）：R4 **只负责把 wake 指令写进 outbox 文件**，由扩展包
     * `hooks/r4-heartbeat-bridge.mjs` 用 `caps.wakeTo('group', gid, wakePrompt)` 注入 agent。
     * 因此这里的 `true` 只代表「**已入队**」，不代表群里已经出现消息。
     *
     * 通道来源（第二道是保险，防止装配层漏接线导致 wake 静默停摆）：
     *   ① 宿主注入 —— `src/index.ts` 的真 `r4Bridge.sendWakeToGroup` 经 r4-mount 透传（优先）；
     *   ② 宿主没注入 → 本地建一个「只为 wake 用」的 r4-bridge 实例：
     *      outbox 路径 / 唯一文件名 / 向后兼容字段 / 小脾气装饰**全部复用同一实现**，
     *      **绝不在这里重写格式**（架构审查第 4 条就是要求只保留一处实现）。
     */
    const sendWakeToGroup = (() => {
        const injected = host.sendWakeToGroup;
        if (typeof injected === 'function')
            return (payload) => injected(payload);
        try {
            const bridge = createR4Bridge({
                qqbotDataRoot: host.qqbotDataRoot,
                logger,
                // wake 模式没有正文；只有兜底 `text` 非空时才可能用上（契约 §C.1）。
                r4DecorateOutgoing: (input) => {
                    // ★ 2026-11-21 v3：wake 通道的情绪推进改走**八维** advanceMood。
                    //   原来调的是单维 advanceMoodTint（mood-tint.js 已删除）。
                    //
                    //   注意：本通道只在 heartbeat_config.generation_mode='wake' 时触发；
                    //   当前默认 'legacy' ⇒ 实际不跑。但代码必须指向正确接口，
                    //   否则有人切到 wake 模式就会 ReferenceError（钩子 try/catch 会吞掉，
                    //   表现为「wake 模式下情绪不推进」的静默失效）。
                    //
                    //   advanceMood 定义在后面的 return 对象上，这里用惰性取用避免时序问题。
                    try {
                        // 内联八维推进（与 advanceMood 同逻辑，但这里拿不到那个闭包）
                        if (config.features_config.mood_tint) {
                            const txt = String(input.text ?? "").trim();
                            if (txt.length >= 2) {
                                const sig = mergeSignals(extractAxesSignals(txt), extractDialogueSignals(txt, {}));
                                if (Object.keys(sig).length) {
                                    const prev = readAxes(root, logger);
                                    writeAxes(root, driftAxes(prev, sig, nowFn()), logger);
                                }
                            }
                        }
                    }
                    catch { /* 绝不影响出站 */ }
                    return decorateOutgoingText({ groupId: input.groupId, text: input.text, root, logger, now: nowFn() });
                },
            });
            return (payload) => bridge.sendWakeToGroup(payload);
        }
        catch (error) {
            logWarn(logger, `[r4] 心跳：wake outbox 通道初始化失败（wake 模式将不发心跳）：${error instanceof Error ? error.message : String(error)}`);
            return undefined;
        }
    })();
    const heartbeatDeps = {
        config,
        root,
        logger,
        listGroups: groups,
        readMessages: (gid) => messagesOf(gid),
        evaluate: ({ groupId, state, now, date, messages, deadGroupHours }) => {
            // waiting 起点 = waitingUntil - waiting 窗口（2026-11-03 修复 P1-2：A/B 也必须限定在这个窗口内）。
            // 2026-11-04：窗口长度改取配置（与 evaluateTick 里 markWaitSent 用的是同一个值），
            // 否则调短 waiting_minutes 后会出现「状态机 1 分钟就到期、判定却按 15 分钟算」的错配。
            const waitMin = resolveWaitingMinutes(config.heartbeat_config);
            const sinceAt = state.state === 'waiting' && state.waitingUntil > 0
                ? state.waitingUntil - waitMin * 60 * 1000
                : 0;
            const repliedDuringWait = hasSomeoneReplied({
                state,
                messages,
                replyDetection: config.reply_detection,
                botId: botOpenid(),
                now,
                sinceAt,
            });
            const verdict = evaluateTick({
                state,
                now,
                date,
                heartbeat: config.heartbeat_config,
                lastNonBotMessageAt: lastNonBotOf(state, messages),
                // 契约扩展参数：为 true 时「waiting 到期且有人回复 → normal」
                repliedDuringWait,
                // ★ 2026-11-04 修：死群窗口必须**透传**到 evaluateTick。
                //   原先这里用 `as Parameters<typeof evaluateTick>[0]` 强转 —— TypeScript 的 `as`
                //   不做运行时校验，调用方传进来的额外字段会被**静默丢弃**（scheduler 传了也不生效）。
                //   不传（undefined）时 evaluateTick 内部回落 DEFAULT_DEAD_GROUP_HOURS=2，与旧行为一致。
                ...(typeof deadGroupHours === 'number' && Number.isFinite(deadGroupHours)
                    ? { deadGroupHours }
                    : {}),
            });
            return {
                next: verdict.state,
                changed: verdict.changed,
                shouldSend: verdict.shouldSend,
                skipReason: verdict.skipReason,
                repliedDuringWait,
            };
        },
        generate: async ({ groupId, messages, now, lastBotMessageAt, lastNonBotMessageAt }) => {
            /**
             * ★ 2026-11-05 心跳人性化（wake 模式）：**不生成正文**，只拼一条「你看了一眼群」的
             * 指令，交给扩展桥 `caps.wakeTo` 唤醒 agent —— 让她用完整人格（角色卡 + 群语感 +
             * 时间）自己调 `group_history` 看真实最后 10 条，再决定接不接；没话就 `reply_gate(false)`。
             *
             * mode 只从配置解析（`resolveGenerationMode`，与调度器**同一实现**），
             * 缺省 legacy ⇒ 现有 e2e 的「模型输出 = 群里发的正文」行为完全不变。
             *
             * `lastBotMessageAt` / `lastNonBotMessageAt` 必须来自 heartbeat state：
             * bot 自己的发言不在 `messages` 里（硬阻塞 #3），从 messages 里捞永远是 0。
             */
            if (resolveGenerationMode(config, groupId) === 'wake') {
                if (!cfgResult.backgroundEnabled)
                    return null;
                return {
                    wakePrompt: buildWakePrompt({
                        now: typeof now === 'number' && Number.isFinite(now) ? now : nowFn(),
                        lastBotMessageAt: Number(lastBotMessageAt) || 0,
                        lastNonBotMessageAt: Number(lastNonBotMessageAt) || 0,
                        negativeHit: hitNegative(messages, dicts.negativeWords) ?? null,
                    }),
                    // wake 模式没有正文：wake 失败 = 沉默（方案 4.4，**不补发**旧模板文案）。
                    text: undefined,
                };
            }
            // ── legacy 模式：原逻辑一字不改（行为不变）──
            if (!host.complete)
                return null;
            if (!cfgResult.backgroundEnabled)
                return null;
            const negativeHit = hitNegative(messages, dicts.negativeWords);
            const prompt = buildHeartbeatPrompt({ messages, negativeHit });
            const raw = await host.complete({
                model: config.model_config.heartbeatModel,
                system: HEARTBEAT_SYSTEM,
                prompt,
                maxTokens: config.heartbeat_config.heartbeatMaxTokens,
                timeoutMs: config.heartbeat_config.heartbeatTimeoutMs,
            });
            const parsed = parseHeartbeatOutput(raw);
            if (!isUsableHeartbeatText(parsed.text)) {
                logWarn(logger, `[r4] 心跳：${groupId} 生成内容不可用（空/超长/仅标签）→ 跳过`);
                return null;
            }
            return { text: parsed.text, tag: parsed.tag };
        },
        send: host.sendToGroup
            ? async (groupId, text) => {
                try {
                    return await host.sendToGroup(groupId, text);
                }
                catch (error) {
                    logWarn(logger, `[r4] 心跳：发送 ${groupId} 抛错 → 视为失败：${error instanceof Error ? error.message : String(error)}`);
                    return false;
                }
            }
            : undefined,
        /**
         * ★ 2026-11-05 心跳 wake：把指令写进 outbox（**只是入队**，不是已送达）。
         * 真实现走 `r4-bridge.ts#sendWakeToGroup`；缺失时调度器会按「wake 模式未接线」跳过，
         * 不会退化成发 legacy 文案（回滚语义由调度器统一处理：false → 回滚 waiting）。
         */
        sendWake: sendWakeToGroup
            ? async (payload) => {
                try {
                    return await sendWakeToGroup(payload);
                }
                catch (error) {
                    logWarn(logger, `[r4] 心跳：wake 入队 ${payload?.groupId ?? ''} 抛错 → 视为失败：${error instanceof Error ? error.message : String(error)}`);
                    return false;
                }
            }
            : undefined,
        now: nowFn,
        random: randomFn,
    };
    /* ───── 提取 ───── */
    const extractionDeps = {
        config,
        root,
        logger,
        listGroups: groups,
        readMessages: (groupId, limit) => messagesOf(groupId, 24 * 60 * 60 * 1000).filter((m) => !m.self).slice(-Math.max(1, limit)),
        extract: async ({ groupId, messages }) => {
            if (!host.complete)
                return { accepted: 0 };
            if (!cfgResult.backgroundEnabled)
                return { accepted: 0 };
            // 按发送者分组（2026-11-03 修复 P1-5）：模型输出必须按**被提取者**归集，
            // 不能拿一份全局 tags 写给群里所有人（那会让所有人拿到同一套画像）。
            const byUser = new Map();
            for (const m of messages) {
                if (m.self)
                    continue;
                const uid = sanitizeId(m.senderId);
                if (!uid)
                    continue;
                const list = byUser.get(uid) ?? [];
                list.push(m);
                byUser.set(uid, list);
            }
            if (byUser.size === 0)
                return { accepted: 0 };
            let accepted = 0;
            for (const [userId, userMessages] of byUser) {
                const text = userMessages.map((m) => `${m.senderName || m.senderId}: ${m.text}`).join('\n');
                if (!text.trim())
                    continue;
                let raw;
                try {
                    raw = await host.complete({
                        model: config.model_config.extractionModel,
                        system: EXTRACTION_SYSTEM(config.privacy_whitelist),
                        prompt: text,
                        maxTokens: config.extraction_config.extractionMaxTokens,
                        timeoutMs: config.extraction_config.extractionTimeoutMs,
                    });
                }
                catch (error) {
                    logWarn(logger, `[r4] 提取：${groupId}/${userId} 模型调用失败（已跳过）：${error instanceof Error ? error.message : String(error)}`);
                    continue;
                }
                let parsed;
                try {
                    parsed = JSON.parse(stripCodeFence(raw));
                }
                catch {
                    logWarn(logger, `[r4] 提取：${groupId}/${userId} 模型输出非 JSON → 整次跳过，不写入`);
                    continue;
                }
                try {
                    const result = persistExtraction({
                        userId,
                        output: parsed,
                        dictionaries: dicts,
                        privacyWhitelist: config.privacy_whitelist,
                        root,
                        now: nowFn(),
                        logger,
                    });
                    accepted += result.accepted;
                }
                catch (error) {
                    logWarn(logger, `[r4] 提取：${groupId}/${userId} 入库失败（已跳过）：${error instanceof Error ? error.message : String(error)}`);
                }
                /**
                 * ★ 2026-11-05 R4.3（D2）：**事件提取接入** —— F1 的唯一生产路径。
                 *
                 * 批次 C 报告指出：没有这一步，事件表永远是空的，F1 打开后也不会有任何产出。
                 * 安全边界：`events` 与 `tags` **完全独立解析** ——
                 *   事件解析失败只影响事件，**绝不影响画像提取**（画像才是主业务）。
                 */
                try {
                    if (config.features_config.memory_link) {
                        const merged = mergeExtractedEvents({
                            userId,
                            groupId,
                            extracted: parsed?.events,
                            root,
                            now: nowFn(),
                            config: config.events_config,
                            logger,
                        });
                        if (merged > 0)
                            logInfo(logger, `[r4] 事件：${groupId}/${userId} 新增 ${merged} 条`);
                    }
                }
                catch { /* 事件提取失败不影响画像 */ }
                /**
                 * ★ 2026-11-05 F1 闭环（P1 修复①）：**合并之后**对「本轮消息文本」做一次完结判定。
                 *
                 * 为什么必须接在这里：`markDone` 只在 `events-close.ts` 里实现，此前**全仓库零调用**
                 * →「考完了/搞定了」永远不会把对应 open 事件置 `done`，后续提及继续合并进这条
                 * 永远 open 的旧链，最终被拖出召回窗口而永久失忆。
                 *
                 * 判定**完全本地**（events-close 的固定完成词表 + 事件关键词双命中），
                 * **不采信模型返回的任何"已完成"标记**（审查标准四.1：不许盲信模型）。
                 * 异常隔离：闭环失败只影响事件，绝不影响画像提取与主聊天。
                 */
                try {
                    if (config.features_config.memory_link) {
                        const closed = closeEventsByText(userId, text, root, nowFn(), config.events_config, logger);
                        if (closed > 0)
                            logInfo(logger, `[r4] 事件：${groupId}/${userId} 完结 ${closed} 条`);
                    }
                }
                catch { /* 完结判定失败不影响画像 */ }
            }
            return { accepted };
        },
        now: nowFn,
    };
    /**
     * ★ 2026-11-05 阶段 5：把 R4 的两条节律（心跳 / 提取）登记到**任务中心**，
     * 不再由本插件自己排 setTimeout。主人要求「定时器全部集成在一起，别的功能不用动」，
     * 所以 `tickHeartbeatOnce` / `runExtractionOnce` 的业务实现**一字未改**，
     * 只把「多久跑一次」交给 `任务中心/tasks.json` 里 `owner:'plugin'` 的两条任务。
     *
     * 不直接 import 扩展包源码（插件不该硬依赖扩展包路径），
     * 而是由宿主注入的 `host.registerTaskCenterExecutor` 直接往全局注册表登记。
     * 宿主没提供该能力时（旧宿主/测试）→ 传 undefined → 走原来的自我续排，行为不变。
     */
    const scheduler = createScheduler({ heartbeat: heartbeatDeps, extraction: extractionDeps }, host.registerTaskCenterExecutor
        ? {
            registerHeartbeat: (fn) => host.registerTaskCenterExecutor('r4-heartbeat', fn),
            registerExtraction: (fn) => host.registerTaskCenterExecutor('r4-extract', fn),
        }
        : undefined);
    scheduler.start();
    logInfo(logger, `[r4] 已启动（根=${root}，人格=${persona}，群=${groups().length}，`
        + `字典缺失=${dicts.missing.length}，后台任务=${cfgResult.backgroundEnabled ? '启用' : '禁用'}）`);
    /* ───── P1「她自己的时间」（2026-11-16，默认关）───── */
    /**
     * 为什么是「挂载函数」而不是自动启动：
     *   它需要把提示**投进 agent 的上下文**，而这个能力只有宿主有
     *   （知识来源：心跳走 sendWakeToGroup → outbox → 扩展 caps.wakeTo）。
     *   所以本插件只导出挂载函数，由宿主决定何时接、接到哪个群。
     *
     * 默认关（config.features_config.own_time=false）→ noop，零开销。
     */
    let stopOwnTime;
    const startOwnTimeFor = (opts) => {
        stopOwnTime?.();
        stopOwnTime = undefined;
        if (!config.features_config.own_time) {
            logInfo(logger, '[r4] 自己的时间：配置关闭 → 不启动');
            return () => { };
        }
        if (!sanitizeId(opts.groupId))
            return () => { };
        const otc = config.own_time_config;
        stopOwnTime = mountOwnTime(root, {
            enabled: true,
            intervalMin: otc.intervalMin,
            dailyMax: otc.dailyMax,
            quietFromHour: otc.quietFromHour,
            quietToHour: otc.quietToHour,
        }, {
            deliver: opts.deliver,
            recentPast: opts.recentPast ?? (() => {
                try {
                    const today = dayKeyOf(nowFn(), timeZone);
                    const st = readDailyMood(root, logger);
                    return recentPastEvents(st, today, 2).map((p) => p.date + '：' + p.text);
                }
                catch {
                    return [];
                }
            }),
            logger,
            hourOf: (n) => zonedTime(n, timeZone).hour,
            todayOf: (n) => dayKeyOf(n, timeZone),
        });
        return () => { stopOwnTime?.(); stopOwnTime = undefined; };
    };
    return {
        /** ★ 2026-11-16：暴露 wake 投递（P1 复用，与心跳同链路）。 */
        sendWakeToGroup,
        /** ★ 2026-11-16 P1：宿主可调用它启动「她自己的时间」（默认配置关）。 */
        startOwnTime: startOwnTimeFor,
        assemble,
        onMessage: (input) => {
            const verdict = handleIncomingMessage({ host, root, config, dicts, logger }, input);
            // 2026-11-03 修复 P1-8：装死被吵醒 → 记下文案，供下一次注入消费。
            if (verdict.wokeText) {
                const gid = sanitizeId(input.groupId);
                if (gid)
                    putWokeText(gid, verdict.wokeText);
            }
            /**
             * ★ 2026-11-05 R4.3 F1：入站时召回旧事，暂存供下一次 assemble 消费。
             *
             * 安全边界（红线）：
             *   · 功能开关关闭 / 骨架实现 → 不做任何事（行为不变）
             *   · 任何异常吞掉 —— **绝不阻塞回复**
             *   · 只有真的召回到才写暂存（避免空占位影响 TTL 判定）
             */
            try {
                const gid = sanitizeId(input.groupId);
                const uid = sanitizeId(input.userId);
                if (gid && uid) {
                    // ★ R4.3 F4：维护「连续对话轮数」（独立于 memory_link 开关）
                    if (config.features_config.push)
                        noteConversation(gid, uid);
                    // ★ R4.3 F1：召回旧事 → 暂存待下一次 assemble 消费
                    if (config.features_config.memory_link) {
                        /**
                         * ★ 2026-11-05 F1 闭环（P1 修复②）：**读事件前**先做惰性过期并写回。
                         *
                         * `closeExpired` 此前全仓库零调用 → `events_config.expire_days`（4 天）
                         * 形同虚设，超期 open 事件会一直占据事件表、继续吸收新提及。
                         * 惰性判定（没有新增定时器），只在真有状态变化时写盘。
                         */
                        expireStaleEvents(uid, root, nowFn(), config.events_config, logger);
                        const hint = recallEvents({
                            groupId: gid,
                            userId: uid,
                            text: String(input.text ?? ''),
                            now: nowFn(),
                            config: config.events_config,
                            root,
                        });
                        // ★ 暂存 key 含 userId —— 与 takeRecallHint 的读取 key 必须严格一致。
                        if (hint)
                            pendingRecall.set(recallKey(gid, uid), { hint, at: nowFn() });
                    }
                }
            }
            catch { /* 任何失败都不影响主链 */ }
            return verdict;
        },
        decorateOutgoing: (input) => decorateOutgoingText({
            groupId: input.groupId,
            text: input.text,
            root,
            logger,
            now: nowFn(),
        }),
        /**
         * ★ 2026-11-18 R5.1：用「她这轮实际说了什么」推进情绪底色漂移。
         *
         * 为什么需要这个（真实 bug）：
         *   P3 的 advanceMoodTint 原来只挂在 heartbeat wake 通道上
         *   （见本文件 sendWakeToGroup 的 r4DecorateOutgoing），
         *   而**普通聊天回复根本不走那条路** ⇒ 实测 samples 永远是 0/4，
         *   情绪底色从未生效。
         *
         *   现在由扩展包 outbound/50-mood-driver.mjs 在**每次出站**调用。
         *
         * 安全边界：任何异常返回 false，绝不影响出站。
         */
        advanceMood: (replyText, meta) => {
            try {
                if (!config.features_config.mood_tint)
                    return false;
                const text = String(replyText ?? '').trim();
                if (text.length < 2)
                    return false;

                // ★ 2026-11-20 R5.4：四维漂移（两路信号）
                //   ① 情绪词（明确信号，权重 1.0）
                const lexical = extractAxesSignals(text);
                //   ② 对话特征（间接信号，权重 0.7）
                //      实测：她的真实回复 90% 不带情绪词，
                //      但长度/问句/省略号/间隔都能反映状态。
                const dialogue = extractDialogueSignals(text, meta);
                //   ③ 合并
                const sig = mergeSignals(lexical, dialogue);
                if (!Object.keys(sig).length)
                    return false;   // 两路都判不出 → 不推进（不污染）

                //   ④ 读当前状态
                const prev = readAxes(root, logger);

                //   ⑤ EMA 漂移（只推进情绪层四维）
                const drifted = driftAxes(prev, sig, nowFn());

                //   ⑥ ★ 2026-11-21 v3：关系层三维从**官方数据**现算（不落盘、不由本模块推进）
                //      数据源：{qqbotDataRoot}/.qqbot/{attitude,affinity}.json
                //      读不到一律降级 0.5（readRelationLayer 内部保证不抛）
                let next = drifted;
                try {
                    const rel = readRelationLayer(host.qqbotDataRoot || host.qqbotDataRootFor?.(), String(meta?.openid ?? meta?.peerId ?? ''), {
                        now: nowFn(),
                        energy: drifted.energy,
                    });
                    if (rel && rel.hasData) next = applyRelation(drifted, rel, nowFn());
                }
                catch { /* 官方数据读不到 → 保留情绪层结果，不影响主流程 */ }

                //   ⑦ 原子写
                return writeAxes(root, next, logger);
            }
            catch {
                return false;
            }
        },
        /**
         * ★ 2026-11-20 R5.4：生活层注入（可选，由调用方按需调）。
         *   把「时段 + 外部状态 + 素材」合并成基线偏移，叠加到当前状态。
         *
         *   为什么单独开一个方法：生活层数据读取有 IO 成本，
         *   不需要每轮都读（比如 10 分钟缓存一次就够）。
         */
        applyLifeBaseline: (lifeData) => {
            try {
                if (!config.features_config.mood_tint)
                    return false;
                const prev = readAxes(root, logger);
                const merged = mergeLayers(lifeData);
                const next = applyAxesBaseline(prev, merged, nowFn());
                return writeAxes(root, next, logger);
            }
            catch {
                return false;
            }
        },
        /** 读当前四维状态（诊断用）。 */
        readMoodAxes: () => {
            try { return readAxes(root, logger); } catch { return null; }
        },
        /**
         * ★ 2026-11-18 R5.1：这一轮该不该给她加「小脾气」前缀。
         *
         * 原来 sulk 状态机完整实现但从没被调用（decorateOutgoing 无消费方）。
         * 现在由扩展包 outbound/55-sulk-prefix.mjs 在出站时问一次。
         */
        shouldSulk: (groupId) => {
            try {
                const gid = sanitizeId(groupId);
                if (!gid)
                    return false;
                const st = readHeartbeat(gid, root, logger);
                return shouldInjectSulk(st, nowFn());
            }
            catch {
                return false;
            }
        },
        /**
         * ★ 2026-11-18 R5.1：清掉小脾气状态（加过前缀之后必须调，防重复）。
         */
        clearSulk: (groupId) => {
            try {
                const gid = sanitizeId(groupId);
                if (!gid)
                    return;
                const st = readHeartbeat(gid, root, logger);
                writeHeartbeat(gid, clearCold(st), root, logger);
            }
            catch { /* 绝不影响出站 */ }
        },
        tickHeartbeatOnce: () => scheduler.tickHeartbeatOnce(),
        runExtractionOnce: () => scheduler.runExtractionOnce(),
        stop: () => {
            // ★ 2026-11-16 P1：停定时器（不清理会泄漏 interval）
            try {
                stopOwnTime?.();
            }
            catch { /* 幂等 */ }
            stopOwnTime = undefined;
            scheduler.stop();
        },
        diagnostics: () => ({
            root,
            persona,
            configPath: cfgResult.path,
            configLoaded: cfgResult.loaded,
            backgroundEnabled: cfgResult.backgroundEnabled,
            dictMissing: dicts.missing,
            groups: groups().length,
            sleepWindow: isSleepWindow(zonedTime(nowFn(), timeZone).hour),
            schedulerRunning: scheduler.running,
            /** ★ 2026-11-16「活人感」功能开关快照（便于排查"为什么没生效"）。 */
            features: {
                lifeContinuity: config.features_config.life_continuity,
                absenceHint: config.features_config.absence_hint,
                ownTime: config.features_config.own_time,
                ownTimeRunning: Boolean(stopOwnTime),
                moodTint: config.features_config.mood_tint,
                lifeSlotFix: config.features_config.life_slot_fix,
            },
            /** bot 自身 openid（供宿主解析 `@bot`；空 = 未解析到）。 */
            botOpenid: botOpenid(),
            heartbeat: config.heartbeat_config,
        }),
    };
}
export { withTimeout, buildProfileText, rollbackWaitSent, shouldInjectSulk, withSulkPrefix, keepColdWhenSkipped, SULK_PREFIX, relationshipTagOf, otherTagText, r4SectionName, writeHeartbeat, readHeartbeat, readRelationships, writeRelationships, applyScore, classifyScoreKind, applyTemporaryCold, markTagMentionsByReply, persistExtraction };
