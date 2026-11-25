/**
 * review-collector — 复盘语料采集器（从 `index.ts` 拆出，重构任务 B4）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 🔴 红线 R1（主人明确要求，改动前必读）：
 *
 *   `lastAssistantText` / `lastJudgedReply` 这两个 Map **必须是唯一实例**。
 *   它们被「采集」（本文件）和「复盘执行」（`maintenance-tasks.ts`）**两边读写**：
 *     · 采集时写入：`assistant/message` → `lastAssistantText`；`turn/end` → `lastJudgedReply`
 *     · 复盘时读取：判断「这条是否已经判过」、取「上一句回复」
 *
 *   若拆成两份拷贝 → 复盘永远读到空语料 → **功能静默失效且不报错**
 *   （日志只会说"没有纠偏语料，跳过"，看起来完全正常）。
 *
 *   ✅ 正确做法：本文件**持有并导出**这两个 Map，复盘模块通过 `getState()` 拿**引用**，
 *     绝不自己 `new Map()`。
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 职责：监听 `session/event`，从会话事件里捞三类语料：
 *   ① 纠偏语料（用户纠正 → 记入错题本）
 *   ② 高光时刻（用户夸赞 → 记下 bot 上一条回复）
 *   ③ 自动判官（turn/end 时评估上一条回复 → 不合格记入错题本）
 *   顺带：把每条真人消息喂给 R4（关系计分 / 凌晨装死放行）
 *
 * 🔵 依赖全部注入（本文件不 import r4/index.js、不 import index.ts —— 防循环）：
 *   `groupIdForSession` / `personaRoots` / `r4` / `r4.onMessage` / `r4SenderOf` / `r4MentionFlagsOf`
 *   都由 index 传入。这样本模块只认"传进来的函数"，对上游实现变化无感。
 */
