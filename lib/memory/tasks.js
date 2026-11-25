/**
 * 任务中心登记 —— 用现成的任务中心引擎，不搬引擎
 *
 * 为什么只登记不搬家（方案 D7）：
 *   引擎跑 8 个 `owner=ext` 任务的执行器，那些执行器 import 自扩展包；
 *   插件从 node_modules 够不到扩展包 ⇒ 搬引擎会断。
 *   而注册表是**进程级全局 Map**，任何插件都能往里登记 —— 这就是"体验上合并"。
 *
 * 契约来源：dsh-anti-ai-persona/src/maintenance-tasks.ts:224（已在线上跑很久）。
 */
import { resolveMemoryRoot } from '../shared/paths.js';
import { appendFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
// 2026-11-08：人物卡格式体检（防「缺 openid / 缺 Current」导致记忆联想静默失效）
import { auditMemoryCards } from './card-audit.js';
// 2026-11-09：自动建档（群卡/人物卡骨架）—— 修「画像自动、卡片全手动」的结构性缺口
import { runAutoCards } from './auto-card.js';
import { runDistill } from './distill.js';
/** 人物卡体检诊断文件（与维护任务同目录）。 */
const CARD_AUDIT_LOG = 'card-audit.log';
/** 自动建档诊断文件。 */
const AUTO_CARD_LOG = 'auto-card.log';
const REGISTRY_SYMBOL = 'dsh.taskcenter.registry.v1';
const ENGINE_SYMBOL = 'dsh.taskcenter.engine.v1';
/** 把任务登记进全局注册表（幂等：重复登记不覆盖已有的）。 */
function tcRegister(runKey, fn) {
    try {
        const g = globalThis;
        const key = Symbol.for(REGISTRY_SYMBOL);
        if (!g[key] || typeof g[key] !== 'object')
            g[key] = new Map();
        const reg = g[key];
        if (reg.has(runKey))
            return true; // 幂等复用（插件重载会重跑 apply）
        reg.set(runKey, { fn, meta: { id: `plugin-${runKey}`, owner: 'plugin' } });
        return true;
    }
    catch {
        return false;
    }
}
/** 引擎是否在 live 模式（决定要不要降级为自带定时器）。 */
function tcDriving() {
    try {
        const engine = globalThis[Symbol.for(ENGINE_SYMBOL)];
        return Boolean(engine && engine.alive && !engine.disposed && engine.mode === 'live');
    }
    catch {
        return false;
    }
}
/**
 * 人物卡问题告警（log + 诊断文件）。
 *
 * ⚠️ 只告警**不修数据**：记忆内容是主人的，自动改写风险大于收益。
 * 诊断落 `<DSH_HOME>/data/dsh-qq-memory/card-audit.log`（超 256KB 轮转到 .1）。
 */
function reportCardIssues(issues, scanned, logger) {
    const lines = issues.map((i) => {
        const what = i.missing.map((m) => (m === 'openid' ? '缺openid' : '缺Current段')).join('+');
        return `${i.groupId.slice(-6)}/${i.path} — ${what}`;
    });
    // ① 日志：只列前 5 条，避免刷屏
    const head = lines.slice(0, 5).join('；');
    const more = lines.length > 5 ? `；…另有 ${lines.length - 5} 项` : '';
    logger?.warn?.(`[bnnbotbox] 人物卡体检发现 ${issues.length}/${scanned} 张不合格（记忆联想会对这些人生效不了）：${head}${more}`);
    // ② 诊断文件：完整清单，便于事后核对
    try {
        const dir = resolveMemoryRoot();
        mkdirSync(dir, { recursive: true });
        const file = join(dir, CARD_AUDIT_LOG);
        try {
            if (statSync(file).size > 256 * 1024) {
                try {
                    renameSync(file, `${file}.1`);
                }
                catch { /* ignore */ }
            }
        }
        catch { /* 文件不存在 → 不轮转 */ }
        appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), scanned, issues: lines }) + '\n', 'utf8');
    }
    catch { /* 诊断失败绝不影响主流程 */ }
}
/**
 * 自动建档诊断（log + 诊断文件）。
 *
 * ⚠️ 与人物卡体检不同：这里**会写数据**（新建骨架卡），所以诊断必须落盘可审计：
 * 谁在什么时候被自动建档了，事后能对账。
 *
 * 🔴 2026-11-09 修（**重启验证时抓到的真问题**）：
 *   初版写的是「没有任何新建就 `return`，不落盘」。
 *   结果重启后想确认「启动补跑到底跑没跑」时，**日志里什么都没有** ——
 *   分不清「跑了但无事可做」和「压根没跑」，这正是本项目反复踩的静默失效。
 *   现在改成：**每一轮都落盘**（含零新建的 tick），用 `event` 字段区分
 *   `run`（真的建了卡）/ `noop`（跑了但无事可做）。
 *   空转记录很便宜（一行 JSON），换来的是「功能是否真的在跑」可验证。
 */
