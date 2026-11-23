/**
 * review-detect — 会话事件的语料判定与文本提取
 *
 * 从 `review.ts` 拆出（重构阶段 2 / 批次 A）。
 * 职责单一：判断「这条消息算不算吐槽/真人消息」，以及从 DSH 的 session event 里抠纯文本。
 * 无任何 IO、无状态，可被单测直接喂假事件。
 */
export const CORRECTION_TRIGGERS = [
    '太长不看', '说人话', '像AI', '像ai', '太啰嗦', '串台了', '重说',
];
const CORRECTION_RE = /太长不看|说人话|像\s*ai|太啰嗦|串台了|重说/iu;
export function isCorrectionText(text) {
    return CORRECTION_RE.test(String(text || ''));
}
function blocksText(content) {
    if (typeof content === 'string')
        return content;
    if (!Array.isArray(content))
        return '';
    const parts = [];
    for (const block of content) {
        if (typeof block !== 'object' || block === null)
            continue;
        const b = block;
        if (b.type === 'text' && typeof b.text === 'string')
            parts.push(b.text);
    }
    return parts.join(' ').trim();
}
/** 从 session/event 的 message 或 data.content 里抽纯文本。 */
export function eventText(event) {
    const data = event?.data;
    if (!data || typeof data !== 'object')
        return '';
    return blocksText(data.message?.content ?? data.content);
}
export function isRealUserMessage(event) {
    if (event?.type !== 'user/message')
        return false;
    const source = event?.data?.source;
    return source === undefined || source?.kind === 'user';
}