import { appendHighlight, isPraiseText } from './highlights.js';
import { judgeReply } from './judge.js';
import { personaForGroup } from './persona.js';
import { appendReviewRecord, eventText, isCorrectionText, isRealUserMessage, } from './review.js';
import { HEARTBEAT_WAKE_MARKER } from './r4/heartbeat-gen.js';
/** 会话记忆上限（防止 Web/子会话涌入把 Map 撑大）。 */
const SESSION_MEMORY_LIMIT = 200;
export function createReviewCollector(deps) {
    const { config } = deps;
    const logger = deps.logger ?? {};
    const llm = deps.llm;
    // ★ 唯一实例（红线 R1）：这两个 Map 全进程只有这一份
    const lastAssistantText = new Map();
    const lastJudgedReply = new Map();
    /**
     * 记住一条（LRU 淘汰）：先 delete 再 set 保证「最近使用」语义，
     * 超过 `SESSION_MEMORY_LIMIT` 时淘汰插入序最旧的。
     */
    const remember = (map, key, value) => {
        map.delete(key);
        map.set(key, value);
        while (map.size > SESSION_MEMORY_LIMIT) {
            const oldest = map.keys().next().value;
            if (oldest === undefined)
                break;
            map.delete(oldest);
        }
    };
    /**
     * 处理一条 `session/event`。
     *
     * 导出成独立函数（而不是直接写在内联回调里）有两个好处：
     *   ① 可以被单测直接喂假事件
     *   ② 监听注册与业务逻辑分离，便于将来换事件源
     */
    const handleSessionEvent = (session, event) => {
        try {
            const sid = String(session?.id || '');
            if (!sid)
                return;
            if (event?.type === 'assistant/message') {
                const text = eventText(event);
                if (text)
                    remember(lastAssistantText, sid, text);
                return;
            }
            if (event?.type === 'turn/end') {
                if (!config.autoJudgeEnabled)
                    return;
                const replyText = lastAssistantText.get(sid) || '';
                if (!replyText)
                    return;
                if (lastJudgedReply.get(sid) === replyText)
                    return;
                remember(lastJudgedReply, sid, replyText);
                const groupId = deps.groupIdForSession(sid);
                if (!groupId)
                    return;
                const persona = personaForGroup(deps.personaRoots(), groupId);
                void (async () => {
                    try {
                        const result = await judgeReply({ llm, logger }, groupId, persona, replyText, {
                            llm,
                            logger,
                            minLength: config.autoJudgeMinLength,
                            rate: config.autoJudgeRate,
                            provider: config.reviewProvider,
                            model: config.reviewModel,
                        });
                        if (result.passed || result.skipped) {
                            // 2026-11-05 诊断增强（方案 A）：PASS 此前**完全静默**，从日志上无法判断
                            //   判官到底跑过没有（只能靠反转储 session 事件间接推断）。
                            //   这里只在「真的调了模型」时记一行 —— `skipped` 的
                            //   too-short / rate-zero / sampled-out 属于按设计跳过，打了只会刷屏。
                            //   ⚠️ 本改动**不参与任何判定**，只多一行日志，PASS/FAIL 结果与之前完全一致。
                            if (!result.skipped) {
                                logger.info?.(`[bnnbotbox] 自动判官通过：群 ${groupId}：${result.reason}（${replyText.slice(0, 20)}）`);
                            }
                            return;
                        }
                        appendReviewRecord({
                            at: Date.now(),
                            sessionId: sid,
                            groupId,
                            persona,
                            source: 'judge',
                            userText: `[自动判官] ${result.reason}`,
                            assistantText: replyText,
                        });
                        logger.info?.(`[bnnbotbox] 自动判官记入错题本：群 ${groupId}/${persona}：${result.reason}`);
                    }
                    catch (error) {
                        logger.warn?.(`[bnnbotbox] 自动判官异常（忽略）：${error instanceof Error ? error.message : String(error)}`);
                    }
                })();
                return;
            }
            if (!isRealUserMessage(event))
                return;
            const userText = eventText(event);
            if (!userText)
                return;
            // ═══════════════════════════════════════════════════════════════════════
            // ★ 2026-11-05 心跳 wake 守卫（第一道，关键）—— 必须在**任何写入/调用之前**
            //
            //   心跳 wake 模式通过 `manager.injectToPeer(scope, peerId, text, 'user')` 往群会话
            //   注入一条 `source.kind='user'` 的消息 → 会被 `isRealUserMessage` 当成真人发言。
            //   这里整条丢弃，否则后面会依次被污染：
            //     · `r4.onMessage` → 关系计分（messageCount / firstMetAt）
            //     · r4/index.ts 的 onMessage 包装层 → `noteConversation`（连续对话轮数，影响 R4.3 F4）
            //     · 同上 → `recallEvents(整段 wake 指令)` 关键词误匹配，把召回注入**同一轮**
            //     · `isPraiseText` → wake 指令正文含「绝了/好可爱」→ 记进高光
            //     · `isCorrectionText` → 含「太长不看/像AI」→ 记进错题本
            //
            //   ⚠️ 只在 `r4/inbound.ts` 里拦是无效的：上面这些都在它后面照跑。
            //   ⚠️ 标记字符串**禁止硬编码**：必须引用 heartbeat-gen 导出的同一个常量。
            // ═══════════════════════════════════════════════════════════════════════
            if (userText.startsWith(HEARTBEAT_WAKE_MARKER)) {
                logger.info?.('[bnnbotbox] 丢弃心跳唤醒内部指令（非真人发言，不入账）');
                return;
            }
            // ── R4.0：逐条真人消息 → 关系计分 / 凌晨装死放行 / 临时冷淡 ──
            // ★ 2026-11-03 修复 P0-2 / P1-1：必须从 **event 原文**里解析 @bot 与「引用 bot」，
            //   不能只看 `eventText(event)`（它来自已清洗的正文，`<@…>` 早被剥掉）。
            //   拿不到 marked 信息时退化：`atBot` 由 `<@…>` 出现 + 已知 bot openid 比对（一次），
            //   `quoteBot` 由 event.data.context/quote 结构体判定（结构缺失则 false）。
            try {
                const r4 = deps.getR4();
                if (r4) {
                    const gid2 = deps.groupIdForSession(sid);
                    // ★ 2026-11-04：senderId 必须**先拿群号再查**（旁路 Map 的键是 `group:<peerId>`）。
                    const uid2 = deps.r4SenderOf(sid, gid2);
                    if (gid2 && uid2) {
                        const flags = deps.r4MentionFlagsOf(event);
                        const verdict = r4.onMessage({
                            groupId: gid2,
                            userId: uid2,
                            text: userText,
                            atBot: flags.atBot,
                            quoteBot: flags.quoteBot,
                        });
                        if (!verdict.allow)
                            logger.info?.(`[bnnbotbox] R4 凌晨装死丢弃：群 ${gid2}`);
                    }
                }
            }
            catch { /* R4 消息处理失败不影响主链 */ }
            // ── 高光时刻（2026-11-02 新增）：群友/主人发出明确夸赞 → 记下 Bot 上一条回复 ──
            // 与「纠偏」并列：夸赞词表与纠偏词表不重叠，且 isPraiseText 已排除「像AI/太长了」等负语境。
            if (isPraiseText(userText)) {
                const sidForPraise = sid;
                const praised = lastAssistantText.get(sidForPraise) || '';
                const gid = deps.groupIdForSession(sidForPraise);
                if (praised && gid) {
                    const who = personaForGroup(deps.personaRoots(), gid);
                    const wrote = appendHighlight({
                        at: Date.now(),
                        groupId: gid,
                        persona: who,
                        note: userText,
                        text: praised,
                    });
                    if (wrote)
                        logger.info?.(`[bnnbotbox] 记录高光：群 ${gid}/${who} ←「${userText.slice(0, 20)}」`);
                }
            }
            if (!isCorrectionText(userText))
                return;
            const assistantText = lastAssistantText.get(sid) || '';
            if (!assistantText)
                return;
            const groupId = deps.groupIdForSession(sid);
            if (!groupId)
                return;
            appendReviewRecord({
                at: Date.now(),
                sessionId: sid,
                groupId,
                persona: personaForGroup(deps.personaRoots(), groupId),
                source: 'correction',
                userText,
                assistantText,
            });
            logger.info?.(`[bnnbotbox] 记录纠偏语料：群 ${groupId}「${userText.slice(0, 30)}」`);
        }
        catch (error) {
            logger.warn?.(`[bnnbotbox] 纠偏语料记录失败（已忽略）：${error instanceof Error ? error.message : String(error)}`);
        }
    };
    // 监听清理句柄（install() 时填充）
    let off;
    const install = (register) => {
        const ret = register(handleSessionEvent);
        if (typeof ret === "function")
            off = ret;
    };
    return {
        getState: () => ({ lastAssistantText, lastJudgedReply }),
        handleSessionEvent,
        install,
        dispose: () => {
            try {
                if (typeof off === "function")
                    off();
            }
            catch { /* ignore */ }
            off = undefined;
        },
    };
}
