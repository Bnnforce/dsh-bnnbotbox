/**
 * R4.0 图纸 2.1 最后一条：**cooldown 到期后第一次正常回复 → 强制注入一次小脾气前缀**。
 *
 * ```text
 * cooldown 到期后第一次正常回复
 *   → 强制注入一次小脾气前缀（如“哼，刚才没人理我”），随后清除 cold
 *   → 不依赖模型是否主动生成“哼”
 *   → 若该轮因其他原因跳过回复，cold 继续保留，直到下一次正常回复或 24h 兜底
 * ```
 *
 * 「不依赖模型」是关键：**前缀由本地拼接**，不靠模型自觉。
 *
 * 本文件独立于 `heartbeat.ts`（模块二只做状态迁移，不产出对话文本）。
 */
import { enforceColdExpiry } from './heartbeat.js';
/** 小脾气前缀文案（图纸示例：「哼，刚才没人理我」）。 */
export const SULK_PREFIX = '哼，刚才没人理我';
/** 是否该在这轮正常回复里注入小脾气前缀。 */
export function shouldInjectSulk(state, now) {
    try {
        const afterExpiry = enforceColdExpiry(state, now, 24);
        if (!afterExpiry.cold)
            return false;
        // 「cooldown 到期后」= 已回到 normal（cooldown 状态还没到期，不注入）
        return afterExpiry.state === 'normal';
    }
    catch {
        return false;
    }
}
/**
 * 给要发出去的正文加上小脾气前缀。
 * 幂等：已经以「哼」起头的短句不重复加（避免模型自己说了「哼」还再加一遍）。
 */
export function withSulkPrefix(text) {
    const body = String(text ?? '').trim();
    if (!body)
        return body;
    if (/^(哼|嗯哼)/u.test(body))
        return body;
    return `${SULK_PREFIX}。${body}`;
}
/** 注入后清除 cold（「随后清除 cold」）。 */
export function clearCold(state) {
    return { ...state, cold: false, coldSetAt: 0 };
}
/**
 * 「这一轮因其他原因跳过回复」→ **cold 继续保留**。
 * 本函数只是把这件事显式化（不改状态），便于调用方读起来自证。
 */
export function keepColdWhenSkipped(state) {
    return { ...state };
}
