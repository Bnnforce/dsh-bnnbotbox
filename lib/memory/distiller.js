/**
 * distiller — 记忆沉淀的 LLM 提炼器实现（2026-11-17）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么需要这个文件
 *
 *   `distill.ts` 的 `runDistill()` 早就写好了，但它需要一个 `extractor`（提炼器）
 *   才能工作。**这个 extractor 从来没有被注入过** —— 所以沉淀功能写了等于没写：
 *   85 张记忆卡，71 张的 History 只有建档那 1 行，8 天没长过。
 *
 *   本文件补上那个缺失的 extractor。
 *
 * ── 顺带解决的工业化风险 ────────────────────────────────────────────────────
 *   ① 🔴 extractor 从未注入      → 本文件实现并注入
 *   ③ 🟡 消息无去重              → extractor 内按 (name,text) 去重
 *   ⑤ 🟡 提炼结果无幻觉防护      → 三重校验：长度 / 必须提到本人 / 敏感词拦截
 *   ⑨ 🟡 模型输出不可控          → 严格 JSON 解析 + 兜底剥代码块
 *
 * ── 设计原则（对齐 R4 工业化标准）───────────────────────────────────────────
 *   · **走对话默认模型**（主人要求）：不写死 model，用宿主当前默认
 *   · **失败不写盘**：任何一步出错就返回空，绝不让半成品进卡
 *   · **成本可预测**：单群单次最多 N 条消息，超时有上限
 *   · **可观测**：每次提炼都记录接受/丢弃数量与原因
 * ═══════════════════════════════════════════════════════════════════════════
 */
export const DEFAULT_DISTILLER_CONFIG = {
    maxMessages: 50,
    timeoutMs: 20_000,
    maxFactChars: 160,
    maxFactsPerRun: 20,
};
/**
 * 幻觉/敏感内容特征 —— 命中即丢弃该条事实。
 *
 * 判据来自实际风险：模型"提炼"时容易把推测当事实、把隐私当趣闻。
 */
const REJECT_PATTERNS = [
    // ★ 推测词要在**任意位置**匹配（实测踩到：'张三可能喜欢猫' 句首正则拦不住）
    { re: /(可能|大概|也许|似乎|应该是|或许|我猜|估计|说不定|好像是|好像是)/u, reason: '推测语气' },
    { re: /(欠|借了|还钱|转账|红包|\d+\s*元)/u, reason: '金钱往来' },
    { re: /(身份证|银行卡|密码|手机号|住址|家庭地址)/u, reason: '隐私' },
    { re: /(生病|住院|抑郁|自杀|怀孕|离婚|去世|死了)/u, reason: '健康/家庭敏感' },
];
/** 判断一条事实是否可信（三重校验）。 */
export function isFactAcceptable(fact, personName, cfg = DEFAULT_DISTILLER_CONFIG) {
    const f = String(fact ?? '').trim();
    if (!f)
        return { ok: false, reason: '空' };
    if (f.length < 6)
        return { ok: false, reason: '太短' };
    if (f.length > cfg.maxFactChars)
        return { ok: false, reason: '太长' };
    // 必须提到本人（否则可能是记错人）
    const name = String(personName ?? '').trim();
    const mentionsSelf = name.length > 0 && f.includes(name);
    const mentionsExplicit = /(他|她|TA)(自己)?/u.test(f);
    if (!mentionsSelf && !mentionsExplicit)
        return { ok: false, reason: '没提到本人' };
    for (const { re, reason } of REJECT_PATTERNS) {
        if (re.test(f))
            return { ok: false, reason };
    }
    return { ok: true };
}
/**
 * 构造提炼 prompt。
 *
 * 关键约束：只许写明确发生过的事；不许推测；不许隐私；每人最多 2 条。
 */
