/**
 * r4/outbound — 出站正文装饰（小脾气前缀）
 *
 * 从 `r4/index.ts` 拆出（重构阶段 2 / 批次 C）。
 * 宿主在**真正发消息之前**调用 `decorateOutgoingText`。
 */

import { sanitizeId } from './paths.js';
import { logInfo, logWarn, type R4Logger } from './logger.js';
import { readHeartbeat, writeHeartbeat } from './state.js';
import { shouldInjectSulk, withSulkPrefix, clearCold } from './sulk.js';

/**
 * 给一条**即将发出**的正文加小脾气前缀（2026-11-03 修复 P1-7）。
 *
 * 图纸 2.1 最后一条：`cooldown 到期后第一次正常回复 → 强制注入一次小脾气前缀，随后清除 cold`，
 * 且「不依赖模型是否主动生成『哼』」。原先 `sulk.ts` 只有纯函数、**从未被接线**，
 * 现在把它收成一个对宿主暴露的单一入口：
 *
 * 1. 读心跳状态 → `shouldInjectSulk`（内部已做 24h 兜底）；
 * 2. 需要注入 → `withSulkPrefix` 拼前缀（幂等：正文已以「哼」开头则不重复）；
 * 3. 注入成功 → `clearCold` 原子写回（**先写盘再返回**，避免重启后重复注入）。
 *
 * @returns `{ text, injected }`；不需要注入/任何异常 → 原样返回 `{ text, injected: false }`。
 */
export function decorateOutgoingText(input: {
  groupId: string;
  text: string;
  root: string;
  logger?: R4Logger;
  now?: number;
}): { text: string; injected: boolean } {
  const { groupId, text, root, logger } = input;
  const body = String(text ?? '');
  if (!body.trim()) return { text: body, injected: false };
  const gid = sanitizeId(groupId);
  if (!gid) return { text: body, injected: false };
  try {
    const now = input.now ?? Date.now();
    const state = readHeartbeat(gid, root, logger);
    if (!shouldInjectSulk(state, now)) return { text: body, injected: false };
    const decorated = withSulkPrefix(body);
    // 先落盘再返回：写失败也照样把前缀用上（下次可能重复，但内容正确优先）。
    writeHeartbeat(gid, clearCold(state), root, logger);
    logInfo(logger, `[r4] 小脾气前缀已注入（${gid}）并清除 cold`);
    return { text: decorated, injected: true };
  } catch (error) {
    logWarn(logger, `[r4] 小脾气前缀失败（已跳过）：${error instanceof Error ? error.message : String(error)}`);
    return { text: body, injected: false };
  }
}
