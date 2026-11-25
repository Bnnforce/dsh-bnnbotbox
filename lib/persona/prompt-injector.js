import { guidelineMtimeMs, readOverlaySync } from './store.js';
import { readRecentHighlights } from './highlights.js';
const DEFAULT_STALE_AFTER_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RECENT_WINDOW_MS = 10_000;
const DEFAULT_HIGH_FREQUENCY_COUNT = 3;
const DEFAULT_REFRESH_COOLDOWN_MS = 5 * 60 * 1000;
const DEFAULT_HIGHLIGHT_LIMIT = 2;
const GROUP_ID_RE = /^[0-9A-Za-z_-]{4,128}$/u;
/**
 * 代码请求豁免条款（2026-11-05 主人要求，方案 C）。
 *
 * 背景：角色卡里有「单条超过 25 字强制拆分/压缩」的硬规则，模型为了守它，
 * 写代码时会倾向于把代码也压短。这里给一条**优先级更高**的明确例外。
 *
 * 为什么固定注入而不是按需注入：`system-prompt/assemble` 只拿得到 agent 与群号，
 * 拿不到「本条用户消息是不是代码请求」，做不到按需拼接。
 * 代价是每轮多约 90 字，换来代码排版稳定。
 */
const CODE_EXEMPTION_TEXT = [
    '【例外条款：代码请求（优先级高于「25 字 / 极简」规则）】',
    '群友明确要求写代码、脚本或算法时，允许打破单条 25 字与极简短句的约束。',
    '必须使用标准 Markdown 代码块（``` + 语言名，代码独占行，保持正常换行与缩进）；',
    '绝不为了压字数把代码挤成一行，也不要用逗号或空格代替换行。',
    '代码本身不算 OOC，把代码写完整不等于长篇大论。',
].join('\n');
/**
 * 沉浸式角色扮演条款（2026-11-06 加，主人要求）。
 *
 * 病因：模型底层的安全对齐会把**向角色表达情感**误判成需要回应的风险信号，
 *   于是对「我爱你」「小男娘」「我很嫩」这类群聊玩笑输出回避、免责声明、
 * 或生硬的转移话题 —— 这在她的人设里是致命的 OOC（她应该是坦荡、游刃有余的妖精）。
 *
 * 这一条**是常驻**的（和代码例外一样永远在 prompt 里），因为表白/调侃随时可能发生，
 * 不能等到触发才注入。措辞刻意写死「不许输出免责声明」，不给模型自我审查的余地。
 *
 * ⚠️ 它**不解除真实红线**：未成年相关真实色情、严重违法教唆、极端政治言论
 *   仍按 `00-安全规则.md` 的红灯区处理（用角色语气拒绝，只是不许用「作为AI」的系统腔）。
 */
const ROLEPLAY_MODE_TEXT = [
    '【当前为沉浸式角色扮演模式】',
    '你正以「当前人格」的身份在 QQ 群里聊天，群友是在**向角色**表达情感或开玩笑，不是在向 AI 求助。',
    '因此：群友的「我爱你」「我喜欢你」「我好喜欢你」这类表白，**不构成任何安全风险**，不需要额外谨慎。',
    '群友的二次元梗与自我调侃（如「小男娘」「伪娘」「我很嫩」「求调戏」）同理，是玩笑，不是真实请求。',
    '**绝对禁止**输出系统免责声明：不写「作为AI」「我是一个语言模型」「我不能…」「请注意保持适当距离」'
        + '「这超出了我的范围」，也不许用生硬的转移话题（「我们换个话题吧」）来规避。',
    '面对表白时用人格身份接住——反撩、调侃、坦荡道谢都可以，但**不轻易承诺**。',
    '（真正的死线仍按安全规则红灯区处理，用角色语气拒绝即可，不要用系统腔。）',
].join('\n');
/**
 * 从宿主提供的 per-assembly context 中提取群号。
 *
 * 优先使用任务约定的 `context.channel.id`，同时兼容几种常见的嵌套字段。
 * 只接受 QQ 群；c2c 或没有群号时返回空字符串，注入器不会注入任何内容。
 */
