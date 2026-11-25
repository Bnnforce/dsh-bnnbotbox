/**
 * dsh-qq-memory — 插件入口
 *
 * 架构（统一架构方案）：
 *   · 注册 cordis 服务 `qqMemory`（供其他插件 ctx.get 使用）
 *   · 注册模型工具 `qq_memory`（单工具多 action，D2 决定）
 *   · 登记维护任务到任务中心（不搬调度引擎）
 *
 * 依赖：`inject: ['persona']` —— scope 解析必须走 persona 服务
 *       （红线：session-groups.json 只有 persona 能读，否则串群）。
 */
import { resolveDataRoot } from '../shared/paths.js';
import { resolveMemoryRoot } from '../shared/paths.js';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Config, resolveConfig } from './config.js';
import { MemoryStore } from './store/index.js';
import { QqMemoryService } from './service.js';
import { createQqMemoryTool } from './tools/qq-memory.js';
import { registerMaintenanceTask } from './tasks.js';
// ★ 2026-11-17 记忆沉淀的提炼器（走对话默认模型）
import { createDistillExtractor } from './distiller.js';
import { installBridge } from './bridge.js';
import { resolveQqbotDataRoot } from '../shared/paths.js';
export const name = 'qq-memory';
// ★ 2026-11-17 记忆沉淀需要模型（走对话默认模型，不写死）
//   为什么加 llm：distill 的 extractor 必须能调模型，否则沉淀功能等于没写
//   （实测：85 张记忆卡 71 张 History 只有建档那 1 行，8 天没长过）
export const inject = ['persona', 'tools', 'llm'];
export { Config };
/**
 * 解析 qqbot 数据根。
 *
 * 顺序（与 persona 的 paths-runtime 同思路）：
 *   ① 配置显式值
 *   ② qqbot 设置文件里的 `dataRoot`
 *   ③ 本机默认 {WORKSPACE_ROOT}/Bot/dshqqbot
 *   ④ ~/.dsh-qqbot
 * 判据：目录下有 `.qqbot/msg-history`（或至少有 `.qqbot`）。
 */
