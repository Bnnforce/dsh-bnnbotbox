/**
 * R4.0 原子写与读（阶段一基建）。
 *
 * 红线（施工图纸 0.2）：
 *  - 所有写操作：**同目录建临时文件 → fsync → fs.rename 覆盖**；
 *  - `rename` 失败必须清理临时文件并 warn，不得残留 `.tmp`；
 *  - 写失败 warn 后跳过，**不重试**；
 *  - 所有读操作包 try-catch：配置缺失 → 默认值 + warn；状态/画像/字典缺失 → 跳过该功能 + warn；
 *    **绝不阻塞主聊天，绝不抛到顶层**。
 *
 * 2026-11-03 修复（R4 体检 P2-1 / P2-2）：
 *  - `writeTextAtomic` 增加 `fsync`（文件句柄 + 目录句柄），掉电窗口内不再可能留下半截文件；
 *  - 新增 `mutateJsonAtomic`：**读-改-写在同一同步原子段内完成**，
 *    避免「await 之后拿旧快照整份写回」覆盖别处更新（scheduler 回滚 / lastMentionedTags 丢更新）。
 *    r4 的 IO 全是同步的，Node 单线程下「同步读 + 同步写」本身即不可分割，
 *    因此不引入异步锁（会破坏纯同步调用点），只把「读改写」收成一个入口。
 */

import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { logWarn, type R4Logger } from './logger.js';

/** 原子写 JSON（缩进 2）。失败：清临时文件 + warn，返回 false。 */
export function writeJsonAtomic(path: string, value: unknown, logger?: R4Logger): boolean {
  let text: string;
  try {
    text = `${JSON.stringify(value, null, 2)}\n`;
  } catch (error) {
    // 循环引用等序列化失败不得抛到调用方。
    logWarn(logger, `[r4] 原子写序列化失败（已跳过）：${path}：${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
  return writeTextAtomic(path, text, logger);
}

/** 尽可能 fsync 一个目录（让 rename 本身落盘；不支持的平台静默忽略）。 */
function fsyncDirSync(dir: string): void {
  let fd = -1;
  try {
    fd = openSync(dir, 'r');
    fsyncSync(fd);
  } catch {
    /* 目录 fsync 在部分平台/文件系统不支持，忽略（Windows 一直如此） */
  } finally {
    if (fd >= 0) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
  }
}

/** 原子写文本。失败：清临时文件 + warn，返回 false。 */
export function writeTextAtomic(path: string, text: string, logger?: R4Logger): boolean {
  if (!path) {
    logWarn(logger, '[r4] 原子写：路径为空（已跳过）');
    return false;
  }
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  let handle: number | undefined;
  try {
    const dir = dirname(path);
    mkdirSync(dir, { recursive: true });
    // 用 open+write+fsync 而不是 writeFileSync：确保内容先落盘再 rename。
    handle = openSync(tmp, 'w');
    writeSync(handle, String(text ?? ''), undefined, 'utf8');
    try { fsyncSync(handle); } catch { /* 不支持 fsync 的平台忽略 */ }
    closeSync(handle);
    handle = undefined;
    renameSync(tmp, path);
    fsyncDirSync(dir);
    return true;
  } catch (error) {
    if (handle !== undefined) {
      try { closeSync(handle); } catch { /* ignore */ }
    }
    try { rmSync(tmp, { force: true }); } catch { /* 清理失败也不抛 */ }
    logWarn(logger, `[r4] 原子写失败（已跳过，不重试）：${path}：${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

/** 读 JSON；缺失/损坏返回 `undefined`（不 warn —— 缺失是常态，由调用方决定是否 warn）。 */
export function readJsonSafe<T>(path: string): T | undefined {
  if (!path) return undefined;
  try {
    const text = readFileSync(path, 'utf8');
    if (!text.trim()) return undefined;
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

/** 读文本；缺失返回空串。 */
export function readTextSafe(path: string): string {
  if (!path) return '';
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

/**
 * 读-改-写一体（**同一同步原子段**）：读旧值 → 交给 `mutate` 产出新值 → 原子写回。
 *
 * 这是「并发覆写」的治本手段：调用方不得在 `await` 之间持有旧快照再整份写回。
 * - `mutate` 抛错 → warn，返回 `{ ok: false, value: undefined }`，不写盘、不抛；
 * - `mutate` 返回 `undefined` → 视为「本次不写」，`ok: true`；
 * - 写盘失败 → `{ ok: false, value: 新值 }`（值已算出但没落盘）。
 */
export function mutateJsonAtomic<T>(
  path: string,
  mutate: (previous: T | undefined) => T | undefined,
  logger?: R4Logger,
): { ok: boolean; value: T | undefined } {
  const previous = readJsonSafe<T>(path);
  let next: T | undefined;
  try {
    next = mutate(previous);
  } catch (error) {
    logWarn(logger, `[r4] 读改写失败（未写盘）：${path}：${error instanceof Error ? error.message : String(error)}`);
    return { ok: false, value: undefined };
  }
  if (next === undefined) return { ok: true, value: previous };
  const ok = writeJsonAtomic(path, next, logger);
  return { ok, value: next };
}

/** 判断一个值是否是「普通对象」（数组/null 都不算）。 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
