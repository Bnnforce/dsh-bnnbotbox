import { Config, resolveConfig } from './config.js';
import { createRuntimePaths } from './paths-runtime.js';
import { createSessionMap } from './session-map.js';
import { createR4Bridge } from './r4-bridge.js';
import { createReviewCollector } from './review-collector.js';
import { createMaintenanceTasks } from './maintenance-tasks.js';
import { mountPromptInjector, mountR4 } from './r4-mount.js';
import { createMemoryRecallHost } from './memory-recall-host.js';
import { resolveReviewRoute, } from './review.js';
import { appendFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { personaDataRoot } from './r4/paths.js';
import { PersonaService } from './persona-service.js';
export const name = 'anti-ai-persona';
export const inject = ['systemPrompt', 'llm'];
export { Config };
function loggerOf(ctx) {
    return ctx.logger ?? {};
}
export function apply(ctx, rawConfig) {
    const config = resolveConfig(rawConfig);
    if (!config.enabled)
        return;
    const logger = loggerOf(ctx);
    const inflightGroups = new Set();
    let allRunning = false;
    // ── 运行时路径解析（拆到 paths-runtime.ts，重构任务 B1）─────────────────────
    //    注：那里的注释保留了 2026-11-03「R4 空转」根因的完整说明，别删。
    const runtimePaths = createRuntimePaths(config, logger);
    const qqbotDataRoot = runtimePaths.qqbotDataRoot;
    const personaRoots = runtimePaths.personaRoots;
    // ── sessionId ↔ groupId 旁路映射（拆到 session-map.ts，重构任务 B2）─────────
    //    🔴 红线 R3：读取 session-groups.json 的**唯一**入口就是它，别在别处再读一遍。
    const sessionMap = createSessionMap();
    const groupIdForSession = sessionMap.groupIdForSession;
    const groupIdFromContext = sessionMap.groupIdFromContext;
    // ── 后台维护任务（拆到 maintenance-tasks.ts，重构任务 B5）───────────────────
    //    四块合并：guideline 刷新 / 复盘执行 / 任务中心登记 / 提取启动补偿。
    //    真正的实例化在下面 `const llm = ...` 之后（因为需要 llm）。
    const llm = ctx.llm ?? ctx.get?.('llm');
    // ── 记忆联想化（2026-11-08）：第一层「被动联想」+ 第二层「主动惦记」共用 ──
    //    数据来自**另一个插件** dsh-qq-memory 的 cordis 服务 `qqMemory`。
    //    ★ 每次现取（记忆插件可能晚于本插件挂载，不能缓存 undefined）；
    //    ★ 三重防御全在 createMemoryRecallHost 内：缺席/版本不符/读盘失败 → 空串。
    const getMemoryService = () => {
        try {
            const getter = ctx?.get;
            return typeof getter === 'function' ? getter.call(ctx, 'qqMemory') : undefined;
        }
        catch {
            return undefined;
        }
    };
    const memoryRecallHost = createMemoryRecallHost({
        logger,
        getService: getMemoryService,
        config: {
            enabled: config.memoryRecallEnabled,
            budgetChars: config.memoryRecallBudgetChars,
            personChars: config.memoryRecallPersonChars,
            groupChars: config.memoryRecallGroupChars,
            eventsChars: config.memoryRecallEventsChars,
            recentDays: config.memoryRecallRecentDays,
            cacheTtlMs: Math.round(config.memoryRecallCacheTtlMin * 60_000),
            maxPersonFiles: config.memoryRecallMaxPersonFiles,
            maxEvents: config.memoryRecallMaxEvents,
        },
    });
    const maintenanceTasks = createMaintenanceTasks({
        config: {
            analysisIntervalMin: config.analysisIntervalMin,
            analysisMaxHistoryDays: config.maxHistoryDays,
            reviewEnabled: config.reviewEnabled,
            reviewHour: config.reviewHour,
            reviewProvider: config.reviewProvider,
            reviewModel: config.reviewModel,
            // 碎片生活流（2026-11-07）
            lifeStreamEnabled: config.lifeStreamEnabled,
            lifeStreamDailyMax: config.lifeStreamDailyMax,
            lifeStreamMinGapMin: config.lifeStreamMinGapMin,
            lifeStreamHoursFrom: config.lifeStreamHoursFrom,
            lifeStreamHoursTo: config.lifeStreamHoursTo,
            // 记忆联想 · 第二层「主动惦记」（2026-11-08）
            memoryCallbackEnabled: config.memoryCallbackEnabled,
            memoryCallbackDailyMax: config.memoryCallbackDailyMax,
            memoryCallbackMinGapDays: config.memoryCallbackMinGapDays,
            memoryCallbackHoursFrom: config.memoryCallbackHoursFrom,
            memoryCallbackHoursTo: config.memoryCallbackHoursTo,
            memoryCallbackMinMessages: config.memoryCallbackMinMessages,
            memoryCallbackOwnBirthday: config.memoryCallbackOwnBirthday,
        },
        logger,
        llm,
        qqbotDataRoot,
        personaRoots,
        // 第二层要用「生日清单 + 显示名」；记忆插件缺席时两个方法都返回空 → 该判据降级
        memory: {
            personName: memoryRecallHost.personName,
            birthdays: memoryRecallHost.birthdays,
        },
    });
    const refreshGroup = maintenanceTasks.refreshGroup;
    const refreshAll = maintenanceTasks.refreshAll;
    /** R4 后台任务是否可用：以 R4 运行时就绪 + 诊断里的 backgroundEnabled 为准。 */
    const r4BackgroundEnabled = () => {
        try {
            if (!r4)
                return false;
            const diag = r4.diagnostics();
            return diag.backgroundEnabled === true;
        }
        catch {
            return false;
        }
    };
    // ── R4 外部能力（拆到 r4-bridge.ts，重构任务 B3）────────────────────────────
    //    四块（群列表/senderId/mention/bot身份/发消息）合并成一个文件，共享 qqbotDataRoot。
    //    🔵 依赖注入：R4 实例相关能力（diagnostics / decorateOutgoing）由下面传入，
    //       本模块不 import r4/index.js —— 这是防循环依赖的第二道保险。
    const r4Bridge = createR4Bridge({
        qqbotDataRoot,
        logger,
        r4Diagnostics: () => { try {
            return r4?.diagnostics();
        }
        catch {
            return undefined;
        } },
        r4DecorateOutgoing: (input) => {
            if (!r4)
                return { text: input.text, injected: false };
            return r4.decorateOutgoing(input);
        },
    });
    const r4Groups = r4Bridge.r4Groups;
    const r4SenderOf = r4Bridge.r4SenderOf;
    const r4MentionFlagsOf = r4Bridge.r4MentionFlagsOf;
    const r4BotOpenid = r4Bridge.r4BotOpenid;
    const sendToGroupViaBridge = r4Bridge.sendToGroupViaBridge;
    // ── cordis 服务 `persona`（统一架构，2026-11-06）───────────────────────────
    //    🔴 红线 R2：session-groups.json 的唯一持有者仍是上面的 sessionMap；
    //       本服务只转发结果，**绝不自己再读那个文件**（否则两份 mtime 缓存不同步 → 串群）。
    //    消费方（如 dsh-qq-memory）通过 `ctx.get('persona')` 或 `inject: ['persona']` 使用。
    //    降级：cordis 版本过旧没有 Service 可用时，服务注册失败但不影响插件主功能。
    let personaService;
    try {
        personaService = new PersonaService(ctx, {
            logger,
            // ★ 2026-11-15：把 session-map 的写入能力交给服务（唯一写入口）
            //   红线 R2/R3 不变：文件仍只由 session-map.ts 读写，服务只是转发。
            rememberSessionGroup: (sid, gid) => sessionMap.rememberSessionGroup(sid, gid),
            groupIdForSession,
            senderOf: (sid, gid) => r4SenderOf(sid, gid),
        });
        logger.info?.('[anti-ai-persona] cordis 服务 persona 已注册（session-map 唯一持有者）');
    }
    catch (err) {
        logger.warn?.(`[anti-ai-persona] 注册 persona 服务失败（不影响主功能）: ${err instanceof Error ? err.message : String(err)}`);
    }
    // ── 复盘语料采集（拆到 review-collector.ts，重构任务 B4）──────────────────────
    //    🔴 红线 R1：lastAssistantText / lastJudgedReply 两个 Map **全进程唯一实例**，
    //       由 collector 持有；复盘模块通过 collector.getState() 拿引用，绝不许复制。
    const reviewCollector = createReviewCollector({
        config: {
            autoJudgeEnabled: config.autoJudgeEnabled,
            autoJudgeMinLength: config.autoJudgeMinLength,
            autoJudgeRate: config.autoJudgeRate,
            reviewProvider: config.reviewProvider,
            reviewModel: config.reviewModel,
        },
        logger,
        llm,
        groupIdForSession,
        personaRoots,
        // R4 是后挂载的（在下面 r4 才被赋值），所以用 getter 取当前值
        getR4: () => r4,
        r4SenderOf,
        r4MentionFlagsOf,
    });
    // ctx.on 是 (event, handler)；install 期望 (handler) —— 这里做一层薄适配
    reviewCollector.install((handler) => ctx.on('session/event', handler));
    const offReviewEvent = () => reviewCollector.dispose();
    /** 带超时的 Promise 包装（R4 模型调用用）。 */ const withTimeoutR4 = async (task, ms) => {
        let timer;
        const timeout = new Promise((resolve) => {
            timer = setTimeout(() => resolve({ timedOut: true }), Math.max(1, ms));
            timer.unref?.();
        });
        try {
            const r = await Promise.race([task.then((value) => ({ timedOut: false, value })), timeout]);
            return r.timedOut ? { timedOut: true } : { timedOut: false, value: r.value };
        }
        catch {
            return { timedOut: false };
        }
        finally {
            if (timer)
                clearTimeout(timer);
        }
    };
    /** 模型 ID → 路由（配置给谁就用谁，否则复用复盘的低阶模型解析）。 */
    const resolveRouteFor = async (modelId) => {
        if (!llm)
            return undefined;
        const id = String(modelId ?? '').trim();
        if (id === '' || id.startsWith('...'))
            return undefined;
        try {
            const base = await resolveReviewRoute(llm, '', id);
            if (base)
                return base;
            const providers = typeof llm.listProviders === 'function' ? await llm.listProviders() : [];
            for (const provider of Array.isArray(providers) ? providers : []) {
                const models = typeof llm.listModels === 'function' ? await llm.listModels(provider.id) : [];
                for (const model of Array.isArray(models) ? models : []) {
                    if (String(model?.id ?? '') === id)
                        return { provider: provider.id, model: id };
                }
            }
        }
        catch { /* fallthrough */ }
        return undefined;
    };
    /** 向群发消息（心跳用）：走 qqbot 全局会话注册表；拿不到如实返回 false（状态会回滚）。 */
    /**
     * 向群里发消息（心跳用）。
     *
     * ★ 2026-11-04 修复（**心跳永远发不出去的根因**）：
     *   旧实现只认 `globalThis[Symbol.for('qqbot.session-registry')]` —— 那个 Symbol
     *   在本机**从来没有任何写入方**（扩展包与 QQBot 本体全仓都搜不到），
     *   于是 `managers` 恒为 `[]`，函数恒 `return false`：心跳只要判定「该发」，
     *   就会走「发送失败 → 回滚」，永远开不了口，且每次白跑一轮模型调用。
     *
     *   现在按优先级用**真有实现**的三条通道：
     *     ① `im-qqbot.outbound`（QQBot 官方出站总线，`send(text, { target })`）——最正；
     *     ② `qqbot.session-registry`（前瞻兼容，本机目前为空，保留以防上游将来提供）；
     *     ③ 扩展包发送器兜底（若将来导出）。
     *   全部失败 → 如实返回 false（调度器会回滚，行为不变）。
     */
    // ── 复盘执行（已并入 maintenance-tasks.ts，重构任务 B5）──
    const pruneBuffersSafely = maintenanceTasks.pruneBuffersSafely;
    const runReview = maintenanceTasks.runReview;
    const scheduleNextReview = maintenanceTasks.scheduleNextReview;
    // ── 装配层（拆到 r4-mount.ts，重构任务 B6）────────────────────────────────
    //    ① prompt injector（旧 guideline/overlay/高光注入）
    //    ② R4 运行时装配 + R4 出站注入（含 complete:true 兼容分支）
    //    🔴 红线 R5：每个 mount 返回清理句柄，这里只做聚合。
    const assembleHandlers = [];
    const ctxOnAssemble = (handler) => ctx.on('system-prompt/assemble', handler);
    const offInjector = mountPromptInjector({
        logger,
        llm,
        qqbotDataRoot,
        personaRoots,
        groupIdForSession,
        groupIdFromContext,
        refreshGroup,
        r4Groups,
        r4SenderOf,
        sendToGroupViaBridge,
    }, ctxOnAssemble);
    const r4Mounted = mountR4({
        logger,
        llm,
        qqbotDataRoot,
        personaRoots,
        groupIdForSession,
        groupIdFromContext,
        refreshGroup,
        r4Groups,
        r4SenderOf,
        sendToGroupViaBridge,
        // ★ 2026-11-08 记忆联想（第一层）：R4 assemble 时按 (groupId,userId) 取卡片摘要
        getMemoryRecall: memoryRecallHost.recall,
    }, ctxOnAssemble);
    const r4 = r4Mounted.r4;
    const offR4 = r4Mounted.offR4;
    /* ───── R5.1 全局桥：情绪底色 / 小脾气（2026-11-18）─────
     *
     * 为什么需要桥：
     *   扩展包（.mjs）拿不到插件的 cordis ctx，只能走 globalThis Symbol 约定。
     *   这是本工程已验证的模式（qq-memory 的 \`Symbol.for('dsh.qq-memory.v1')\` 同款）。
     *
     * 为什么要暴露这三个方法：
     *   · advanceMood —— 普通聊天回复不经过 decorateOutgoing（它只覆盖心跳），
     *                    所以情绪漂移必须由**出站扩展**驱动，而它只能调桥。
     *   · shouldSulk / clearSulk —— sulk 状态机完整但从未被调用（死代码），
     *                    同样由出站扩展驱动。
     *
     * 失败降级：桥挂不上不影响插件主功能（扩展侧会判 undefined）。
     */
    try {
        const MOOD_BRIDGE_KEY = 'dsh.anti-ai-persona.mood.v1';
        globalThis[Symbol.for(MOOD_BRIDGE_KEY)] = {
            version: 1,
            /** 用她这轮回复推进情绪底色漂移 */
            advance: (replyText, meta) => {
                try {
                    // ★ 2026-11-21 修（真 bug）：原来**把 meta 丢了** —— 只传 replyText。
                    //   而 advanceMood(replyText, meta) 需要 meta 里的：
                    //     · latencyMs —— 对话特征信号（回复间隔反映状态），四维要用
                    //     · openid    —— 关系层三维查官方 attitude/affinity 的 key
                    //   丢掉后：① latencyMs 永远 undefined，间隔信号完全失效
                    //          ② 关系层三维查不到人 ⇒ 永远 0.5（等于白算）
                    //   这是「八维接上了但关系层不工作」的根因。
                    return r4?.advanceMood?.(String(replyText ?? ''), meta && typeof meta === 'object' ? meta : {}) === true;
                }
                catch {
                    return false;
                }
            },
            /**
             * ★ 2026-11-20 R5.4：应用生活层基线（时段 + 外部状态 + 素材）。
             * 由出站扩展在每轮（或每 N 分钟）调一次。
             *
             * @param {object} lifeData
             *   { slotId, dayBaseline, materialLayer, externalLayer }
             */
            applyLifeBaseline: (lifeData) => {
                try {
                    return r4?.applyLifeBaseline?.(lifeData) === true;
                }
                catch {
                    return false;
                }
            },
            /** 读当前四维状态（诊断用） */
            readAxes: () => {
                try {
                    return r4?.readMoodAxes?.() ?? null;
                }
                catch {
                    return null;
                }
            },
            /** 这一轮该不该加小脾气前缀 */
            shouldSulk: (groupId) => {
                try {
                    return r4?.shouldSulk?.(String(groupId ?? '')) === true;
                }
                catch {
                    return false;
                }
            },
            /** 加过前缀后清状态（防重复） */
            clearSulk: (groupId) => {
                try {
                    r4?.clearSulk?.(String(groupId ?? ''));
                }
                catch { /* ignore */ }
            },
        };
        logger.info?.('[anti-ai-persona] R5.1 桥已挂载：' + MOOD_BRIDGE_KEY);
    }
    catch (err) {
        logger.warn?.(('[anti-ai-persona] R5.1 桥挂载失败（不影响主功能）: ' + (err instanceof Error ? err.message : String(err))));
    }
    /* ───── P1「她自己的时间」（2026-11-16，默认配置关）─────
     *
     * 接线说明（工业标准 ④：默认关 = 零开销）：
     *   · 配置 features_config.own_time 为 true 时才启动；
     *   · 投递走**现成的** sendToGroupViaBridge（与心跳同一条链路，不新建通道）；
     *   · 只对「最近活跃过的群」启动，避免给死群刷提醒；
     *   · 卸载时经 offOwnTime 停表（不泄漏 interval）。
     */
    let offOwnTime;
    /**
     * 挂载诊断（默认关闭 = 零开销）。
     *
     * ★ 2026-11-20 修 P0（审计 P0-1）：原文是
     *     const _diagFile = "{DSH_HOME}/data/dsh-anti-ai-persona/own-time-mount.log";
     *   —— 硬编码作者本机的绝对路径（违反铁律 2），换机写不进去；
     *   而且这是 2026-11-16 一次排障留下的调试代码，不该常驻生产。
     *
     *   现在：① 路径由 personaDataRoot() 解析（跟随 PERSONA_DATA_ROOT / DSH_HOME 配置）；
     *        ② 默认不写（排查时设 BNN_DEBUG_OWN_TIME=1 才开）；
     *        ③ 日志按大小滚动，不会无限增长。
     */
    const _diagOn = String(process.env.BNN_DEBUG_OWN_TIME ?? '') === '1';
    const _diagFile = _diagOn ? join(personaDataRoot(), 'own-time-mount.log') : '';
    const _diag = (m) => {
        if (!_diagOn || !_diagFile) return;
        try {
            // 滚动：超过 512KB 就清空重来，避免长期开着把磁盘写满
            try { if (statSync(_diagFile).size > 512 * 1024) writeFileSync(_diagFile, ''); } catch { /* 文件不存在 */ }
            appendFileSync(_diagFile, new Date().toISOString() + " " + m + "\n");
        }
        catch { /* 诊断失败不影响功能 */ }
    };
    try {
        _diag("mount-check r4=" + String(Boolean(r4)) + " hasStart=" + String(typeof r4?.startOwnTime === "function"));
        if (r4 && typeof r4.startOwnTime === "function") {
            const groupsNow = r4Groups();
            _diag("groups=" + groupsNow.length + " first=" + String(groupsNow[0] ?? "").slice(0, 8));
            // 只在有群时才挂（空列表直接跳过，避免无意义定时器）
            if (groupsNow.length > 0) {
                const target = String(groupsNow[0] ?? ""); // 单群试点（分级发布第 3 级）
                /**
                 * ★ P1 的 deliver（2026-11-16 修正版）。
                 *
                 * ── 之前为什么失败 ──────────────────────────────────────────────
                 * 第一版写的是：
                 *   `globalThis[Symbol.for("qqbot.session-registry")]`
                 * 但插件里 **没有** 这个全局 Symbol（已核实 session-registry.js
                 * 全文无 Symbol.for），只在模块内导出 getManagerByNs/managersOf。
                 * ⇒ 永远取到 undefined ⇒ deliver 永远返回 false ⇒
                 *   P1 每 10 分钟检查一次、每次 "deliver-failed"（实测 09:56/10:06/10:16 三次）。
                 *
                 * ── 正确做法：复用心跳已验证的链路 ──────────────────────────────
                 * 心跳的成功路径是：
                 *   sendWakeToGroup(写 outbox) → 扩展 hooks/r4-heartbeat-bridge.mjs
                 *   → caps.wakeTo() → manager.injectToPeer()
                 * 这条链路 2026-11-04 踩坑后验证过、有 receipt 可查（status:'injected'）。
                 * P1 要的语义与心跳完全一致（静默注入上下文、不产出群消息），
                 * 所以直接复用 sendWakeToGroup，**不另建通道**（架构审查第 4 条）。
                 */
                offOwnTime = r4.startOwnTime({
                    groupId: target,
                    deliver: async (text) => {
                        try {
                            const wake = r4?.sendWakeToGroup;
                            if (typeof wake !== "function")
                                return false;
                            // wake 模式：只给 wakePrompt（不给正文），由被唤醒的 agent 用完整人格自己说
                            // ⚠️ id/text 必填（桥用 id 判重；老桥 `if (!text) return null` 会整条丢弃，所以 text 写空串）
                            const nowMs = Date.now();
                            const wid = target + "-" + nowMs + "-" + Math.random().toString(36).slice(2, 8);
                            const ok = await wake({ id: wid, groupId: target, text: "", at: nowMs, wakePrompt: text });
                            if (ok) {
                                logger.info?.("[persona] 自己的时间：已投递 " + target.slice(0, 8));
                            }
                            // 失败静默：会话被回收时必然失败（平台约束），下次再试即可
                            return ok;
                        }
                        catch (error) {
                            logger.warn?.("[persona] 自己的时间：投递异常 " + (error instanceof Error ? error.message : String(error)));
                            return false;
                        }
                    },
                });
                _diag("mounted-ok target=" + target.slice(0, 8));
            }
            else {
                _diag("skip: no-groups");
            }
        }
    }
    catch (error) {
        _diag("mount-error " + String(error instanceof Error ? error.message : error));
    }
    // ── 任务中心登记 + 提取启动补偿（已并入 maintenance-tasks.ts，重构任务 B5）────
    //    🔴 红线 R4：那段「任务中心不可用 → 退回自排定时器」的降级逻辑是阶段 5 定的，
    //       现已逐字搬到 maintenance-tasks.ts，**不要在这里重写**。
    maintenanceTasks.registerTaskCenterTasks();
    maintenanceTasks.mountStartupCompensation(r4 ? () => r4.runExtractionOnce() : async () => ({ skipped: true }));
    /**
     * 资源回收。
     *
     * ★ 2026-11-02 修「effect 降级回落」：
     *   旧实现是 `ctx.effect?.(() => () => {...})` —— 一旦宿主不提供 `effect`（或它抛错），
     *   `?.()` 会让**整个清理块被静默跳过**：timer / reviewTimer / 两个 off 一个都不收。
     *   现在改为「优先 effect，失败则手动登记 + 立即可行的就地清理」：
     *     ① `ctx.effect` 存在 → 用它（由 cordis fiber 统一回收，语义最正）；
     *     ② 不存在或调用抛错 → 走 fallback：把清理函数存起来，同时尝试
     *        `ctx.on('dispose'|'fs/unload')` 之类没有就**至少在插件重载时**由下面的
     *        `cleanup()` 被再次调用（幂等，重复清理无副作用）。
     *   注意：`ctx.on` 注册的监听在 cordis 里本身就挂在 fiber effect 上（会随 fiber 卸载自动摘），
     *   所以这里的手动 off 是**双保险**，不依赖它也不会泄。
     */
    let cleanedUp = false;
    const cleanup = () => {
        if (cleanedUp)
            return;
        cleanedUp = true;
        // ★ 2026-11-05（重构任务 B5 + 红线 R5）：
        //   原 timer / reviewTimer / compensateTimer 三个定时器已全部移交给 maintenance-tasks.ts，
        //   这里只做**聚合调用** —— 谁创建谁负责清理，index 不再逐个 clearXxx。
        try {
            maintenanceTasks.dispose();
        }
        catch { /* ignore */ }
        // ★ 2026-11-05（重构任务 B6 + 红线 R5）：装配层的监听也改为聚合清理。
        //    `r4?.stop()` 保留 —— 它是 R4 内部调度器的停止入口，不属于 mountR4 的 off 句柄。
        try {
            if (typeof offInjector === 'function')
                offInjector();
        }
        catch { /* ignore */ }
        // ★ 2026-11-16 P1：先停「自己的时间」定时器，再卸 R4
        try {
            offOwnTime?.();
        }
        catch { /* ignore */ }
        offOwnTime = undefined;
        try {
            if (typeof offR4 === 'function')
                offR4();
        }
        catch { /* ignore */ }
        try {
            if (typeof offReviewEvent === 'function')
                offReviewEvent();
        }
        catch { /* ignore */ }
        try {
            r4?.stop();
        }
        catch { /* ignore */ }
    };
    let effectRegistered = false;
    try {
        if (typeof ctx.effect === 'function') {
            ctx.effect(() => cleanup);
            effectRegistered = true;
        }
    }
    catch {
        effectRegistered = false;
    }
    if (!effectRegistered) {
        // 降级：宿主没有 effect（或抛错）时，至少把清理函数挂到能拿到的卸载钩子上。
        // 常见可用的：ctx.on('dispose') / ctx.on('app/unload')；拿不到也绝不抛错。
        let hooked = false;
        for (const evt of ['dispose', 'app/unload', 'fiber/dispose']) {
            try {
                const maybe = ctx.on?.(evt, () => { try {
                    cleanup();
                }
                catch { /* ignore */ } });
                if (typeof maybe === 'function')
                    hooked = true;
            }
            catch { /* 事件不存在就继续试下一个 */ }
        }
        if (!hooked) {
            // 完全没有任何卸载钩子：把这些清理动作登记到模块级（best effort），
            // 并用 unref 定时器兜底 —— 进程退出时 Node 会跑 process 上的 exit 监听。
            try {
                process.once('exit', () => { try {
                    cleanup();
                }
                catch { /* ignore */ } });
            }
            catch { /* ignore */ }
        }
        logger.warn?.('[anti-ai-persona] 宿主未提供 ctx.effect，已降级为手动回收（timer/监听照常清理）');
    }
}
export default { name, inject, Config, apply };