export function resolveQqbotRoot(config, logger) {
    // 2026-11-20 合并：委托给 shared/paths 的统一实现（原来这里有一套独立逻辑）
    //   好处：只有一处发现逻辑；发现源更多；不再有作者环境硬编码
    const r = resolveQqbotDataRoot({ explicit: config && config.qqbotDataRoot });
    try {
        if (r && !existsSync(join(r, '.qqbot', 'msg-history'))) {
            logger?.warn?.('[qq-memory] qqbot 数据根未命中有效目录：' + r + '（记忆工具可能不可用）');
        }
    }
    catch { /* ignore */ }
    return r;
}
export function apply(ctx, rawConfig) {
    // 🔴 启动诊断（2026-11-06）：插件 logger **不进 engine.log**（已实测确认），
    //    所以启动过程必须自己落盘，否则「插件没加载」和「加载了但没日志」分不清。
    bootDiag('apply-enter', { hasCtx: Boolean(ctx), hasGet: typeof ctx?.get === 'function' });
    try {
        applyInner(ctx, rawConfig);
        bootDiag('apply-exit-ok', {});
    }
    catch (err) {
        bootDiag('apply-THREW', { err: err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err) });
        throw err;
    }
}
/** 启动诊断：把 apply 的执行与异常写进文件（永不抛、不依赖 logger）。 */
function bootDiag(event, data) {
    try {
        const dir = resolveMemoryRoot();
        mkdirSync(dir, { recursive: true });
        appendFileSync(join(dir, 'boot.log'), `${JSON.stringify({ at: new Date().toISOString(), event, pid: process.pid, ...data })}\n`, 'utf8');
    }
    catch { /* 诊断失败不影响插件 */ }
}
function applyInner(ctx, rawConfig) {
    const config = resolveConfig(rawConfig);
    if (!config.enabled) {
        ctx?.logger?.info?.('[qq-memory] enabled=false，跳过');
        bootDiag('apply-disabled', {});
        return;
    }
    const logger = ctx?.logger ?? {};
    const qqbotRoot = resolveQqbotRoot(config, logger);
    if (!qqbotRoot) {
        logger.warn?.('[qq-memory] 探测不到 qqbot 数据根，记忆库不可用');
        bootDiag('apply-no-root', {});
        return;
    }
    const memoryRoot = join(qqbotRoot, config.memorySubdir);
    logger.info?.(`[qq-memory] qqbot 数据根=${qqbotRoot}`);
    logger.info?.(`[qq-memory] 记忆库根=${memoryRoot}`);
    bootDiag('apply-root', { qqbotRoot, memoryRoot });
    // ── 存储层 ─────────────────────────────────────────────────────────────
    const store = new MemoryStore({
        memoryRoot,
        searchMaxHits: config.searchMaxHits,
        searchLineMaxChars: config.searchLineMaxChars,
        readMaxBytes: config.readMaxBytes,
        writeMaxBytesPerEntry: config.writeMaxBytesPerEntry,
        writeMaxEntriesPerScope: config.writeMaxEntriesPerScope,
        globalPublicFiles: config.globalPublicFiles,
        logger,
    });
    // ── persona 服务取用（可能暂时未就绪）─────────────────────────────────────
    const getPersona = () => {
        try {
            const svc = ctx?.get?.('persona');
            if (svc && typeof svc.resolveGroup === 'function')
                return svc;
            // 兼容：cordis 未 provide 时，尝试从全局拿到（降级路径，仅诊断用）
            return undefined;
        }
        catch {
            return undefined;
        }
    };
    if (!getPersona()) {
        logger.warn?.('[qq-memory] persona 服务尚未就绪（scope 解析会返回空，工具将不可用）');
    }
    // ── 启动自检（2026-11-06）：验证「persona 可用 + 记忆库可读」──────────────
    //    为什么要在启动时做：模型不一定马上调用工具，而我们要能在重启后**立刻**判断
    //    插件是否真的可用（而不是等群里发消息才知道）。结果落盘到 boot.log。
    try {
        const persona = getPersona();
        const probed = {
            hasPersona: Boolean(persona),
            memoryRoot,
            memoryRootExists: existsSync(memoryRoot),
            groupDirs: 0,
            sampleScope: '',
            sampleHits: -1,
        };
        try {
            const gdir = join(memoryRoot, 'groups');
            if (existsSync(gdir))
                probed.groupDirs = readdirSync(gdir).filter((n) => !n.startsWith('.')).length;
        }
        catch { /* ignore */ }
        // 用真实 session-groups 的第一条做一次端到端探针（只读）
        if (persona) {
            try {
                const map = JSON.parse(readFileSync(join(resolveDataRoot(), 'session-groups.json'), 'utf8'));
                const firstSid = Object.keys(map).find((k) => k.includes('-')) ?? '';
                if (firstSid) {
                    const v = map[firstSid];
                    const gid = typeof v === 'string' ? v : String(v?.groupId ?? '');
                    const resolved = String(persona.resolveGroup(firstSid) ?? '');
                    probed.sampleScope = `${firstSid.slice(0, 8)}→${resolved.slice(0, 12)}`;
                    if (resolved) {
                        const hits = store.search({ type: 'group', id: resolved }, '');
                        probed.sampleHits = hits.length;
                    }
                }
            }
            catch { /* 探针失败无所谓 */ }
        }
        bootDiag('selfcheck', probed);
    }
    catch (err) {
        bootDiag('selfcheck-THREW', { err: String(err) });
    }
    // ── 注册 cordis 服务 ───────────────────────────────────────────────────
    let service;
    try {
        service = new QqMemoryService(ctx, {
            store,
            logger,
            getPersona,
            ownersFallback: config.ownersFallback,
            ownerWriteOnly: config.ownerWriteOnly,
        });
        logger.info?.('[qq-memory] cordis 服务 qqMemory 已注册');
        // 挂 globalThis 桥：QQBot 扩展包的 env 由 QQBot 插件构造，拿不到 cordis ctx，
        // 所以「插件 ↔ 扩展包」只能走进程级全局（详见 bridge.ts 注释）。
        try {
            const disposeBridge = installBridge(service);
            if (typeof ctx.effect === 'function') {
                ctx.effect(() => disposeBridge);
            }
            else {
                for (const evt of ['dispose', 'app/unload', 'fiber/dispose']) {
                    try {
                        const maybe = ctx.on?.(evt, () => { try {
                            disposeBridge();
                        }
                        catch { /* ignore */ } });
                        if (typeof maybe === 'function')
                            break;
                    }
                    catch { /* 试下一个 */ }
                }
            }
            // 🔴 2026-11-06 诊断：桥是否真挂上（此前 hasBridge:false 说明没挂，必须落盘确认）
            bootDiag('bridge-installed', {
                symbolPresent: Boolean(globalThis[Symbol.for('dsh.qq-memory.v1')]),
                hasService: Boolean(globalThis[Symbol.for('dsh.qq-memory.v1')]?.service),
            });
            logger.info?.('[qq-memory] globalThis 桥已挂载（扩展包可调用）');
        }
        catch (err) {
            bootDiag('bridge-FAILED', { err: String(err) });
            logger.warn?.(`[qq-memory] 挂 globalThis 桥失败: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    catch (err) {
        logger.warn?.(`[qq-memory] 注册服务失败（不影响插件加载）: ${err instanceof Error ? err.message : String(err)}`);
    }
    // ── 注册模型工具 ───────────────────────────────────────────────────────
    //    🔴 坑（2026-11-06 修正）：**绝不能写 `ctx.effect?.(...)`**。
    //      persona 插件有事故记录：宿主不提供 effect 时可选项会让整个清理块**静默跳过**，
    //      工具 disposer 永远不被调用 → 热重载后旧工具残留在注册表里。
    //      必须显式判断 + 降级。
    try {
        const tools = ctx?.get?.('tools');
        if (tools && typeof tools.register === 'function') {
            const dispose = tools.register(createQqMemoryTool({ store, service, getPersona, logger, config }));
            if (typeof dispose === 'function') {
                if (typeof ctx.effect === 'function') {
                    ctx.effect(() => dispose);
                }
                else {
                    // 降级：挂到宿主卸载事件（拿不到就只 warn，至少不静默）
                    let hooked = false;
                    for (const evt of ['dispose', 'app/unload', 'fiber/dispose']) {
                        try {
                            const maybe = ctx.on?.(evt, () => { try {
                                dispose();
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
                        logger.warn?.('[qq-memory] 宿主无 ctx.effect 也无卸载事件 → 工具 disposer 无法托管（重载时可能残留）');
                }
            }
            logger.info?.('[qq-memory] 工具 qq_memory 已注册');
        }
        else {
            logger.warn?.('[qq-memory] 拿不到 tools 服务，工具未注册');
        }
    }
    catch (err) {
        logger.warn?.(`[qq-memory] 注册工具失败: ${err instanceof Error ? err.message : String(err)}`);
    }
    // ── 任务中心登记（不搬引擎）────────────────────────────────────────────
    if (config.enableMaintenanceTask) {
        try {
            const disposeMaintenance = registerMaintenanceTask({
                config,
                logger,
                memoryRoot,
                // ★ 2026-11-09 自动建档需要这三样：群名/台账/消息历史全在 qqbot 数据根下
                qqbotRoot,
                timeZone: resolvePersonaTimeZone(),
                ctx,
                // ★ 2026-11-17 关键修复：沉淀的提炼器必须注入，否则 runDistillStep 会静默跳过
                //   （这是 71/85 张卡 History 只有 1 行的根因：extractor 从来没被注入过）
                distillExtractor: (() => {
                    try {
                        const llmSvc = (() => {
                            try {
                                return ctx?.get?.('llm') ?? null;
                            }
                            catch {
                                return null;
                            }
                        })();
                        if (!llmSvc) {
                            logger.warn?.('[qq-memory] 拿不到 llm 服务 → 记忆沉淀将跳过（不影响记忆查询）');
                            return undefined;
                        }
                        return createDistillExtractor({ llm: llmSvc, logger });
                    }
                    catch (e) {
                        logger.warn?.(`[qq-memory] 创建提炼器失败: ${e instanceof Error ? e.message : String(e)}`);
                        return undefined;
                    }
                })(),
            });
            // 启动补跑定时器必须托管（否则热重载会叠加「延迟建档」）
            if (typeof disposeMaintenance === 'function') {
                if (typeof ctx?.effect === 'function') {
                    ctx.effect(() => disposeMaintenance);
                }
                else {
                    for (const evt of ['dispose', 'app/unload', 'fiber/dispose']) {
                        try {
                            const maybe = ctx?.on?.(evt, () => { try {
                                disposeMaintenance();
                            }
                            catch { /* ignore */ } });
                            if (typeof maybe === 'function')
                                break;
                        }
                        catch { /* 试下一个 */ }
                    }
                }
            }
        }
        catch (err) {
            logger.warn?.(`[qq-memory] 登记维护任务失败: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
}
/**
 * 读取人格配置里的时区（自动建档的日期键用）。
 *
 * 为什么复用 persona 的配置而不自己写死：日期键会影响「History」里写的日期，
 * 写错了就是错的历史记录。读不到 → 空串，由 `auto-card` 回落到 Asia/Shanghai。
 */
function resolvePersonaTimeZone() {
    try {
        const p = join(resolveDataRoot(), 'persona-configs', 'elysia.json');
        const j = JSON.parse(readFileSync(p, 'utf8'));
        const tz = typeof j?.timezone === 'string' ? j.timezone : typeof j?.timeZone === 'string' ? j.timeZone : '';
        return tz.trim();
    }
    catch {
        return '';
    }
}
export default { name, inject, Config, apply };
//# sourceMappingURL=index.js.map