function reportAutoCards(report, logger, trigger = '') {
    const created = report.groupsCreated.length + report.peopleCreated.length;
    if (!created) {
        // 零新建也要留痕：证明这一轮确实执行过（否则无法区分「没跑」与「没活干」）
        try {
            const dir = resolveMemoryRoot();
            mkdirSync(dir, { recursive: true });
            appendFileSync(join(dir, AUTO_CARD_LOG), JSON.stringify({
                at: new Date().toISOString(),
                event: 'noop',
                trigger,
                scannedGroups: report.scannedGroups,
                peopleSkipped: report.peopleSkipped,
                failed: report.failed,
                dryRun: report.dryRun,
            }) + '\n', 'utf8');
        }
        catch { /* 诊断失败绝不影响主流程 */ }
        return;
    }
    const g = report.groupsCreated.map((id) => id.slice(-6));
    const p = report.peopleCreated;
    const head = p.slice(0, 5).map((x) => `${x.groupId.slice(-6)}/${x.name}`).join('；');
    const more = p.length > 5 ? `；…另有 ${p.length - 5} 人` : '';
    logger?.info?.(`[bnnbotbox] 自动建档：新建群卡 ${report.groupsCreated.length} 个`
        + `${g.length ? `（${g.join('、')}）` : ''}、人物卡 ${p.length} 张`
        + `${head ? `（${head}${more}）` : ''}`
        + `${report.failed ? `，失败 ${report.failed}` : ''}`
        + `${report.dryRun ? '【dryRun 未落盘】' : ''}`);
    try {
        const dir = resolveMemoryRoot();
        mkdirSync(dir, { recursive: true });
        const file = join(dir, AUTO_CARD_LOG);
        try {
            if (statSync(file).size > 256 * 1024) {
                try {
                    renameSync(file, `${file}.1`);
                }
                catch { /* ignore */ }
            }
        }
        catch { /* 文件不存在 → 不轮转 */ }
        appendFileSync(file, JSON.stringify({
            at: new Date().toISOString(),
            event: 'run',
            trigger,
            scannedGroups: report.scannedGroups,
            groupsCreated: report.groupsCreated,
            peopleCreated: report.peopleCreated,
            peopleSkipped: report.peopleSkipped,
            failed: report.failed,
            dryRun: report.dryRun,
        }) + '\n', 'utf8');
    }
    catch { /* 诊断失败绝不影响主流程 */ }
}
/**
 * 记忆维护巡检：统计各群记忆规模，清理过期回收站（超 30 天的 .trash）。
 *
 * 只做只读统计 + 回收站清理（不碰正文），所以失败风险极低。
 */
