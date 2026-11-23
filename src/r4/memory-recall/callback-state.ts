/**
 * 记忆联想 · 第二层「主动惦记」—— **状态持久化层**
 *
 * 分工（与生活流保持同一套规矩）：
 *   · `callback.ts`        = 纯函数（判据 / 闸门 / prompt，无 IO）
 *   · **本文件**            = 读盘 / 写盘（所有失败降级，**绝不抛**）
 *
 * 数据落点（`开发规则` 二.2）：
 *   `{PERSONA_DATA_ROOT}/state/memory-callback.json`
 *
 * 原子写：走 `atomic.ts` 的 `writeJsonAtomic`（本文件不自己写文件操作）。
 */

import { join } from 'node:path';

import { readJsonSafe, writeJsonAtomic } from '../atomic.js';
import { logWarn, type R4Logger } from '../logger.js';
import { stateDir } from '../paths.js';
import { EMPTY_CALLBACK_STATE, normalizeCallbackState, type MemoryCallbackState } from './callback.js';

/** `state/memory-callback.json` 的绝对路径。 */
export function callbackStatePath(root: string): string {
  return join(stateDir(root), 'memory-callback.json');
}

/** 读状态；缺失 / 损坏 → 空状态（不抛）。 */
export function readCallbackState(root: string, logger?: R4Logger): MemoryCallbackState {
  try {
    const raw = readJsonSafe<unknown>(callbackStatePath(root));
    if (raw === undefined) return { ...EMPTY_CALLBACK_STATE, used: {}, levels: {} };
    return normalizeCallbackState(raw);
  } catch (error) {
    logWarn(
      logger,
      `[r4] 惦记：读状态失败（已降级为默认值）：${error instanceof Error ? error.message : String(error)}`,
    );
    return { ...EMPTY_CALLBACK_STATE, used: {}, levels: {} };
  }
}

/** 原子写状态；失败 → warn + false（不抛）。 */
export function writeCallbackState(
  state: MemoryCallbackState,
  root: string,
  logger?: R4Logger,
): boolean {
  try {
    return writeJsonAtomic(callbackStatePath(root), state, logger);
  } catch (error) {
    logWarn(
      logger,
      `[r4] 惦记：写状态失败（本次不生效）：${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}
