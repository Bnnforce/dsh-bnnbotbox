/**
 * 工具 `qq_memory` —— 单工具多 action（D2 决定）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 🔴 DSH 工具契约（2026-11-06 修正，此前写错了）：
 *
 *   ① **必须用 `defineTool()` 包装**再交给 `ctx.tools.register()`。
 *      裸对象 + register 会在读 `options.output.render` 时炸：
 *        TypeError: Cannot read properties of undefined (reading 'render')
 *      （源码 dsh-tools/lib/index.js:842 `const userRender = options.output.render;` 无保护）
 *
 *   ② `output` 是**强制字段**，且必须含 `render`。
 *
 *   ③ **两套 schema DSL 不一样**：
 *      · `parameters`：`required` 挂在**字段上** → `{ type:'string', required:true }`
 *      · `output.schema`：必须是**对象根**，且 `additionalProperties` 显式 true/false
 *
 *   ④ `render(args, value)` 返回**内容块数组** `[{type:'text', text:'…'}]`，
 *      不是字符串（照 dsh-tool-todo/lib/index.js:165）。
 *
 *   ⑤ `execute(args, exec)` 的返回值必须满足 `output.schema`。
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { resolveMemoryRoot } from '../../shared/paths.js';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join as joinPath } from 'node:path';
const ACTIONS = ['search', 'read', 'list', 'remember', 'update', 'forget'];
const READ_ACTIONS = new Set(['search', 'read', 'list']);
/**
 * 构造 `qq_memory` 工具定义（已用 defineTool 包装，可直接 register）。
 */
