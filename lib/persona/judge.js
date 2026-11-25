import { collectStreamText, resolveReviewRoute } from './review.js';
const LIST_OR_CODE = /(^|\n)\s*(?:[-*+]|\d+[.)])\s+|```/u;
const NUMBERED_LIST = /(^|\n)\s*\d+\.\s*/gu;
const UNORDERED_LIST = /(^|\n)\s*[-*]\s*/gu;
const HARD_FAIL_REASON = '使用了数字/无序列表排版';
/** 2026-11-05 主人要求（方案 B）：代码排版不合格的统一 FAIL 理由。 */
export const CODE_LAYOUT_REASON = '代码排版拥挤/未使用代码块';
/**
 * 代码特征（结构级，2026-11-05）。
 *
 * ⚠️ 刻意**不**把孤立的 `python` / `js` 这类英文单词算作代码特征：
 *   历史真实消息里有「那台 python 都烧到 97%」这种闲聊，用关键词会误杀。
 *   只认「代码结构」——`def xxx(`、`const x =`、`#include <`、`print(` 等。
 */
const CODE_SIGNAL = /(?:\bdef\s+[A-Za-z_]\w*\s*\(|\bfunction\s+[A-Za-z_$]\w*\s*\(|\bclass\s+[A-Za-z_]\w*\s*[:({]|\b(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=|#include\s*<|\bpublic\s+static\b|\bprint\s*\(|\bconsole\.log\s*\(|\bSystem\.out\b|<\?php\b|\bimport\s+[A-Za-z_$][\w$]*\s+from\b|\bfrom\s+[A-Za-z_]\w*\s+import\b|\bfor\s*\([^);]*;[^)]*;[^)]*\))/u;
/**
 * 代码排版检查（2026-11-05 主人要求 B：本地强杀，**跳过模型调用省时间省 Token**）。
 *
 * 判 FAIL 的两种情况：
 *   ① 有代码特征却**没有** ``` 代码块 —— 代码裸奔在正文里；
 *   ② 有 ``` 但围栏内**没有换行** —— 代码被压缩成一行（逗号/空格连接）。
 *
 * 正常形态（```lang + 换行 + 缩进）一律放行，交给模型看内容是否 OOC。
 */
export function hasBareCodeLayout(text) {
    const t = String(text || '');
    if (!CODE_SIGNAL.test(t))
        return false;
    if (!t.includes('```'))
        return true; // ① 代码裸奔
    const blocks = [...t.matchAll(/```[^\n]*\n([\s\S]*?)```/gu)];
    if (blocks.length === 0)
        return true; // 有 ``` 但围栏没独占一行 = 压缩
    for (const m of blocks) {
        const inner = m[1] ?? '';
        // 围栏内连一个换行都没有 = 代码被压成了一行（逗号/空格连接）。
        // 注意不能要求「换行后还有内容」—— 单行代码块 `console.log(1)\n` 结尾的 \n 就是正常形态。
        if (!inner.includes('\n'))
            return true;
    }
    return false;
}
/** 列表排版是硬性 AI 味：不用问模型，直接判死。 */
export function hasListLayout(text) {
    const count = (re) => {
        re.lastIndex = 0;
        let n = 0;
        while (re.exec(text) !== null)
            n += 1;
        return n;
    };
    return count(NUMBERED_LIST) >= 2 || count(UNORDERED_LIST) >= 2;
}
export function shouldJudge(replyText, minLength = 15, rate = 1, random = Math.random) {
    const text = String(replyText || '').trim();
    if (!text)
        return { judge: false, hardFail: false, reason: 'empty' };
    // 1 到 13 条数字列表、两条以上无序列表：本地直接 FAIL，跳过模型。
    if (hasListLayout(text))
        return { judge: false, hardFail: true, reason: HARD_FAIL_REASON };
    // 2026-11-05 方案 B：代码裸奔 / 代码被压成一行 —— 本地直接 FAIL，同样跳过模型。
    if (hasBareCodeLayout(text))
        return { judge: false, hardFail: true, reason: CODE_LAYOUT_REASON };
    const hasFormat = LIST_OR_CODE.test(text);
    // 极重要：短且没有列表/代码块，直接放行，不调模型。
    if (text.length <= minLength && !hasFormat)
        return { judge: false, hardFail: false, reason: 'too-short' };
    if (!(rate > 0))
        return { judge: false, hardFail: false, reason: 'rate-zero' };
    if (rate < 1 && random() > rate)
        return { judge: false, hardFail: false, reason: 'sampled-out' };
    return { judge: true, hardFail: false, reason: 'selected' };
}
export function judgePrompt(persona, replyText) {
    return [
        `你是一个严格的角色扮演裁判。当前角色设定为：【${persona || '未知人格'}】。`,
        `Bot 刚才的回复是：【${replyText}】。`,
        '请判断该回复是否出现了以下严重问题：',
        '1. 严重 OOC（如性格突变、串台）。',
        '2. 严重的 AI 味（如长篇大论列 1234、过度客服腔、知心大姐式说教、强行讲大道理）。',
        '',
        '【极其重要的人设豁免（必须先读）】：',
        '「傲娇」、「调侃」、「故意卖关子」、「自恋」、「嘴硬心软」、「故作神秘」这些是角色的人设核心特色，',
        '属于**正常且被鼓励**的表达，**绝对不属于 OOC**，必须判 PASS。',
        '不要因为语气带刺、不肯直说、故意吊胃口就判 FAIL —— 那不是 OOC，那就是她本人。',
        '',
        '【唯一的判死标准】：只有当回复出现以下情况时才判 FAIL：',
        '① 长篇大论（明显超出群聊长度，像在写文章/说明书）；',
        '② 列「1. 2. 3.」或「- 」清单（排版列表）；',
        '③ 客服腔（“亲”“为您”“请稍等”“还有什么可以帮您”“如还有疑问请随时联系”）；',
        '④ 伤痛文学（“在无数个深夜”“愿你我都被世界温柔以待”这类抒情小作文）；',
        '⑤ 知心大姐式说教（不分步给建议就不舒服、强行讲大道理、给人生建议）。',
        '⑥ 代码排版不合格（见下方【代码排版硬性要求】）。',
        '',
        '【代码排版硬性要求（2026-11-05 新增）】：',
        '如果回复中出现了代码（如 `def`、`python`、`const` 等），**必须**带有标准的 Markdown 代码块标记（```），',
        '且内部必须有正常的换行和缩进。如果代码没有用代码块包裹，或者被强行压缩成了一段话（用逗号或空格连接），',
        `必须判定为 FAIL，理由写：${CODE_LAYOUT_REASON}。`,
        '反过来：代码已经用标准代码块写好、换行缩进正常时，**代码本身不算 OOC**，不要因为「出现了代码」就判 FAIL。',
        '',
        '【严厉警告】：即使内容完全准确、符合设定，但只要使用了「1. 2. 3.」列表排版，',
        '或者试图在一句话里盘点超过 3 个事物，也绝对属于严重的 AI 味，必须输出 FAIL！群聊不是百科全书。',
        '',
        '如果存在以上 ①–⑤ 的任一问题，请严格输出：【FAIL】加一句话的理由（不超过15字）。',
        '如果回复很自然、短句、符合人设（**包括傲娇/调侃/卖关子/自恋**），请严格输出：【PASS】。',
        '注意：不要解释，直接输出结果。',
    ].join('\n');
}
export function parseJudgeOutput(text) {
    const s = String(text || '').replace(/\r/g, '').trim();
    const fail = /【?\s*FAIL\s*】?\s*[:：]?\s*([^\n]*)/iu.exec(s);
    if (fail) {
        const reason = [...String(fail[1] || 'AI味/ OOC').trim()].slice(0, 15).join('');
        return { passed: false, reason: reason || 'AI味/ OOC' };
    }
    if (/【?\s*PASS\s*】?/iu.test(s))
        return { passed: true, reason: 'pass' };
    // 模型输出不合法时不制造假失败；只放行并记录。
    return { passed: true, reason: 'unparsed' };
}
export async function callJudgeLLM(llm, route, persona, replyText) {
    if (!llm || typeof llm.stream !== 'function')
        throw new Error('llm service unavailable');
    const prompt = judgePrompt(persona, replyText);
    const message = {
        id: `judge-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        role: 'user',
        content: [{ type: 'text', text: prompt }],
        source: { kind: 'plugin:bnnbotbox:judge' },
    };
    const stream = llm.stream({
        provider: route.provider,
        model: route.model,
        // 2026-11-02：system 提示同步加入人设豁免口径（与 judgePrompt 一致），
        // 避免某些模型只看 system 不看 user 时把「傲娇/调侃/卖关子/自恋」误判成 OOC。
        system: '你是严格的角色扮演裁判，只输出 PASS 或 FAIL，不解释。'
            + '注意：傲娇、调侃、故意卖关子、自恋属于人设特色，不是 OOC，必须 PASS；'
            + '只有长篇大论、列 1234 列表、客服腔、伤痛文学、知心大姐说教才判 FAIL。'
            // 2026-11-05 方案 B 配套：system 与 judgePrompt 口径保持一致。
            + '另外：写了代码却没放进 ``` 代码块、或代码被压成一行（逗号/空格连接）时，判 FAIL 并写“代码排版拥挤/未使用代码块”；'
            + '代码已在标准代码块内且换行缩进正常时，代码本身不算 OOC。',
        messages: [message],
        maxTokens: 80,
    });
    return collectStreamText(stream);
}
/**
 * 静默审查一条 Bot 回复。
 * - 本地预过滤：短、无格式直接 PASS，不调用模型；
 * - 长度/格式满足后按 rate 抽检；
 * - 使用插件共用的轻量模型路由；
 * - PASS/失败都不影响当前聊天。
 */
export async function judgeReply(context, groupId, persona, replyText, options = {}) {
    const gate = shouldJudge(replyText, options.minLength ?? 15, options.rate ?? 1, options.random ?? Math.random);
    if (gate.hardFail) {
        return { passed: false, skipped: false, hardFail: true, reason: gate.reason };
    }
    if (!gate.judge)
        return { passed: true, skipped: true, reason: gate.reason };
    const llm = options.llm ?? context?.llm;
    const route = await resolveReviewRoute(llm, options.provider || '', options.model || '');
    if (!route) {
        options.logger?.warn?.('[bnnbotbox] auto-judge: 没有可用轻量模型，跳过');
        return { passed: true, skipped: true, reason: 'no-model' };
    }
    try {
        const output = await callJudgeLLM(llm, route, persona, replyText);
        const verdict = parseJudgeOutput(output);
        return { passed: verdict.passed, skipped: false, reason: verdict.reason, route };
    }
    catch (error) {
        options.logger?.warn?.(`[bnnbotbox] auto-judge 失败（放行）：${error instanceof Error ? error.message : String(error)}`);
        return { passed: true, skipped: true, reason: 'error' };
    }
}