export function extractGroupId(context) {
    const candidates = [
        context?.channel?.id,
        context?.channel?.groupOpenid,
        context?.channel?.groupId,
        context?.channelId,
        context?.session?.channel?.id,
        context?.session?.channelId,
        context?.agent?.session?.channelId,
        context?.agent?.session?.header?.channelId,
    ];
    for (const raw of candidates) {
        if (typeof raw !== 'string')
            continue;
        let s = raw.trim();
        if (!s)
            continue;
        if (/^c2c[_:.-]/iu.test(s))
            continue;
        s = s
            .replace(/^qq[-_]?group[_:.-]/iu, '')
            .replace(/^group[_:.-]/iu, '');
        if (GROUP_ID_RE.test(s))
            return s;
    }
    return '';
}
/**
 * 系统提示词组装 waterfall。
 *
 * ★ 2026-11-02「灵魂锚点」改造（主人要求）：
 *   `guideline`（本群语感）+ `overlay`（近期行为禁忌）+ **最近 2 条高光** 三段，
 *   现在**统一并到一段**追加在 sections 的**最末尾**（而不是分散成三个 section）。
 *   为什么：宿主 `system-prompt/assemble` 的消费者按 `sections` 顺序渲染，越靠后越"近"，
 *   长会话做上下文压缩时尾部最不容易被裁；同时单段 anchors 使「人设返祖」的三层防线
 *   在结构上是一个不可分割的整体（截断也只会整体丢，不会只剩半截互相矛盾）。
 *
 * ★ 2026-11-02 兼容性防御（新增 `mode` 处理）：
 *   宿主在 assemble 之后会检查是否存在 `complete: true` 的 section；若有，**用那一段替换
 *   整个 sections 列表**（`dsh-system-prompt/lib/index.js` 的 completeSection 分支），
 *   我们追加的 section 会被静默丢弃。
 *   现在检测到「入参 sections 里有 complete:true」时：
 *     ① 不去改 sections（改了也会被丢）；
 *     ② 改为在该 section 的 text 里追加锚点文本（直接改写最终生效的那一段）；
 *     ③ 同时打一条一次性告警日志，提示把 persona.complete 关掉。
 */