function runMaintenance(memoryRoot, logger) {
    try {
        const groupsDir = join(memoryRoot, 'groups');
        if (!existsSync(groupsDir))
            return 'skip';
        let scopeCount = 0;
        let fileCount = 0;
        let trashCleaned = 0;
        const now = Date.now();
        for (const e of readdirSync(groupsDir, { withFileTypes: true })) {
            if (!e.isDirectory() || e.name.startsWith('.'))
                continue;
            scopeCount += 1;
            const groupDir = join(groupsDir, e.name);
            // 统计 .md 数量（跳过内部目录）
            const walk = (dir, depth = 0) => {
                if (depth > 6)
                    return 0;
                let n = 0;
                let entries;
                try {
                    entries = readdirSync(dir, { withFileTypes: true });
                }
                catch {
                    return 0;
                }
                for (const x of entries) {
                    if (x.name.startsWith('.'))
                        continue;
                    const abs = join(dir, x.name);
                    if (x.isDirectory())
                        n += walk(abs, depth + 1);
                    else if (x.isFile() && /\.md$/i.test(x.name))
                        n += 1;
                }
                return n;
            };
            fileCount += walk(groupDir);
            // 清回收站里超过 30 天的
            const trash = join(groupDir, '.trash');
            if (existsSync(trash)) {
                try {
                    for (const t of readdirSync(trash, { withFileTypes: true })) {
                        if (!t.isDirectory())
                            continue;
                        const abs = join(trash, t.name);
                        const mt = statSync(abs).mtimeMs;
                        if (now - mt > 30 * 24 * 3600 * 1000) {
                            rmSync(abs, { recursive: true, force: true });
                            trashCleaned += 1;
                        }
                    }
                }
                catch { /* ignore */ }
            }
        }
        logger?.info?.(`[bnnbotbox] 维护巡检：${scopeCount} 个群 / ${fileCount} 条记忆 / 清理回收站 ${trashCleaned} 项`);
        /**
         * ★ 2026-11-08 人物卡格式体检（只读，绝不改数据）。
         *
         * 起因：示例群的 `群友C.md` 缺 `openid` + `## Current`，
         * 导致该群记忆联想**每轮静默跳过**（`recall:skip no-items`），
         * 没有报错、没有日志，只能翻数据才发现。
         *
         * 这里只「扫出问题 + 告警 + 落盘」，由人决定怎么补 ——
         * 记忆内容是主人的数据，代码不该自动改写。
         */
        const audit = auditMemoryCards(memoryRoot);
        if (audit.issues.length) {
            reportCardIssues(audit.issues, audit.scanned, logger);
        }
        else if (audit.scanned > 0) {
            logger?.info?.(`[bnnbotbox] 人物卡体检：${audit.scanned} 张全部合格`);
        }
        return 'ok';
    }
    catch (err) {
        logger?.warn?.(`[bnnbotbox] 维护巡检失败: ${err instanceof Error ? err.message : String(err)}`);
        return 'skip';
    }
}
/**
 * ★ 2026-11-09 自动建档（**会写数据**，所以单独一步、单独 try，绝不与巡检互相拖累）。
 *
 * 结构性缺口（实测确认）：画像层（`elysia/profiles/*.md`）每天由 `r4-extract`
 * **自动**生成 33 个人；而 `entities/people/*.md` / `entities/groups/*.md`
 * 在全仓库**零自动写入**（`remember` 仅主人主动调用，生产调用次数 = 0）。
 * 结果：7 个群只有 1 个群卡、19 个关系人只有 5 篇人物卡 → 记忆联想大面积静默降级。
 *
 * 保守方案（主人 2026-11-09 批准）：
 *   · 只建**骨架**（群名/成员/openid/计数事实），**不写评价、不写群规**；
 *   · 已存在的卡**绝不改写**；
 *   · 证据不足（发言数 < `autoCardMinMessages`）不建。
 */
