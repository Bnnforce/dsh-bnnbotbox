/**
 * r4-mount — 装配层：prompt injector + R4 运行时 + R4 出站注入（从 `index.ts` 拆出，任务 B6）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么这两块放一起：它们是**装配性质**（不是业务逻辑）——
 *   ① `createPromptInjector` 挂 `system-prompt/assemble`（旧版 guideline 注入）
 *   ② `createR4Runtime` 组装 R4 的 host 对象 + 再挂一个 assemble 监听器（R4 注入）
 * 两块的共同点：都是"把已算好的片段接进宿主 prompt 管线"，且都要 `ctx.on` 清理句柄。
 *
 * 🔴 红线 R5（主人明确要求）：
 *   每个 mount 函数**必须返回清理函数**，index 只做聚合。
 *   本文件返回 `{ offInjector, offR4, r4, dispose }`，其中 `dispose` 收所有监听。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ⚠️ 下面这些注释**逐字保留**（都是真实事故记录）：
 *   · `complete:true` 覆盖 sections 的 R-1 姊妹问题（2026-11-03）
 *   · 阶段 5 的任务中心登记（plugin 与扩展同进程，靠 globalThis Symbol 共享）
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 🔵 依赖注入（不 import index.ts，防循环）：所有外部能力由 index 传入。
 */
import { createPromptInjector } from './prompt-injector.js';
import { createR4Runtime } from './r4/index.js';
import { personaForAssembly } from './persona.js';
import { readGuidelineSync, readOverlaySync } from './store.js';
import { readRecentHighlights } from './highlights.js';
import { collectStreamText, resolveReviewRoute } from './review.js';
/** 带超时的 Promise 包装（R4 模型调用用）。 */
async function withTimeoutR4(task, ms) {
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
}
/** 模型 ID → 路由（配置给谁就用谁，否则复用复盘的低阶模型解析）。 */
async function resolveRouteFor(llm, modelId) {
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
}
/**
 * 挂载 prompt injector（旧版 guideline/overlay/高光注入）。
 *
 * `ctxOnAssemble` 由 index 传入（`ctx.on`），避免本模块直接依赖 cordis ctx 类型。
 */
export function mountPromptInjector(deps, ctxOnAssemble) {
    const injector = createPromptInjector({
        getGuideline: (groupId) => readGuidelineSync(groupId),
        refresh: (groupId) => deps.refreshGroup(groupId),
        resolveGroupId: deps.groupIdFromContext,
        resolvePersona: (_context, assembly, groupId) => personaForAssembly(deps.personaRoots(), assembly, groupId),
        // 2026-11-02：最近 2 条高光作为「正向锚点」，与 guideline/overlay 一起并到末尾的锚点段。
        highlightLimit: 2,
        getHighlights: (limit) => readRecentHighlights(limit),
    });
    const off = ctxOnAssemble(injector);
    return typeof off === 'function' ? off : undefined;
}
/**
 * 挂载 R4 运行时 + R4 出站注入。
 *
 * 返回 `{ r4, offR4 }`；挂载失败时 `r4` 为 undefined（**主聊天不受影响**）。
 */
