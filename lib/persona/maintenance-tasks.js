/**
 * maintenance-tasks — 后台维护任务（从 `index.ts` 拆出，重构任务 B5）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 合并了四块**同一性质**的东西（"按时/按需跑的后台维护"）：
 *   ① guideline 刷新（`refreshGroup` / `refreshAll`）—— 原先 60 分钟一次
 *   ② 复盘执行（`pruneBuffersSafely` / `runReview` / `scheduleNextReview`）—— 每天 04:00
 *   ③ 任务中心登记（`tcRegister` / `tcDriving` + A1/A2）—— 阶段 5 做的节律外置
 *   ④ 提取启动补偿（`runExtractionNow` + `compensateTimer`）—— 重启后补跑漏掉的提取
 *
 * 为什么合并：它们都是"后台维护"，未来加第 5 个后台任务时有明确落点。
 *
 * 🔴 红线 R4（主人明确要求）：
 *   **③ 任务中心登记那段是阶段 5 刚改好的，必须原样搬运，不做任何"顺手优化"。**
 *   尤其 `a1Registered` / `a2Registered` 的降级分支（任务中心不可用 → 退回自排定时器）
 *   和 `tcDriving()` 的语义（只有 live 模式才叫"真接管"），一个字都不能改 ——
 *   改错会导致插件自排定时器与引擎同时跑（节律重复）。
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 🔵 依赖注入（本文件不 import index.ts / r4/index.js，防循环）：
 *   R4 的 `runExtractionOnce` 由 index 传进来（`getExtractionRunner`）。
 */
