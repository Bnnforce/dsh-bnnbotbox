function clip(text, max) {
    const s = String(text || '').replace(/\s+/gu, ' ').trim();
    return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}
export const REVIEW_SYSTEM = [
    '你是一个 AI 调教专家。',
    '下面是过去 24 小时群友对机器人回复的吐槽（反面教材）。',
    '请总结机器人回复时的「避坑指南」，最多 3 条。',
    '请将你总结的避坑指南控制在 3 条以内，每条尽量精炼，最长不要超过 40 个字，必须是一句完整的话。',
    '要求：简短、具体、直接针对语气和长度；每条一行，格式必须是：- xxx。',
    '不要解释，不要编号，不要额外标题。',
].join('\n');
export function buildReviewPrompt(records, chatTexts = []) {
    const cases = records.slice(-12).map((r, i) => {
        const group = r.groupId ? `群 ${r.groupId}` : 'QQ 群';
        const persona = r.persona ? `｜人格 ${r.persona}` : '';
        const who = r.source === 'judge' ? '自动判官' : '群友吐槽';
        return [
            `【反面教材 ${i + 1}｜${group}${persona}】`,
            `${who}：${clip(r.userText, 180)}`,
            `Bot 上一条：${clip(r.assistantText, 320)}`,
        ].join('\n');
    });
    const normal = chatTexts.slice(-20).map((t) => `- ${clip(t, 100)}`).join('\n');
    return [
        '最近群友的吐槽：',
        cases.join('\n\n') || '(无)',
        '',
        normal ? `这段群的普通聊天，用于参考语气：\n${normal}` : '',
        '',
        '请只输出最多 3 条避坑指南，每条尽量精炼，最长不要超过 40 个字，必须是一句完整的话，以“- ”开头：',
    ].filter(Boolean).join('\n');
}
export function parseReviewOutput(text) {
    const lines = String(text || '').split('\n');
    const bullets = [];
    for (const line of lines) {
        const m = /^\s*(?:[-*•]|\d+[.、)])\s+(.+?)\s*$/u.exec(line);
        if (!m)
            continue;
        const item = m[1].replace(/^["“]|["”]$/gu, '').trim();
        if (item)
            bullets.push(item);
        if (bullets.length >= 3)
            return bullets;
    }
    if (bullets.length > 0)
        return bullets.slice(0, 3);
    // 容忍模型漏了符号：取非空、非标题的前三行；单独一行太像解释，不接收。
    const fallback = lines
        .map((l) => l.trim())
        .filter((l) => l && !/^#{1,6}\s/u.test(l) && !/^[-*•]\s*/u.test(l))
        .slice(0, 3);
    return fallback.length >= 2 ? fallback : [];
}
/**
 * 低阶模型选择：
 * 1. 配置指定 provider/model；
 * 2. 否则从已注册 provider 的模型里挑 flash/lite/mini/small/fast/turbo/nano；
 * 3. 找不到就返回 undefined，不偷偷改用昂贵默认模型。
 */
export async function resolveReviewRoute(llm, configuredProvider = '', configuredModel = '') {
    if (configuredProvider && configuredModel)
        return { provider: configuredProvider, model: configuredModel };
    try {
        if (!llm || typeof llm.listProviders !== 'function')
            return undefined;
        const providers = llm.listProviders();
        for (const provider of providers) {
            if (!provider || typeof provider.id !== 'string')
                continue;
            if (configuredProvider && provider.id !== configuredProvider)
                continue;
            const models = typeof llm.listModels === 'function' ? await llm.listModels(provider.id) : [];
            for (const model of Array.isArray(models) ? models : []) {
                const id = typeof model?.id === 'string' ? model.id : '';
                const name = typeof model?.name === 'string' ? model.name : '';
                if (configuredModel && id !== configuredModel)
                    continue;
                if (configuredModel || /(flash|lite|mini|small|fast|turbo|nano)/iu.test(`${id} ${name}`)) {
                    return { provider: provider.id, model: id };
                }
            }
        }
    }
    catch { /* fall through */ }
    return undefined;
}
export function collectStreamText(stream) {
    return (async () => {
        let text = '';
        for await (const chunk of stream) {
            if (chunk?.type === 'text-delta' && typeof chunk.text === 'string')
                text += chunk.text;
            if (chunk?.type === 'finish' && chunk.reason?.kind === 'error') {
                const failure = chunk.reason?.failure;
                throw new Error(`review llm failed: ${failure?.message ?? failure?.code ?? 'unknown'}`);
            }
            if (chunk?.type === 'finish' && chunk.reason?.kind === 'aborted') {
                throw new Error('review llm aborted');
            }
        }
        return text.trim();
    })();
}
export async function callReviewLLM(llm, route, prompt) {
    if (!llm || typeof llm.stream !== 'function')
        throw new Error('llm service unavailable');
    const message = {
        id: `review-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        role: 'user',
        content: [{ type: 'text', text: prompt }],
        source: { kind: 'plugin:bnnbotbox' },
    };
    const stream = llm.stream({
        provider: route.provider,
        model: route.model,
        system: REVIEW_SYSTEM,
        messages: [message],
        maxTokens: 512,
    });
    return collectStreamText(stream);
}