function runAutoCardStep(deps, logger, trigger = '') {
    const { config, memoryRoot, qqbotRoot, timeZone } = deps;
    if (!config.autoCardEnabled)
        return;
    const root = String(qqbotRoot ?? '').trim();
    if (!root || !existsSync(root)) {
        logger?.warn?.('[bnnbotbox] 自动建档：拿不到 qqbot 数据根，本次跳过');
        return;
    }
    try {
        const report = runAutoCards({
            memoryRoot,
            qqbotRoot: root,
            config: {
                enabled: true,
                groupEnabled: config.autoCardGroupEnabled !== false,
                minMessages: config.autoCardMinMessages,
                maxPerGroup: config.autoCardMaxPerGroup,
                ignoreNames: config.autoCardIgnoreNames,
            },
            logger,
            timeZone,
        });
        reportAutoCards(report, logger, trigger);
    }
    catch (err) {
        // 自动建档失败绝不影响巡检/体检
        logger?.warn?.(`[bnnbotbox] 自动建档失败（已跳过）：${err instanceof Error ? err.message : String(err)}`);
    }
}
/**
 * 记忆沉淀一步（2026-11-15 A-Phase 3）。
 *
 * ⚠️ 默认**关闭**（config.distillEnabled=false）——这是唯一会新增 LLM 调用的能力。
 * 关闭时本函数立刻返回，不产生任何开销。
 *
 * 提炼器由调用方注入（本插件不直接 inject llm：避免新增 peer 依赖）。
 * 未注入时**静默跳过**，不影响其它维护步骤。
 */
/**
 * 沉淀的并发锁与间隔守卫（2026-11-17 工业化加固）。
 *
 * 解决两个真实风险：
 *   ⑥ **并发**：任务中心的 interval 与 startup 补跑可能同时触发 →
 *      两个 runDistill 同时读同一批消息、写同一张卡 → 后写覆盖先写。
 *   ⑦ **间隔**：配置里有 minIntervalMs，但原实现固定传 0，等于没保护 →
 *      短时间反复触发会白烧模型调用。
 */
let distillRunning = false;
let distillLastRunAt = 0;
/** 间隔下限：两次沉淀之间至少隔这么久（防频繁触发烧钱）。 */
const DISTILL_MIN_INTERVAL_MS = 10 * 60_000; // 10 分钟
async function runDistillStep(deps, logger, trigger = "") {
    const { config, memoryRoot, qqbotRoot, timeZone } = deps;
    const distillExtractor = deps.distillExtractor;
    if (!config.distillEnabled)
        return;
    // ⑥ 并发锁：上一轮还没跑完就跳过（不排队，避免堆积）
    if (distillRunning) {
        logger?.info?.("[bnnbotbox] 沉淀上一轮还在跑 → 本次跳过");
        return;
    }
    // ⑦ 间隔守卫：距上次不足最小间隔就跳过
    const nowMs = Date.now();
    if (distillLastRunAt > 0 && nowMs - distillLastRunAt < DISTILL_MIN_INTERVAL_MS) {
        return;
    }
    if (typeof distillExtractor !== "function") {
        logger?.info?.("[bnnbotbox] 沉淀已开启但未注入提炼器 → 本次跳过");
        return;
    }
    const root = String(qqbotRoot ?? "").trim();
    if (!root)
        return;
    distillRunning = true;
    distillLastRunAt = nowMs;
    try {
        const cfg = {
            enabled: true,
            groupIds: config.distillGroupIds ?? [],
            maxMessagesPerRun: config.distillMaxMessages ?? 50,
            maxHistoryPerPerson: config.distillMaxHistory ?? 20,
            // ★ 修复：原来固定传 0 等于关闭间隔保护；现在传真实间隔
            minIntervalMs: DISTILL_MIN_INTERVAL_MS,
        };
        const r = await runDistill({ memoryRoot, qqbotRoot: root, config: cfg, extractor: distillExtractor, logger, timeZone });
        if (r.ok && r.cards > 0) {
            logger?.info?.("[bnnbotbox] 沉淀(" + trigger + ")：处理 " + r.messages + " 条消息 → " + r.facts + " 条事实 → 写入 " + r.cards + " 张卡");
        }
        else if (!r.ok && r.error) {
            logger?.warn?.("[bnnbotbox] 沉淀失败(" + trigger + ")：" + r.error);
        }
    }
    catch (err) {
        logger?.warn?.("[bnnbotbox] 沉淀异常(已跳过)：" + (err instanceof Error ? err.message : String(err)));
    }
    finally {
        // ⑥ 无论成功失败都必须释放锁，否则之后永远跳过
        distillRunning = false;
    }
}
/**
 * 登记维护任务；任务中心不可用时由调用方决定是否降级。
 *
 * @returns 卸载清理器（清掉「启动补跑」定时器；热重载不叠加）。
 */