export function mountR4(deps, ctxOnAssemble) {
    const logger = deps.logger ?? {};
    const llm = deps.llm;
    let r4;
    try {
        r4 = createR4Runtime({
            logger,
            qqbotDataRoot: deps.qqbotDataRoot,
            listGroups: () => deps.r4Groups(),
            resolveGroupId: (sessionId) => deps.groupIdForSession(sessionId),
            resolveSenderId: (sessionId) => deps.r4SenderOf(sessionId, deps.groupIdForSession(sessionId)),
            /**
             * ★ 2026-11-05 阶段 5：把 R4 的心跳/提取登记到**任务中心**。
             *
             * 为什么在宿主这一层做：任务中心的引擎是 QQBot 扩展（`bnn-custom/hooks/zz-central-scheduler.mjs`），
             * 插件不该硬依赖扩展包路径。但**插件与扩展在同一 Node 进程**，
             * 引擎把注册表挂在 `globalThis[Symbol.for('dsh.taskcenter.registry.v1')]`，
             * 所以直接往那个 Map 写即可 —— 不 import 扩展源码、不用文件锁。
             *
             * 若引擎还未启动，这里的 Map 会先被创建；引擎启动后走**同一个 Symbol.for**
             * → 复用同一个 Map，登记项照样可见。这就是阶段 1 设计「跨文件全局注册表」的用处。
             */
            registerTaskCenterExecutor: (runKey, fn) => {
                try {
                    const g = globalThis;
                    const key = Symbol.for('dsh.taskcenter.registry.v1');
                    if (!g[key] || typeof g[key] !== 'object')
                        g[key] = new Map();
                    const reg = g[key];
                    if (reg.has(runKey)) {
                        // 网关"先拆后建"会重跑 apply → 幂等：不覆盖旧闭包（它持有旧 env）
                        logger.info?.(`[anti-ai-persona] 任务中心执行器已存在，复用登记: ${runKey}`);
                        return;
                    }
                    reg.set(runKey, { fn, meta: { id: `plugin-${runKey}`, owner: 'plugin' } });
                    logger.info?.(`[anti-ai-persona] 已登记 R4 执行器到任务中心: ${runKey}`);
                }
                catch (e) {
                    logger.warn?.(`[anti-ai-persona] 登记任务中心执行器失败: ${e instanceof Error ? e.message : String(e)}`);
                    throw e; // 抛出去 → createR4Runtime 走无外部驱动的降级路径（自排 setTimeout）
                }
            },
            readOverlay: (gid, personaName) => { try {
                return readOverlaySync(gid, personaName);
            }
            catch {
                return '';
            } },
            readHighlights: (limit) => {
                try {
                    const list = readRecentHighlights(limit);
                    if (!list.length)
                        return '';
                    return ['【高光锚点：这些是你被夸过的表达，尽量保持同一种语感】', ...list.map((h) => `· ${h.text}`)].join('\n');
                }
                catch {
                    return '';
                }
            },
            sendToGroup: async (gid, text) => deps.sendToGroupViaBridge(gid, text),
            // ★ 2026-11-08 记忆联想化（第一层）：宿主注入的记忆回调（未实现 → 该段不注入）
            getMemoryRecall: deps.getMemoryRecall,
            complete: async ({ model, system, prompt, maxTokens, timeoutMs }) => {
                if (!llm || typeof llm.stream !== 'function')
                    throw new Error('llm unavailable');
                const route = await resolveRouteFor(llm, model);
                if (!route)
                    throw new Error('no route for R4 model');
                // R4 后台任务是否可用：以 R4 运行时就绪 + 诊断里的 backgroundEnabled 为准
                const bgEnabled = (() => {
                    try {
                        const diag = r4?.diagnostics();
                        return diag?.backgroundEnabled === true;
                    }
                    catch {
                        return false;
                    }
                })();
                if (!bgEnabled)
                    throw new Error('R4 后台任务禁用（模型 ID 为占位符）');
                const stream = llm.stream({
                    provider: route.provider,
                    model: route.model,
                    system,
                    messages: [{
                            id: `r4-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                            role: 'user',
                            content: [{ type: 'text', text: prompt }],
                            source: { kind: 'plugin:dsh-anti-ai-persona' },
                        }],
                    maxTokens,
                });
                const res = await withTimeoutR4(collectStreamText(stream), timeoutMs ?? 8000);
                if (res.timedOut)
                    throw new Error('r4 llm timeout');
                return String(res.value ?? '');
            },
        });
        logger.info?.('[anti-ai-persona] R4.0 已挂载');
    }
    catch (error) {
        logger.warn?.(`[anti-ai-persona] R4.0 挂载失败（已忽略，主聊天不受影响）：${error instanceof Error ? error.message : String(error)}`);
    }
    /** `complete:true` 的告警只打一次（与 prompt-injector 同一约定）。 */
    let warnedCompleteR4 = false;
    const offR4 = r4
        ? ctxOnAssemble(async (assembly, context, next) => {
            const assembled = await next();
            try {
                const text = r4 ? r4.assemble(context) : '';
                if (!text)
                    return assembled;
                const sections = Array.isArray(assembled?.sections) ? assembled.sections : [];
                const sid = String(context?.agent?.session?.id ?? '');
                const name = `dsh-anti-ai-persona:r4:${deps.groupIdForSession(sid) || 'session'}`;
                // ★ 2026-11-03 修复（R-1 姊妹问题）：宿主若存在 `complete:true` 的 section，
                //   它会**用那一段覆盖整个 sections** —— 我们追加的 section 会被静默丢弃，
                //   导致 R4 的画像/关系/时间/争宠注入**整体不生效且无日志**。
                //   此时只能改写那一段的正文末尾（与 prompt-injector.ts 的兼容分支同一策略）。
                const completeIndex = sections.findIndex((s) => Boolean(s?.complete));
                if (completeIndex >= 0) {
                    if (!warnedCompleteR4) {
                        warnedCompleteR4 = true;
                        logger.warn?.('[anti-ai-persona] 检测到宿主 prompt section 设置了 complete:true —— '
                            + '它会把整个 sections 覆盖成单段，R4 追加的 section 会被丢弃；'
                            + '已改为把 R4 正文注入到该段末尾。建议把 persona.complete 设为 false。');
                    }
                    const merged = sections.map((s, i) => (i === completeIndex ? { ...s, text: `${String(s?.text || '').trimEnd()}\n\n${text}` } : s));
                    return { ...assembled, sections: merged };
                }
                return { ...assembled, sections: [...sections, { name, interpolate: false, text }] };
            }
            catch {
                return assembled;
            }
        })
        : undefined;
    return {
        r4,
        offR4: typeof offR4 === 'function' ? offR4 : undefined,
    };
}