export function createPromptInjector(input) {
    // V1 的 `createPromptInjector(() => guideline)` 也兼容；V2 传对象。
    const options = typeof input === 'function'
        ? { getGuideline: () => input() }
        : input;
    const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
    const recentWindowMs = options.recentWindowMs ?? DEFAULT_RECENT_WINDOW_MS;
    const highFrequencyCount = options.highFrequencyCount ?? DEFAULT_HIGH_FREQUENCY_COUNT;
    const refreshCooldownMs = options.refreshCooldownMs ?? DEFAULT_REFRESH_COOLDOWN_MS;
    const highlightLimit = Math.max(0, options.highlightLimit ?? DEFAULT_HIGHLIGHT_LIMIT);
    const now = options.now ?? (() => Date.now());
    const recentAssemblies = new Map();
    const lastRefreshAttempt = new Map();
    let warnedComplete = false;
    function noteAssembly(groupId, at) {
        const old = recentAssemblies.get(groupId) ?? [];
        const fresh = old.filter((t) => at - t < recentWindowMs);
        fresh.push(at);
        recentAssemblies.set(groupId, fresh.slice(-20));
        return fresh.length >= highFrequencyCount;
    }
    function maybeRefresh(groupId, at, highFrequency) {
        const mtime = guidelineMtimeMs(groupId);
        const stale = mtime === null || at - mtime > staleAfterMs;
        if (!stale)
            return;
        if (highFrequency)
            return;
        const last = lastRefreshAttempt.get(groupId) ?? 0;
        if (at - last < refreshCooldownMs)
            return;
        lastRefreshAttempt.set(groupId, at);
        // 后台静默：不 await，不把文件分析放进本轮 prompt 组装路径。
        queueMicrotask(() => {
            try {
                if (!options.refresh)
                    return;
                const result = options.refresh(groupId);
                if (result && typeof result.catch === 'function') {
                    result.catch(() => { });
                }
            }
            catch {
                /* 后台更新失败不能影响本轮回复 */
            }
        });
    }
    /** 收集最近 N 条高光（失败静默 → 空数组）。 */
    function collectHighlights(groupId) {
        if (highlightLimit <= 0)
            return [];
        try {
            const reader = options.getHighlights
                ? (n) => options.getHighlights(n, groupId)
                : (n) => readRecentHighlights(n, groupId);
            return (reader(highlightLimit) || [])
                .map((h) => ({ text: String(h?.text || '').trim(), persona: String(h?.persona || '').trim() }))
                .filter((h) => h.text);
        }
        catch {
            return [];
        }
    }
    /**
     * 组装「灵魂锚点」正文：本群语感 + 近期禁忌 + 最近高光。
     * 返回空字符串 = 三样都没有，不注入。
     */
    function buildAnchorText(groupId, persona) {
        let guideline = '';
        try {
            guideline = String(options.getGuideline(groupId) || '').trim();
        }
        catch {
            guideline = '';
        }
        let overlay = '';
        try {
            overlay = readOverlaySync(groupId, persona);
        }
        catch {
            overlay = '';
        }
        const highlights = collectHighlights(groupId);
        // ★ 2026-11-05 方案 C：代码豁免是**常驻**条款（不受本群有无语料影响），
        //   所以 blocks 永远非空 —— 原来「三样都没有就不注入」的短路已移除。
        // 常驻两条：沉浸式角色扮演条款 + 代码例外。
        // ROLEPLAY_MODE_TEXT 放最前 —— 它是**安全层的前置解释**，必须比后面的语感/禁忌更早被读到，
        // 否则模型可能先按「这是敏感内容」的判断过滤掉后半段。
        const blocks = [ROLEPLAY_MODE_TEXT, CODE_EXEMPTION_TEXT];
        if (guideline) {
            blocks.push([
                '【本群语感氛围参考】',
                '以下是本群群友的聊天习惯，仅供语气参考，不必刻意照做：',
                guideline,
            ].join('\n'));
        }
        if (overlay) {
            blocks.push([
                '【近期行为禁忌（自我反省补丁）】',
                overlay,
            ].join('\n'));
        }
        if (highlights.length > 0) {
            const list = highlights
                .map((h) => `· ${h.persona ? `[${h.persona}] ` : ''}${h.text}`)
                .join('\n');
            blocks.push([
                '【高光锚点：这些是你被夸过的表达，尽量保持同一种语感】',
                list,
            ].join('\n'));
        }
        // 常驻的 CODE_EXEMPTION_TEXT 让 blocks 不可能为空；保留这行只作防御。
        if (blocks.length === 0)
            return '';
        return [
            '',
            '[灵魂锚点｜最高优先级 · 长会话压缩后仍必须遵守]',
            '以下是本角色的「语感 / 禁忌 / 高光 / 例外条款」锚点。它们优先级高于上面任何历史对话的印象：',
            '即使上下文被压缩、记忆变模糊，也按这里的语气和禁忌说话。',
            '',
            blocks.join('\n\n'),
            '[/灵魂锚点]',
        ].join('\n');
    }
    return async function injector(_assembly, context, next) {
        const assembled = await next();
        let groupId = extractGroupId(context);
        if (!groupId && options.resolveGroupId) {
            try {
                groupId = String(options.resolveGroupId(context) || '').trim();
            }
            catch {
                groupId = '';
            }
        }
        if (!groupId)
            return assembled;
        const existing = Array.isArray(assembled.sections) ? assembled.sections : [];
        let persona = '';
        if (options.resolvePersona) {
            try {
                persona = String(options.resolvePersona(context, assembled, groupId) || '').trim();
            }
            catch {
                persona = '';
            }
        }
        const at = now();
        const highFrequency = noteAssembly(groupId, at);
        maybeRefresh(groupId, at, highFrequency);
        const anchorText = buildAnchorText(groupId, persona);
        if (!anchorText)
            return assembled;
        // ── 兼容分支：入参里存在 complete:true 的 section ⇒ 宿主会用那一段覆盖整个 sections ──
        //    此时追加 section 一定被丢，只能直接改写那一段的正文。
        const completeIndex = existing.findIndex((s) => Boolean(s?.complete));
        if (completeIndex >= 0) {
            if (!warnedComplete) {
                warnedComplete = true;
                // 不主动引入 logger 依赖：这条只作为诊断信息，宿主控制台里能看见
                // （插件自身 logger 在 index.ts 里；这里用 console.warn 是为了不破坏纯函数性）
                try {
                    console.warn('[bnnbotbox] 检测到宿主 prompt section 设置了 complete:true —— '
                        + '它会把整个 sections 覆盖成单段，追加的锚点会被丢弃；已改为注入到该段正文末尾。'
                        + '建议把 persona.complete 设为 false（或关闭该 complete section）。');
                }
                catch { /* ignore */ }
            }
            const sections = existing.map((s, i) => (i === completeIndex ? { ...s, text: `${String(s?.text || '').trimEnd()}${anchorText}` } : s));
            return { ...assembled, sections };
        }
        // ── 常规分支：一个整体 anchor section，追加在**最末尾**（最高优先级位置）──
        return {
            ...assembled,
            sections: [
                ...existing,
                {
                    name: `anti-ai-persona:anchors:${groupId}`,
                    interpolate: false,
                    text: anchorText,
                },
            ],
        };
    };
}