import { resolveDataRoot } from '../shared/paths.js';
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { analyzeMessages, collectGroupMessages } from './analyzer.js';
import { buildReviewPrompt, callReviewLLM, pruneReviewBuffers, readRecentChatTexts, readReviewRecords, resolveReviewRoute, saveReviewOverlay, } from './review.js';
import { writeGuidelineSync } from './store.js';
import { readExtractionState } from './r4/state.js';
import { personaDataRoot } from './r4/paths.js';
import { dayKeyOf, listHistorySessions } from './r4/sample.js';
import { resolveTimeZone, zonedTime } from './r4/time.js';
// 重构阶段 2：生活流已拆到 tasks/life-stream.ts；共享辅助在 tasks/shared.ts
import { OPEN_OUTBOX_DIR, recentChatOf as sharedRecentChatOf, qqbotRootOf } from './tasks/shared.js';
import { createLifeStreamTask, LIFE_STREAM_TICK_MS as LIFE_STREAM_TICK_MS } from './tasks/life-stream.js';
// 记忆联想 · 第二层「主动惦记」（2026-11-08 新增）
import { buildCallbackPrompt, clampMemoryCallbackConfig, detectCandidates, detectLevelJumps, markCallback, pickCallback, recordLevels, resetIfNewDay as resetCallbackIfNewDay, } from './r4/memory-recall/callback.js';
import { readCallbackState, writeCallbackState } from './r4/memory-recall/callback-state.js';
export function createMaintenanceTasks(deps) {
    const { config, qqbotDataRoot } = deps;
    const logger = deps.logger ?? {};
    const llm = deps.llm;
    // ── ④ guideline 刷新 ────────────────────────────────────────────────
    const inflightGroups = new Set();
    let allRunning = false;
    const refreshGroup = async (groupId) => {
        if (allRunning || inflightGroups.has(groupId))
            return;
        inflightGroups.add(groupId);
        try {
            const collected = await collectGroupMessages(qqbotDataRoot, deps.config.analysisMaxHistoryDays ?? 7, { onlyGroupId: groupId });
            const group = collected.groups.find((g) => g.groupId === groupId);
            if (!group || group.messages.length === 0) {
                logger.warn?.(`[anti-ai-persona] 群 ${groupId} 暂时没有合格语料，保留旧 guideline`);
                return;
            }
            const result = analyzeMessages(group.messages);
            if (!result.guideline)
                return;
            writeGuidelineSync(groupId, result.guideline);
            logger.info?.(`[anti-ai-persona] 已更新群 ${groupId} guideline：${result.count} 条消息 / ${collected.scannedFiles} 个文件`);
        }
        catch (error) {
            logger.warn?.(`[anti-ai-persona] 群 ${groupId} 分析失败（已忽略）：${error instanceof Error ? error.message : String(error)}`);
        }
        finally {
            inflightGroups.delete(groupId);
        }
    };
    const refreshAll = async () => {
        if (allRunning)
            return;
        allRunning = true;
        try {
            const collected = await collectGroupMessages(qqbotDataRoot, deps.config.analysisMaxHistoryDays ?? 7);
            if (collected.groups.length === 0) {
                logger.warn?.(`[anti-ai-persona] 未找到可用群聊记录；请检查 qqbotDataRoot=${qqbotDataRoot}，扫描目录=${collected.roots.join(', ') || '(无)'}`);
                return;
            }
            let updated = 0;
            for (const group of collected.groups) {
                try {
                    const result = analyzeMessages(group.messages);
                    if (!result.guideline)
                        continue;
                    writeGuidelineSync(group.groupId, result.guideline);
                    updated += 1;
                    logger.info?.(`[anti-ai-persona] 已更新群 ${group.groupId} guideline：${result.count} 条消息`);
                }
                catch (error) {
                    logger.warn?.(`[anti-ai-persona] 群 ${group.groupId} 分析失败（已忽略）：${error instanceof Error ? error.message : String(error)}`);
                }
            }
            logger.info?.(`[anti-ai-persona] 本轮更新 ${updated}/${collected.groups.length} 个群 / ${collected.scannedFiles} 个文件`);
        }
        catch (error) {
            logger.warn?.(`[anti-ai-persona] 分析失败（已忽略）：${error instanceof Error ? error.message : String(error)}`);
        }
        finally {
            allRunning = false;
        }
    };
    // ── ⑫ 复盘执行 ──────────────────────────────────────────────────────
    /**
     * 错题本裁剪：只保留最近 72h。**独立于复盘是否执行**——旧实现放在 runReview 成功路径末尾，
     * 一旦「过去 24h 没有语料」就 early return，过期记录永远不会被裁（实测 5 条 >72h 一直留着）。
     */
    const pruneBuffersSafely = () => {
        try {
            const pruned = pruneReviewBuffers();
            const total = pruned.reduce((n, r) => n + r.removed, 0);
            if (total > 0)
                logger.info?.(`[anti-ai-persona] 错题本已裁剪：移除 ${total} 条过期记录`);
        }
        catch (error) {
            logger.warn?.(`[anti-ai-persona] 错题本裁剪失败（已忽略）：${error instanceof Error ? error.message : String(error)}`);
        }
    };
    const runReview = async () => {
        if (!config.reviewEnabled)
            return;
        pruneBuffersSafely();
        const records = readReviewRecords(24 * 60 * 60 * 1000);
        if (records.length === 0) {
            logger.info?.('[anti-ai-persona] 复盘：过去 24h 没有纠偏语料，跳过');
            return;
        }
        const route = await resolveReviewRoute(llm, config.reviewProvider, config.reviewModel);
        if (!route) {
            logger.warn?.('[anti-ai-persona] 复盘：未找到闪/轻量模型，跳过（可配置 reviewProvider/reviewModel）');
            return;
        }
        // 按「群 + 人格」分组；旧记录没有 persona 时落到 default，避免污染新人格。
        const buckets = new Map();
        for (const record of records) {
            const groupId = record.groupId || 'global';
            const persona = record.persona || 'default';
            const key = `${groupId}\u0000${persona}`;
            const bucket = buckets.get(key) ?? { groupId, persona, records: [] };
            bucket.records.push(record);
            buckets.set(key, bucket);
        }
        const chatTexts = await readRecentChatTexts(qqbotDataRoot, 30);
        for (const bucket of buckets.values()) {
            const prompt = buildReviewPrompt(bucket.records, chatTexts);
            try {
                const output = await callReviewLLM(llm, route, prompt);
                const saved = saveReviewOverlay(output, bucket.groupId, bucket.persona);
                if (saved.length === 0) {
                    logger.warn?.(`[anti-ai-persona] 复盘：${bucket.groupId}/${bucket.persona} 没有有效规则，跳过`);
                    continue;
                }
                logger.info?.(`[anti-ai-persona] 复盘完成：${bucket.groupId}/${bucket.persona} ← ${bucket.records.length} 条纠偏语料`);
            }
            catch (error) {
                logger.warn?.(`[anti-ai-persona] 复盘失败：${bucket.groupId}/${bucket.persona}: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
    };
    let reviewTimer;
    const scheduleNextReview = () => {
        if (!config.reviewEnabled)
            return;
        const now = new Date();
        const next = new Date(now);
        next.setHours(config.reviewHour, 0, 0, 0);
        if (next.getTime() <= now.getTime())
            next.setDate(next.getDate() + 1);
        reviewTimer = setTimeout(() => {
            void (async () => {
                try {
                    await runReview();
                }
                catch (error) {
                    logger.warn?.(`[anti-ai-persona] 复盘失败（已忽略）：${error instanceof Error ? error.message : String(error)}`);
                }
                finally {
                    scheduleNextReview();
                }
            })();
        }, Math.max(1000, next.getTime() - now.getTime()));
        reviewTimer.unref?.();
    };
    // ── ⑮ 任务中心登记（🔴 红线 R4：阶段 5 代码原样搬运，不许优化）────────
    let timer;
    /** 已登记的任务键（供「引擎是否真执行过」判断用）。 */
    const registeredKeys = [];
    /** 诊断落盘（persona 的 logger 不进 engine.log，排查必须自己写文件）。 */
    const diag = (event, data) => {
        try {
            const dir = resolveDataRoot();
            mkdirSync(dir, { recursive: true });
            appendFileSync(join(dir, 'task-registry-diag.log'), JSON.stringify({ at: new Date().toISOString(), event, ...data }) + '\n', 'utf8');
        }
        catch { /* ignore */ }
    };
    const tcRegister = (runKey, fn) => {
        try {
            const g = globalThis;
            const key = Symbol.for('dsh.taskcenter.registry.v1');
            if (!g[key] || typeof g[key] !== 'object')
                g[key] = new Map();
            const reg = g[key];
            if (reg.has(runKey))
                return true; // 幂等复用（网关重建会重跑 apply）
            reg.set(runKey, { fn, meta: { id: `plugin-${runKey}`, owner: 'plugin' } });
            if (!registeredKeys.includes(runKey))
                registeredKeys.push(runKey);
            return true;
        }
        catch {
            return false;
        }
    };
    const tcDriving = () => {
        try {
            const engine = globalThis[Symbol.for('dsh.taskcenter.engine.v1')];
            return Boolean(engine && engine.alive && !engine.disposed && engine.mode === 'live');
        }
        catch {
            return false;
        }
    };
    /**
     * 引擎恢复监听（2026-11-06 新增，配合 P1-1 修复）
     *
     * 背景：`tcRegister` 只把执行器塞进全局 Map，**不代表引擎真的在跑**。
     *   引擎可能是 shadow 模式（只判定不执行，见 zz-central-scheduler）→ 任务永远不触发。
     *   所以判据必须是「登记成功 **且** tcDriving()」。
     *
     * 但收紧条件会带来新问题：引擎若「先 shadow 后 live」或「掉线后恢复」，
     *   我们已经排了自带定时器 → 会与引擎任务**双跑**。
     *   解决：排降级定时器后，每 10 秒探一次；一旦引擎变 live，就**清掉降级定时器**，
     *   交给任务中心独占（保证任意时刻只有一个执行者）。
     */
    const DRIVING_POLL_MS = 10_000;
    let drivingPoll;
    /** 已排的降级定时器（引擎转 live 后要清掉）。 */
    const fallbackTimers = [];
    /** 启动降级执行，并把它的清除函数登记进 fallbackTimers。 */
    const startFallback = (label, step, everyMs, once = false) => {
        if (once) {
            const t = setTimeout(() => { try {
                step();
            }
            catch { /* ignore */ } }, everyMs ?? 0);
            t.unref?.();
            fallbackTimers.push({ stop: () => clearTimeout(t) });
            return;
        }
        const t = setInterval(() => { try {
            step();
        }
        catch { /* ignore */ } }, everyMs ?? 60_000);
        t.unref?.();
        fallbackTimers.push({ stop: () => clearInterval(t) });
        logger.warn?.(`[anti-ai-persona] ${label}降级为自带定时器（任务中心未 live）`);
    };
    /** 清掉所有降级定时器（引擎接管后调）。 */
    const stopFallbacks = () => {
        while (fallbackTimers.length) {
            const f = fallbackTimers.pop();
            try {
                f?.stop();
            }
            catch { /* ignore */ }
        }
    };
    /** 开始轮询：引擎一旦变 live，清掉降级器（避免与任务中心双跑）。 */
    const watchDriving = () => {
        if (drivingPoll)
            return;
        drivingPoll = setInterval(() => {
            try {
                if (!tcDriving())
                    return;
                // 🔴 关键：引擎 live ≠ 引擎会跑我们的任务（实测 journal 里 plugin 任务 0 条）。
                //   必须确认它**至少执行过一次**才停降级器，否则会真空。
                const executed = registeredKeys.some((k) => engineHasRunTask(k));
                if (!executed) {
                    diag('watchDriving', { driving: true, executed: false, note: '引擎 live 但没跑过我们的任务 → 保留降级器' });
                    return;
                }
                stopFallbacks();
                clearInterval(drivingPoll);
                drivingPoll = undefined;
                diag('watchDriving', { driving: true, executed: true, note: '引擎已真执行 → 停降级器' });
                logger.info?.('[anti-ai-persona] 任务中心已真接管（执行过）→ 停用降级定时器');
            }
            catch { /* ignore */ }
        }, DRIVING_POLL_MS);
        drivingPoll.unref?.();
    };
    /**
     * 引擎是否**真的执行过**我们登记的任务（2026-11-06 关键修正）。
     *
     * 🔴 为什么不能只看 `tcDriving()`：
     *   实测发现引擎虽然 `mode === 'live'`、也认领了 13 个任务，
     *   但 `state/journal/` 里 **persona 的 4 个 plugin 任务 0 条执行记录**
     *   （对照 ext 任务有 301 条）。也就是说「引擎 live」≠「引擎会跑我们的任务」。
     *
     *   如果只凭 live 就停降级器 → 降级停了、引擎又不执行 → **任务彻底真空**。
     *   所以停降级器的前提必须是：引擎**已经实际执行过**至少一次我们登记的任务。
     *
     * 判据：读 `{任务中心}/state/last-run.json` 的 `tasks[runKey]` 是否存在。
     *   不存在 = 引擎从没跑过它 → 降级器必须留着（宁可与引擎偶发双跑，也不能真空）。
     */
    const engineHasRunTask = (runKey, taskCenterDir) => {
        try {
            // 引擎对象上带 `dir`（zz-central-scheduler 的 engine.dir = 任务中心目录）
            const dir = taskCenterDir
                || String(globalThis[Symbol.for('dsh.taskcenter.engine.v1')]?.dir || '');
            if (!dir)
                return false;
            const f = join(dir, 'state', 'last-run.json');
            const j = JSON.parse(readFileSync(f, 'utf8'));
            // ⚠️ 引擎记录的键是**带前缀**的：`plugin-guideline-refresh` 而不是 `guideline-refresh`
            //    （引擎用 meta.id = `plugin-${runKey}`）。两种写法都试，避免踩这个坑。
            const rec = j?.tasks?.[runKey] ?? j?.tasks?.[`plugin-${runKey}`];
            return Boolean(rec && typeof rec.atMs === 'number');
        }
        catch {
            return false;
        }
    };
    // ── ⑰ 碎片生活流：主动开口（2026-11-07 新增）───────────────────────
    /**
     * 跑一轮「要不要主动开口」的判定与生成。
     *
     * 设计要点（对应 `维护/碎片生活流-细节实施方案-20261107.md`）：
     *   · **判定全在本地**（8 道闸门，纯计算 <1ms）→ 只有 go 时才调 LLM
     *   · **一天 ≤3 次**（硬上限），间隔 ≥90 分钟
     *   · **先写状态再发送**（幂等，防重复）
     *   · 任何异常都吞掉，绝不拖垮主链
     *
     * ⚠️ 数据落点：`{PERSONA_DATA_ROOT}/state/life-stream.json`（**不碰原生目录**）
     * ⚠️ 发送：写 `state/heartbeat-outbox/`，由扩展包桥（r4-heartbeat-bridge）消费，
     *    与现有心跳**同一条通道**，不新增任何发送机制。
     */
    // ══════════ ★ 2026-11-08 记忆联想 · 第二层「主动惦记」══════════════════
    //
    //  与生活流的区别：
    //    · 生活流 = 「我今天在干嘛」（素材来自生活事件库，人人一样）
    //    · 惦记   = 「我想起你」（素材来自**这个人**的生日/互动史/关系等级）
    //
    //  三条判据全部本地可算，**不调模型**；只有决定开口才写 outbox（桥再调模型生成台词）。
    //  频率：每天 ≤1 次 + 10:00-21:00 + 两次间隔 ≥4h + 单人 14 天冷却。
    const MEMORY_CALLBACK_TICK_MS = 30 * 60 * 1000; // 30 分钟判定一次
    const MEMORY_CALLBACK_LOG = 'memory-callback.log';
    const CALLBACK_OUTBOX_KIND = 'memory-callback';
    const memoryCallbackDiag = (event, data) => {
        try {
            const dir = resolveDataRoot();
            mkdirSync(dir, { recursive: true });
            const file = join(dir, MEMORY_CALLBACK_LOG);
            try {
                if (statSync(file).size > 256 * 1024) {
                    try {
                        renameSync(file, `${file}.1`);
                    }
                    catch { /* ignore */ }
                }
            }
            catch { /* 文件不存在 → 不轮转 */ }
            appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), event, ...data }) + '\n', 'utf8');
        }
        catch { /* ignore */ }
    };
    /** 读第二层配置（从 deps.config，缺省走 MEMORY_CALLBACK_DEFAULTS）。 */
    const memoryCallbackConfigOf = () => {
        const raw = config ?? {};
        return clampMemoryCallbackConfig({
            enabled: raw.memoryCallbackEnabled,
            dailyMax: raw.memoryCallbackDailyMax,
            minGapDays: raw.memoryCallbackMinGapDays,
            hoursFrom: raw.memoryCallbackHoursFrom,
            hoursTo: raw.memoryCallbackHoursTo,
            minMessages: raw.memoryCallbackMinMessages,
            ownBirthday: raw.memoryCallbackOwnBirthday,
        });
    };
    /**
     * 当前人格名（用于识别「生日档案里记的是 bot 自己」）。
     * 读不到 → 空串（此时按普通群友处理，不会误判）。
     */
    const callbackPersonaName = () => {
        try {
            const cfgPath = join(personaDataRoot(), 'persona-configs', 'elysia.json');
            const raw = JSON.parse(readFileSync(cfgPath, 'utf8'));
            return typeof raw?.name === 'string' ? raw.name.trim() : '';
        }
        catch {
            return '';
        }
    };
    /** 读某群的关系快照（`state/relationships/<gid>.json`）。失败 → 空数组。 */
    const readRelationshipsOf = (groupId) => {
        try {
            const file = join(personaDataRoot(), 'state', 'relationships', `${groupId}.json`);
            const raw = JSON.parse(readFileSync(file, 'utf8'));
            if (!raw || typeof raw !== 'object')
                return [];
            const out = [];
            for (const [userId, value] of Object.entries(raw)) {
                if (!userId || !value || typeof value !== 'object')
                    continue;
                const v = value;
                out.push({
                    userId,
                    level: typeof v.level === 'string' ? v.level : undefined,
                    updatedAt: Number.isFinite(Number(v.updatedAt)) ? Number(v.updatedAt) : 0,
                    messageCount: Number.isFinite(Number(v.messageCount)) ? Number(v.messageCount) : 0,
                });
            }
            return out;
        }
        catch {
            return [];
        }
    };
    /** 写一条「惦记」outbox（桥会消费并生成台词）。 */
    const enqueueCallbackOutbox = (groupId, prompt, at) => {
        try {
            const dir = join(personaDataRoot(), 'state', OPEN_OUTBOX_DIR);
            mkdirSync(dir, { recursive: true });
            const id = `mc-${at}-${Math.random().toString(36).slice(2, 8)}`;
            const payload = { id, groupId, text: prompt, wakePrompt: prompt, at, kind: CALLBACK_OUTBOX_KIND };
            const file = join(dir, `${id}.json`);
            const tmp = `${file}.tmp`;
            writeFileSync(tmp, JSON.stringify(payload), 'utf8');
            renameSync(tmp, file);
            return true;
        }
        catch (err) {
            memoryCallbackDiag('send:write-fail', { err: String(err) });
            return false;
        }
    };
    /**
     * 会话列表里的**全部**群 id（去重）。
     *
     * ★ 2026-11-08：第二层「惦记」必须逐群判定 —— 生日/关系都是按群隔离的数据。
     */
    const candidateGroupsOf = () => {
        try {
            const sessions = listHistorySessions(qqbotRootOf(qqbotDataRoot), logger);
            const set = new Set();
            for (const s of sessions ?? []) {
                if (s?.scope !== 'group' || !s.peerId)
                    continue;
                const id = String(s.peerId).trim();
                if (id)
                    set.add(id);
            }
            return [...set];
        }
        catch {
            return [];
        }
    };
    /** 跑一次「主动惦记」判定（tick / 手动测试同一入口）。 */
    const runMemoryCallback = async () => {
        try {
            const cfg = memoryCallbackConfigOf();
            if (!cfg.enabled) {
                memoryCallbackDiag('tick', { decision: 'disabled' });
                return;
            }
            const now = Date.now();
            const tz = resolveTimeZone(config?.timeZone);
            const zt = zonedTime(now, tz);
            const today = { year: Number(zt.date.slice(0, 4)), month: Number(zt.date.slice(5, 7)), day: Number(zt.date.slice(8, 10)) };
            const dateKey = zt.date;
            const root = personaDataRoot();
            const inWindow = cfg.hoursFrom <= cfg.hoursTo
                ? zt.hour >= cfg.hoursFrom && zt.hour < cfg.hoursTo
                : (zt.hour >= cfg.hoursFrom || zt.hour < cfg.hoursTo);
            if (!inWindow) {
                memoryCallbackDiag('tick', { decision: 'hour', hour: zt.hour });
                return;
            }
            const state0 = resetCallbackIfNewDay(readCallbackState(root, logger), dateKey);
            if (state0.todayCount >= cfg.dailyMax) {
                memoryCallbackDiag('tick', { decision: 'quota', todayCount: state0.todayCount });
                return;
            }
            /**
             * ★ 2026-11-08：**逐群**判定（不再只取第一个群）。
             *
             * 为什么必须逐群：生日档案是**按群隔离**的（实测主群 21 条生日、
             * 另一个群 0 条），只取会话列表第一个群会让生日判据永远空转 ——
             * 这类「编译通过、启动正常、永远不发」的静默失败正是三轮审查反复抓到的坑。
             *
             * 频率口径：`dailyMax` 是**全局**上限，跨群共享；命中第一个群就停。
             */
            const groups = candidateGroupsOf();
            if (!groups.length) {
                memoryCallbackDiag('tick', { decision: 'no-group' });
                return;
            }
            // 人设名只读一次（用于「自己的生日不归本层」判定 + 自生日 prompt 文案）
            const selfName = callbackPersonaName();
            let state = state0;
            const tried = [];
            let fired = false;
            for (const groupId of groups) {
                try {
                    const relationships = readRelationshipsOf(groupId);
                    const birthdays = deps.memory ? deps.memory.birthdays(groupId) : [];
                    const nameOf = (uid) => (deps.memory ? deps.memory.personName(groupId, uid) : '');
                    const candidates = [
                        ...detectCandidates({
                            groupId, relationships, birthdays, nameOf, today, now, config: cfg,
                            // 决策 A：自己的生日不归本层（除非配置显式打开）
                            selfName,
                        }),
                        ...detectLevelJumps({ groupId, relationships, levels: state.levels, nameOf }),
                    ].sort((a, b) => a.priority - b.priority);
                    const decision = pickCallback({ groupId, candidates, state, now, hour: zt.hour, config: cfg });
                    // 等级基线每轮刷新（跳级判定发生在上面；这里只更新基线）
                    state = recordLevels(state, { groupId, relationships });
                    if (!decision.ok || !decision.candidate) {
                        tried.push({
                            gid: groupId.slice(-6),
                            decision: decision.reason,
                            candidates: candidates.length,
                        });
                        continue;
                    }
                    const candidate = decision.candidate;
                    const timeText = `${dateKey.slice(5)} ${String(zt.hour).padStart(2, '0')}:${String(zt.minute).padStart(2, '0')}`;
                    const prompt = buildCallbackPrompt({
                        candidate,
                        recentChat: sharedRecentChatOf({ qqbotDataRoot, logger }, groupId, 5, now),
                        timeText,
                        selfName,
                    });
                    if (!prompt) {
                        memoryCallbackDiag('gen:skip', { reason: 'empty-prompt', kind: candidate.kind });
                        continue;
                    }
                    // ⚠️ 先写状态（写失败就不发，防重复）——与生活流同一纪律
                    const next = markCallback(state, { groupId, candidate, now });
                    if (!writeCallbackState(next, root, logger)) {
                        memoryCallbackDiag('skip:write-fail', { kind: candidate.kind });
                        continue;
                    }
                    state = next;
                    const okSend = enqueueCallbackOutbox(groupId, prompt, now);
                    memoryCallbackDiag(okSend ? 'send:ok' : 'send:fail', {
                        kind: candidate.kind,
                        name: candidate.name,
                        reason: candidate.reason,
                        todayCount: next.todayCount,
                    });
                    fired = true;
                    break;
                }
                catch (err) {
                    // 单群异常不影响其它群
                    tried.push({ gid: groupId.slice(-6), decision: 'error', candidates: 0 });
                    memoryCallbackDiag('group:fail', { gid: groupId.slice(-6), err: String(err) });
                }
            }
            // 等级基线/跨天重置落盘：即使没开口也更新（否则跳级永远发现不了）
            if (!fired && JSON.stringify(state) !== JSON.stringify(state0)) {
                writeCallbackState(state, root, logger);
            }
            if (!fired)
                memoryCallbackDiag('tick', { decision: 'no-candidate', groups: groups.length, tried });
        }
        catch (err) {
            memoryCallbackDiag('fail', { err: String(err) });
            logger.warn?.(`[anti-ai-persona] 主动惦记异常（已静默降级）：${err}`);
        }
    };
    // 重构阶段 2：生活流拆到独立模块（tasks/life-stream.ts）
    const lifeStreamTask = createLifeStreamTask({ config: config, qqbotDataRoot, logger });
    const runLifeStream = () => lifeStreamTask.run();
    const registerTaskCenterTasks = () => {
        // A1：guideline 全量重扫。原来 60 分钟一次。
        const a1Registered = tcRegister('guideline-refresh', () => refreshAll());
        void refreshAll(); // 启动即跑一次（保持原行为）
        // 🔴 P1-1 修复：必须「登记成功 且 引擎 live 真接管」才不降级
        if (a1Registered && tcDriving()) {
            logger.info?.('[anti-ai-persona] guideline 刷新已登记到任务中心（引擎 live 接管）');
        }
        else {
            startFallback('guideline 刷新', () => { void refreshAll(); }, config.analysisIntervalMin * 60_000);
            watchDriving();
        }
        // A2：每日复盘。原来排到下一个 reviewHour（04:00）。
        const a2Registered = tcRegister('daily-review', () => runReview());
        if (a2Registered && tcDriving()) {
            logger.info?.('[anti-ai-persona] 每日复盘已登记到任务中心（引擎 live 接管）');
        }
        else {
            scheduleNextReview();
            logger.warn?.('[anti-ai-persona] 每日复盘降级为自带定时器（任务中心未 live）');
            watchDriving();
        }
        // A3：碎片生活流（2026-11-07 新增）。
        // 解决「96% 被动回应、仅 4% 主动开口」：让她不定时说一句自己的生活小事。
        // ⚠️ 生活流**接管**了原心跳的「冷场救援」职能（heartbeat-gen 里已删除该选项），
        //    两者并存会一天冒泡 5-6 次。
        // ⚠️ 判定全在本地（8 道闸门），**只有决定说话才调 LLM**，一天 ≤3 次。
        const a3Registered = tcRegister('life-stream', () => runLifeStream());
        if (a3Registered && tcDriving()) {
            logger.info?.('[anti-ai-persona] 生活流已登记到任务中心（引擎 live 接管）');
        }
        else {
            // ⚠️ 降级日志由 startFallback 内部统一输出（它会打「生活流降级为自带定时器」）。
            //    这里**不要**再手写一条 —— 否则同一件事会重复两次（2026-11-07 实测发现）。
            startFallback('生活流', () => { void runLifeStream(); }, LIFE_STREAM_TICK_MS);
            watchDriving();
        }
        // A4：记忆联想·第二层「主动惦记」（2026-11-08 新增）。
        // 生日临近 / 老友久未出现 / 关系跳级 → 主动提一句（每天 ≤1 次）。
        const a4Registered = tcRegister('memory-callback', () => runMemoryCallback());
        if (a4Registered && tcDriving()) {
            logger.info?.('[anti-ai-persona] 主动惦记已登记到任务中心（引擎 live 接管）');
        }
        else {
            startFallback('主动惦记', () => { void runMemoryCallback(); }, MEMORY_CALLBACK_TICK_MS);
            watchDriving();
        }
    };
    // ── ⑯ 提取启动补偿 ──────────────────────────────────────────────────
    /**
     * ══════════ ★ 2026-11-04 提取时间的补漏入口 ══════════
     *
     * 病因（实测）：`elysia/profiles/`、`state/profile-events/`、`state/extraction-state.json`
     * **三个都不存在** → 画像提取从上线至今**一次都没跑过**。
     *
     * 根因不是 bug，是**时间窗太窄**：提取用 `setTimeout` 排到「下一个 run_daily_at（03:00）」，
     * 必须 DSH 在凌晨 3 点**正在运行**才触发。用户白天用、晚上关，就永远跨不过去。
     *
     * 解决办法：**启动补偿** —— 进程起来时若「今天还没提取过」，延迟一小段
     * （等宿主/QQBot 就绪）补跑一次。判据是 `lastRunDate !== 今天`，
     * 所以**一天最多补跑一次**，不会每次重启都刷。
     */
    const COMPENSATE_DELAY_MS = 60_000;
    let compensateTimer;
    /**
     * 跑一次提取并返回**给人看的摘要**（供启动补偿写日志用）。
     */
    const runExtractionNow = async (runExtraction) => {
        try {
            const report = await runExtraction();
            const date = String(report?.date ?? '');
            if (report?.skipped)
                return `今天（${date}）已经提取过了，无需重复。`;
            const groups = Number(report?.groups ?? 0);
            const failed = report?.failed === true;
            const notes = Array.isArray(report?.notes) ? report.notes.slice(0, 8).join('；') : '';
            return [
                `提取完成（${date}）：${groups} 个群${failed ? '，但整体异常' : ''}`,
                notes ? `明细：${notes}` : '',
            ].filter(Boolean).join('\n');
        }
        catch (error) {
            return `提取失败：${error instanceof Error ? error.message : String(error)}`;
        }
    };
    /**
     * 挂载启动补偿：`lastRunDate` 落后于今天 → 延迟 60 秒补跑一次。
     *
     * 为什么延迟：`apply` 时宿主/QQBot 的 msg-history 可能还没扫好，
     * 立刻跑会拿到「0 个群 / 无语料」。给 60 秒缓冲（`unref` 不阻止退出）。
     */
    const mountStartupCompensation = (runExtraction) => {
        try {
            // 时区：AppConfig 没有 timezone 字段（那是 R4 的 ElysiaConfig），
            // 这里与 R4 内部的默认口径一致（resolveTimeZone 对非法值会回退并告警一次）。
            const today = dayKeyOf(Date.now(), resolveTimeZone('Asia/Shanghai'));
            const lastRun = readExtractionState(personaDataRoot()).lastRunDate;
            if (lastRun !== today) {
                compensateTimer = setTimeout(() => {
                    void (async () => {
                        try {
                            const msg = await runExtractionNow(runExtraction);
                            logger.info?.(`[anti-ai-persona] 启动补偿提取：${msg}`);
                        }
                        catch { /* 补偿失败不影响主聊天 */ }
                    })();
                }, COMPENSATE_DELAY_MS);
                compensateTimer.unref?.();
                logger.info?.(`[anti-ai-persona] 提取补偿已排程（上次=${lastRun || '从未'}，今天=${today}，${COMPENSATE_DELAY_MS / 1000}s 后跑）`);
                return `scheduled(lastRun=${lastRun || 'never'})`;
            }
            return 'skip(already-ran-today)';
        }
        catch {
            return 'error(ignored)';
        }
    };
    return {
        refreshGroup,
        refreshAll,
        pruneBuffersSafely,
        runReview,
        scheduleNextReview,
        registerTaskCenterTasks,
        mountStartupCompensation,
        refreshOne: refreshGroup,
        runLifeStreamNow: () => runLifeStream(),
        runMemoryCallbackNow: () => runMemoryCallback(),
        dispose: () => {
            // 🔴 红线 R5：定时器只在本文件内持有，这里统一清理
            try {
                if (reviewTimer)
                    clearTimeout(reviewTimer);
            }
            catch { /* ignore */ }
            try {
                if (timer)
                    clearInterval(timer);
            }
            catch { /* ignore */ }
            try {
                if (compensateTimer)
                    clearTimeout(compensateTimer);
            }
            catch { /* ignore */ }
            // P1-1 新增：降级定时器集合 + 引擎状态轮询器也要清（否则热重载会叠加）
            try {
                stopFallbacks();
            }
            catch { /* ignore */ }
            try {
                if (drivingPoll)
                    clearInterval(drivingPoll);
            }
            catch { /* ignore */ }
            reviewTimer = undefined;
            timer = undefined;
            compensateTimer = undefined;
            drivingPoll = undefined;
        },
    };
}