export function registerMaintenanceTask(deps) {
    const { config, logger, memoryRoot, ctx } = deps;
    // 启动补跑定时器先声明，任何 return 路径都要能清理（下面统一收口）
    let startupTimer;
    const cleanup = () => { try {
        if (startupTimer)
            clearTimeout(startupTimer);
    }
    catch { /* ignore */ } startupTimer = undefined; };
    if (!config.enableMaintenanceTask)
        return cleanup;
    /**
     * ★ 2026-11-09 启动补跑（**必须有**）。
     *
     * 为什么：维护任务是 6 小时一次的 interval，而任务中心的 `catchUpOnStart` 只补
     * 「逾期」的 daily 任务；全新进程起来时，第一次 interval 要等满 6 小时。
     * 自动建档如果只挂在间期里，**重启后 6 小时内一张卡都不会建** ——
     * 这正是「编译通过、跑起来正常、功能等于不存在」的静默失效。
     *
     * 所以：延迟一小段（等 qqbot 消息历史/台账就绪）补跑一次。
     * 判据是 `groups.json` 可读（自动建档的数据源就绪），失败就算了，下次间期再来。
     */
    const STARTUP_DELAY_MS = 120_000;
    if (config.autoCardEnabled) {
        startupTimer = setTimeout(() => { try {
            runAutoCardStep(deps, logger, 'startup');
        }
        catch { /* 已内部 try */ } }, STARTUP_DELAY_MS);
        startupTimer.unref?.();
        logger?.info?.(`[bnnbotbox] 自动建档：启动补跑已排程（${STARTUP_DELAY_MS / 1000}s 后）`);
    }
    const fn = () => {
        const r = runMaintenance(memoryRoot, logger);
        // 自动建档作为**独立一步**：它写数据，巡检/体检是只读；两者互不拖累
        runAutoCardStep(deps, logger, 'interval');
        // 沉淀异步且默认关闭：不 await，避免拖慢维护 tick
        void runDistillStep(deps, logger, 'interval').catch(() => { });
        return r;
    };
    const ok = tcRegister('qq-memory-maintenance', fn);
    if (ok && tcDriving()) {
        logger?.info?.('[bnnbotbox] 记忆维护已登记到任务中心（节律见 任务中心/tasks.json）');
        return cleanup;
    }
    // 降级：任务中心不可用 → 自带定时器
    //   ⚠️ 必须挂 ctx.effect 托管（《审查标准》「定时器托管」强制项）：
    //      裸 setInterval 在热重载时会叠加，越跑越多。
    logger?.warn?.('[bnnbotbox] 任务中心不可用 → 记忆维护降级为自带定时器');
    const intervalMs = Math.max(60_000, Number(config.maintenanceEveryMs) || 6 * 3600 * 1000);
    const start = () => {
        const timer = setInterval(fn, intervalMs);
        timer.unref?.();
        return () => { try {
            clearInterval(timer);
        }
        catch { /* ignore */ } };
    };
    try {
        if (typeof ctx?.effect === 'function') {
            ctx.effect(() => start());
        }
        else {
            // 无 effect：至少 unref，避免拖住进程；并挂卸载事件兜底
            const stop = start();
            let hooked = false;
            for (const evt of ['dispose', 'app/unload', 'fiber/dispose']) {
                try {
                    const maybe = ctx?.on?.(evt, () => { try {
                        stop();
                    }
                    catch { /* ignore */ } });
                    if (typeof maybe === 'function') {
                        hooked = true;
                        break;
                    }
                }
                catch { /* 试下一个 */ }
            }
            if (!hooked)
                logger?.warn?.('[bnnbotbox] 降级定时器无法托管（无 ctx.effect / 卸载事件），热重载可能叠加');
        }
    }
    catch (err) {
        logger?.warn?.(`[bnnbotbox] 启动降级定时器失败: ${err instanceof Error ? err.message : String(err)}`);
    }
    return cleanup;
}
//# sourceMappingURL=tasks.js.map