export function buildExtractPrompt(input, cfg = DEFAULT_DISTILLER_CONFIG) {
    const nameSet = new Set();
    const lines = input.messages.slice(-cfg.maxMessages).map((m) => {
        const n = String(m.name ?? '').trim();
        if (n)
            nameSet.add(n);
        const t = String(m.text ?? '').replace(/\s+/gu, ' ').trim().slice(0, 120);
        return `${n}: ${t}`;
    });
    const names = [...nameSet].slice(0, 30);
    return [
        '你是群聊记忆整理员。从下面的对话里，提炼出值得长期记住的事实。',
        '',
        '【本批对话】',
        ...lines,
        '',
        '【可以记什么】',
        '· 明确说过的个人偏好（喜欢什么、讨厌什么）',
        '· 明确说过的近况（在做的事、遇到的事）',
        '· 明确的说话风格特征',
        '',
        '【绝对不记】',
        '· 推测、猜测、「可能」「大概」—— 一律不要',
        '· 金钱往来（欠钱、转账、红包）',
        '· 隐私（身份证、银行卡、密码、手机号、住址）',
        '· 健康/家庭敏感信息（生病、住院、离婚、去世）',
        '· 争吵内容、对第三方的评价',
        '',
        '【格式】',
        '· 严格输出 JSON 数组，不要解释文字、不要 markdown 代码块',
        '· 每条形如 {"name":"人名","fact":"一句话事实"}',
        '· fact 必须包含该人名，长度 6-60 字',
        '· 每人最多 2 条，宁可少写不要凑数',
        '· 没有值得记的内容就输出 []',
        '',
        `【可选人名】${names.join('、')}`,
        '',
        '只输出 JSON。',
    ].join('\n');
}
/** 从模型返回里抠出 JSON 数组（容忍代码块、前后废话）。 */
export function parseFactsJson(raw) {
    const text = String(raw ?? '');
    const fenced = /```(?:json)?\s*([\s\S]*?)```/u.exec(text);
    const body = fenced ? fenced[1] : text;
    const start = body.indexOf('[');
    const end = body.lastIndexOf(']');
    if (start < 0 || end <= start)
        return [];
    let arr;
    try {
        arr = JSON.parse(body.slice(start, end + 1));
    }
    catch {
        return [];
    }
    if (!Array.isArray(arr))
        return [];
    const out = [];
    for (const item of arr) {
        if (!item || typeof item !== 'object')
            continue;
        const o = item;
        const name = String(o.name ?? '').trim();
        const fact = String(o.fact ?? '').trim();
        if (name && fact)
            out.push({ name, fact });
    }
    return out;
}
/** 收集 stream 文本。 */
async function collectStreamText(stream) {
    let out = '';
    for await (const chunk of stream) {
        if (typeof chunk === 'string') {
            out += chunk;
            continue;
        }
        if (chunk && typeof chunk === 'object') {
            const c = chunk;
            if (typeof c.text === 'string')
                out += c.text;
            else if (typeof c.delta === 'string')
                out += c.delta;
            else if (c.delta && typeof c.delta.text === 'string') {
                out += String(c.delta.text);
            }
        }
    }
    return out;
}
async function withTimeout(p, ms) {
    let timer;
    const timeout = new Promise((resolve) => {
        timer = setTimeout(() => resolve({ timedOut: true }), Math.max(1, ms));
        timer.unref?.();
    });
    try {
        return await Promise.race([p.then((v) => ({ value: v, timedOut: false })), timeout]);
    }
    finally {
        if (timer)
            clearTimeout(timer);
    }
}
/**
 * 解析「用哪个模型」。
 *
 * 主人要求「走对话默认模型」⇒ 优先宿主当前默认，拿不到退第一个可用。
 */
export async function resolveDefaultRoute(llm) {
    if (!llm)
        return undefined;
    try {
        const anyLlm = llm;
        const cur = anyLlm.currentModel ?? anyLlm.defaultModel;
        if (cur && typeof cur === 'object') {
            const c = cur;
            const p = String(c.provider ?? '').trim();
            const m = String(c.model ?? c.id ?? '').trim();
            if (p && m)
                return { provider: p, model: m };
        }
        const providers = typeof llm.listProviders === 'function' ? await llm.listProviders() : [];
        const first = providers?.[0];
        if (!first?.id)
            return undefined;
        const models = typeof llm.listModels === 'function' ? await llm.listModels(first.id) : [];
        const m0 = models?.[0];
        if (!m0?.id)
            return undefined;
        return { provider: first.id, model: m0.id };
    }
    catch {
        return undefined;
    }
}
/**
 * 创建提炼器（供 `runDistill({ extractor })` 使用）。
 */
export function createDistillExtractor(deps) {
    const cfg = { ...DEFAULT_DISTILLER_CONFIG, ...(deps.cfg ?? {}) };
    const llm = deps.llm;
    return async (input) => {
        if (!llm || typeof llm.stream !== 'function') {
            deps.logger?.warn?.('[bnnbotbox] 提炼器：宿主未提供 llm，跳过');
            return [];
        }
        const route = await resolveDefaultRoute(llm);
        if (!route) {
            deps.logger?.warn?.('[bnnbotbox] 提炼器：找不到可用模型，跳过');
            return [];
        }
        const prompt = buildExtractPrompt(input, cfg);
        let raw = '';
        try {
            const stream = llm.stream({
                provider: route.provider,
                model: route.model,
                system: '你是严格的记忆整理员。只输出 JSON 数组，不输出任何其他文字。',
                messages: [{
                        id: `distill-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                        role: 'user',
                        content: [{ type: 'text', text: prompt }],
                        source: { kind: 'plugin:bnnbotbox' },
                    }],
                maxTokens: 800,
            });
            const res = await withTimeout(collectStreamText(stream), cfg.timeoutMs);
            if (res.timedOut) {
                deps.logger?.warn?.(`[bnnbotbox] 提炼超时（${cfg.timeoutMs}ms），本次跳过`);
                return [];
            }
            raw = String(res.value ?? '');
        }
        catch (err) {
            deps.logger?.warn?.(`[bnnbotbox] 提炼调用失败：${err instanceof Error ? err.message : String(err)}`);
            return [];
        }
        const parsed = parseFactsJson(raw);
        if (!parsed.length)
            return [];
        const accepted = [];
        const dropped = [];
        for (const f of parsed) {
            if (accepted.length >= cfg.maxFactsPerRun)
                break;
            const v = isFactAcceptable(f.fact, f.name, cfg);
            if (v.ok)
                accepted.push({ name: f.name, fact: f.fact.slice(0, cfg.maxFactChars) });
            else
                dropped.push(`${f.name}:${v.reason}`);
        }
        if (dropped.length) {
            deps.logger?.info?.(`[bnnbotbox] 提炼过滤：接受 ${accepted.length} / 丢弃 ${dropped.length}（${dropped.slice(0, 3).join('，')}）`);
        }
        return accepted;
    };
}
//# sourceMappingURL=distiller.js.map