export function createQqMemoryTool(deps) {
    const { store, getPersona, logger, config } = deps;
    return defineTool({
        name: 'qq_memory',
        description: '【本群长期记忆的唯一入口】搜/读/列 用 search / read / list（群友可用）；'
            + 'remember 新增 / update 修改 / forget 删除（仅主人）。'
            + '只能访问当前群，不能跨群；路径相对本群记忆根，如 entities/people/群友A.md。'
            + '查「某人的某件事」时 search 的 query 写**多个词**（如「群友A 生日」），不要写成一整句。'
            + '⚠️ 这是官方记忆工具：凡涉及「记不记得 / 查档案 / 群里谁说过什么」一律用它，'
            + '不要用任何名字带 memory 的旧工具（那些是同一份数据的过时入口）。'
            + '也不要因为一次没搜到就换别的工具 —— 换更短的词再搜一次。'
            + '生日/档案都在本工具里（生日档在 events/birthdays/MM-DD-名.md），'
            + '所以查「某人什么时候生日」用 search「名 生日」即可，不需要别的生日工具。',
        // ⚠️ DSL-A：required 挂在字段上
        parameters: {
            action: {
                type: 'string',
                required: true,
                enum: [...ACTIONS],
                description: '要做的事：search 搜索 / read 读文件 / list 列目录 / remember 新增 / update 修改 / forget 删除',
            },
            query: {
                type: 'string',
                description: 'search 的搜索词。**可以写多个词，用空格分开**（如「群友A 生日」），'
                    + '会切词后按相关度排序 —— 命中词越多排越前，所以查「某人 + 某事」时'
                    + '直接写两个词比写一整句更准。空 = 返回全部（受条数上限约束）。',
            },
            path: { type: 'string', description: '记忆文件相对路径，如 entities/people/群友A.md 或 events/birthdays/11-11-群友A.md' },
            content: { type: 'string', description: 'remember/update 要写入的内容（Markdown，一行一条）' },
        },
        // ⚠️ DSL-B：对象根 + additionalProperties 显式
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    ok: { type: 'boolean', required: true, description: '是否成功' },
                    msg: { type: 'string', required: true, description: '给模型看的文本结果' },
                    count: { type: 'number', description: '命中/文件数量' },
                    // ⚠️ 必须显式声明 type：defineTool 不接受「只有 description」的属性
                    //    （实测报错：schema.properties.data.type must be string/number/... or use oneOf）
                    // 🔴 2026-11-06 真机抓到的 bug：此前写 `type:'object'`，但 search/list 返回的是**数组**，
                    //    宿主输出校验报 `"value.data" must be an object` → 工具整体报
                    //    `tool "qq_memory" returned invalid output`，她只能降级去调 group_memory。
                    //    改用 `type:'json'`（DSL 支持，接受任意 JSON 值），实测数组/对象/标量全部通过。
                    data: { type: 'json', description: '结构化数据（任意 JSON 可序列化值）' },
                },
            },
            // ⚠️ render 返回**内容块数组**，不是字符串
            render: (_args, value) => [{
                    type: 'text',
                    text: String(value?.msg ?? (value?.ok ? '（完成）' : '（失败）')),
                }],
        },
        async execute(args, exec) {
            const action = String(args?.action ?? '').trim();
            if (!ACTIONS.includes(action)) {
                return { ok: false, msg: `未知 action: ${action || '(空)'}；可用：${ACTIONS.join(' / ')}` };
            }
            // ── ① 解析 scope（必须走 persona 服务）──
            const sessionId = String(exec?.agent?.session?.id ?? '');
            const persona = safePersona(getPersona);
            if (!persona || !sessionId) {
                diag('no-session', { sessionId, hasPersona: Boolean(persona) });
                return { ok: false, msg: '拿不到当前会话/群信息，无法访问记忆（scope 解析不可用）' };
            }
            let groupId = '';
            try {
                groupId = String(persona.resolveGroup(sessionId) ?? '');
            }
            catch (e) {
                groupId = '';
                diag('resolve-threw', { err: String(e) });
            }
            if (!groupId) {
                diag('no-group', { sessionId });
                return { ok: false, msg: '当前会话不是 QQ 群会话或群号未知，本工具只在 QQ 群里可用' };
            }
            const scope = { type: 'group', id: groupId };
            diag('scope-ok', { sessionId, groupId, action });
            // ── ② 权限判定（persona 白名单为主 + ownersFallback 兜底 + fail-closed）──
            const senderId = String((persona.resolveSender?.(sessionId) ?? '') || safeExecSender(exec) || '');
            const isOwner = Boolean((senderId && persona.isOwner?.(senderId, groupId))
                || (senderId && config.ownersFallback.includes(senderId)));
            if (!READ_ACTIONS.has(action) && config.ownerWriteOnly !== false && !isOwner) {
                return { ok: false, msg: '写记忆仅限主人；你可以用 search / read / list 查看本群记忆' };
            }
            // ── ③ 执行 ──
            try {
                switch (action) {
                    case 'search': {
                        const hits = store.search(scope, String(args?.query ?? ''));
                        if (hits.length === 0)
                            return { ok: true, msg: '本群没有匹配的记忆。', count: 0, data: [] };
                        /**
                         * ★ 2026-11-08 修（真机实测发现）：`store.search` 按相关度返回最多 30 条，
                         *   直接全塞给模型会有两个问题：
                         *     ① **上下文成本**：实测 query="群友A 生日" 返回 24 条 ≈ 1503 字符（~800 tokens）；
                         *     ② **信息重复**：24 条只来自 5 个文件，同一文件的多行把预算吃光，
                         *        模型反而看不到「这个文件里还有什么」。
                         *
                         *   这里做**按文件分组 + 每组限额**：同一文件最多留 `SEARCH_PER_FILE_MAX` 行，
                         *   文件数上限 `SEARCH_FILE_MAX`，输出时按文件聚合（模型一眼看出「哪几个文件相关」，
                         *   要看更多就再 read 那个文件）。
                         *
                         *   ⚠️ 只是**展示层裁剪**，`data` 里仍然是完整命中 —— 想拿全部可读 data。
                         */
                        const SEARCH_FILE_MAX = 5;
                        const SEARCH_PER_FILE_MAX = 3;
                        const grouped = new Map();
                        for (const h of hits) {
                            const arr = grouped.get(h.path) ?? [];
                            // 顺序已经是相关度降序，所以每文件取前 N 行 = 取该文件最相关的行
                            if (arr.length < SEARCH_PER_FILE_MAX)
                                arr.push({ path: h.path, line: h.line });
                            grouped.set(h.path, arr);
                        }
                        const shownFiles = [...grouped.entries()].slice(0, SEARCH_FILE_MAX);
                        const body = shownFiles
                            .map(([p, lines]) => [`【${p}】`, ...lines.map((x) => `  ${x.line}`)].join('\n'))
                            .join('\n');
                        const shownCount = shownFiles.reduce((n, [, lines]) => n + lines.length, 0);
                        const more = hits.length > shownCount
                            ? `\n\n（还有 ${hits.length - shownCount} 条在同一批文件里未展开；需要细节就 read 上面某个文件）`
                            : '';
                        return {
                            ok: true,
                            msg: `找到 ${hits.length} 条，涉及 ${grouped.size} 个文件。最相关的 ${shownCount} 条：\n${body}${more}`,
                            count: hits.length,
                            data: hits,
                        };
                    }
                    case 'read': {
                        const rel = String(args?.path ?? '').trim();
                        if (!rel)
                            return { ok: false, msg: 'read 需要 path 参数' };
                        const r = store.read(scope, rel);
                        if (!r.ok)
                            return { ok: false, msg: r.reason };
                        return { ok: true, msg: r.text, data: { path: r.path } };
                    }
                    case 'list': {
                        const r = store.list(scope, String(args?.path ?? '').trim());
                        if (!r.ok)
                            return { ok: false, msg: r.reason };
                        if (r.files.length === 0)
                            return { ok: true, msg: '本群还没有记忆文件。', count: 0, data: [] };
                        return {
                            ok: true,
                            msg: `本群记忆 ${r.files.length} 个：\n${r.files.map((f) => `- ${f}`).join('\n')}`,
                            count: r.files.length,
                            data: r.files,
                        };
                    }
                    case 'remember':
                    case 'update': {
                        const rel = String(args?.path ?? '').trim();
                        const content = String(args?.content ?? '');
                        if (!rel)
                            return { ok: false, msg: `${action} 需要 path 参数` };
                        if (!content.trim())
                            return { ok: false, msg: `${action} 需要 content 参数` };
                        const r = store.remember(scope, rel, content);
                        if (!r.ok)
                            return { ok: false, msg: r.reason };
                        return { ok: true, msg: `已写入 ${r.path}（本群记忆）`, data: { path: r.path } };
                    }
                    case 'forget': {
                        const rel = String(args?.path ?? '').trim();
                        if (!rel)
                            return { ok: false, msg: 'forget 需要 path 参数' };
                        const r = store.forget(scope, rel);
                        if (!r.ok)
                            return { ok: false, msg: r.reason };
                        return { ok: true, msg: `已删除 ${r.path}（移入回收站，可恢复）`, data: { path: r.path, trash: r.trash } };
                    }
                    default:
                        return { ok: false, msg: `未知 action: ${action}` };
                }
            }
            catch (err) {
                logger?.warn?.(`[bnnbotbox] 工具执行异常: ${err instanceof Error ? err.message : String(err)}`);
                return { ok: false, msg: '记忆操作失败（内部错误，已记录日志）' };
            }
        },
    });
}
/**
 * 诊断落盘（2026-11-06 真机排查用）：把工具运行时拿到的 sessionId/groupId 写进文件。
 * 为什么不用 logger：插件 logger 不进 engine.log（已确认），排查不到。
 * 永抛：诊断失败绝不影响工具本身。
 */
function diag(event, data) {
    try {
        const dir = resolveMemoryRoot();
        mkdirSync(dir, { recursive: true });
        appendFileSync(joinPath(dir, 'tool-diag.log'), JSON.stringify({ at: new Date().toISOString(), event, ...data }) + '\n', 'utf8');
    }
    catch { /* 诊断失败无所谓 */ }
}
function safePersona(get) {
    try {
        return get();
    }
    catch {
        return undefined;
    }
}
/** 兜底：某些执行上下文可能带 senderId。 */
function safeExecSender(exec) {
    try {
        return String(exec?.senderId ?? exec?.agent?.senderId ?? exec?.user?.openid ?? '');
    }
    catch {
        return '';
    }
}
//# sourceMappingURL=qq-memory.js.map