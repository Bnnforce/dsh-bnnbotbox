/**
 * tasks/shared — 多个后台任务共用的极小工具集（重构阶段 2）
 *
 * 为什么需要：生活流（`tasks/life-stream.ts`）与主动惦记（仍在 maintenance-tasks.ts）
 * 都要「取群最近对话」和「定位 qqbot 数据根」以及同一个 outbox 目录名。
 * 若让其中一个依赖另一个，就是反向耦合；所以抽到本模块，两边都只依赖它。
 */
import { personaDataRoot } from '../r4/paths.js';
import { readRecentMessages } from '../r4/sample.js';
/** 主动开口类消息的 outbox 目录名（生活流 + 主动惦记共用，桥会消费）。 */
export const OPEN_OUTBOX_DIR = 'heartbeat-outbox';
/** 取 qqbot 数据根（显式传入优先，兜底空串）。 */
export function qqbotRootOf(raw) {
    return String(raw ?? '').trim();
}
/**
 * 取最近几条群聊文本（仅作语感参考，prompt 里明令禁止接话）。
 *
 * 与原 `maintenance-tasks.ts` 的实现**逐字一致**（withinMs 2 小时、过滤 self、
 * `${senderName ?? senderId}: ${text}` 格式）。搬迁不改行为。
 */
export function recentChatOf(opts, groupId, limit, now) {
    try {
        const msgs = readRecentMessages('group', groupId, {
            qqbotDataRoot: qqbotRootOf(opts.qqbotDataRoot),
            root: personaDataRoot(),
            withinMs: 2 * 60 * 60 * 1000,
            now,
        });
        return (msgs ?? [])
            .filter((m) => !m?.self)
            .slice(-limit)
            .map((m) => `${String(m?.senderName ?? m?.senderId ?? '')}: ${String(m?.text ?? '')}`)
            .join('\n')
            .trim();
    }
    catch {
        return '';
    }
}
