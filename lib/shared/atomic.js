/**
 * shared/atomic — 原子文件读写（统一实现，唯一真源）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 2026-11-20 合并：此前有三套实现
 *   · persona/r4/atomic.js      文本 + JSON + mutate（带 fsync）
 *   · memory/store/atomic.js    文本 + Buffer（唯一 tmp 名）
 *   · shared/atomic.js          只有文本 + JSON → 无人使用（死代码）
 *
 * 本文件取三者之长，**保留全部函数签名**（迁移时零改动）：
 *   · fsync 文件 + 目录（防掉电）
 *   · 唯一 tmp 名（防多进程冲突）
 *   · Buffer 支持（memory 需要写二进制）
 *   · mutateJsonAtomic（读-改-写原子段）
 *
 * ── 红线 ───────────────────────────────────────────────────────────────────
 *
 *  - 所有写：同目录建临时文件 → fsync → rename 覆盖
 *  - rename 失败必须清理临时文件
 *  - 写失败 warn 后跳过，**不重试**
 *  - 所有读包 try-catch：缺失/损坏 → 返回默认值，**绝不抛到顶层**
 *
 * ── 为什么从 persona 深拷贝而非 import ─────────────────────────────────────
 *
 * 本模块是**公共层**，不能依赖 persona 的 logger（会形成 shared → persona 的反向依赖）。
 * 所以 logger 改为可选参数，缺省时静默。
 * ═══════════════════════════════════════════════════════════════════════════
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

/** 默认 logger（静默；需要日志时由调用方传入）。 */
const SILENT = { warn() {}, info() {}, log() {} };

/** 安全 warn（logger 可能传 null / 缺方法）。 */
function warn(logger, msg) {
  try {
    const l = logger || SILENT;
    if (typeof l.warn === 'function') l.warn(msg);
    else if (typeof l.log === 'function') l.log(msg);
  } catch { /* logger 本身失败，忽略 */ }
}

/** 生成唯一临时文件名（pid + 时间 + 随机，防多进程冲突）。 */
function makeTmpPath(path) {
  const suffix = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return `${path}.tmp-${suffix}`;
}

/** 尽可能 fsync 一个目录（让 rename 本身落盘；不支持的平台静默忽略）。 */
function fsyncDirSync(dir) {
  let fd = -1;
  try {
    fd = openSync(dir, 'r');
    fsyncSync(fd);
  } catch {
    /* 目录 fsync 在部分平台/文件系统不支持，忽略 */
  } finally {
    if (fd >= 0) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
  }
}

/**
 * 原子写入原始内容（字符串或 Buffer）。
 *
 * @param {string} path 目标路径
 * @param {string|Buffer} content 内容
 * @param {object} [logger] 可选，有 warn 方法即可
 * @returns {boolean} 是否成功
 */
export function writeContentAtomic(path, content, logger) {
  if (!path) {
    warn(logger, '[atomic] 原子写：路径为空（已跳过）');
    return false;
  }

  const tmp = makeTmpPath(path);
  let handle;

  try {
    const dir = dirname(path);
    mkdirSync(dir, { recursive: true });

    // open + write + fsync：确保内容先落盘再 rename
    handle = openSync(tmp, 'w');

    if (Buffer.isBuffer(content)) {
      writeSync(handle, content, 0, content.length);
    } else {
      writeSync(handle, String(content ?? ''), undefined, 'utf8');
    }

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
    warn(logger, `[atomic] 原子写失败（已跳过，不重试）：${path}：${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

/**
 * 原子写文本。
 *
 * @param {string} path
 * @param {string} text
 * @param {object} [logger]
 * @returns {boolean}
 */
export function writeTextAtomic(path, text, logger) {
  return writeContentAtomic(path, text, logger);
}

/**
 * 原子写 JSON（缩进 2，末尾换行）。
 *
 * @param {string} path
 * @param {unknown} value
 * @param {object} [logger]
 * @returns {boolean}
 */
export function writeJsonAtomic(path, value, logger) {
  let text;
  try {
    text = `${JSON.stringify(value, null, 2)}\n`;
  } catch (error) {
    // 循环引用等序列化失败不得抛到调用方
    warn(logger, `[atomic] 原子写序列化失败（已跳过）：${path}：${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
  return writeTextAtomic(path, text, logger);
}

/**
 * 读 JSON；缺失/损坏返回 `undefined`（不 warn —— 缺失是常态）。
 *
 * @param {string} path
 * @returns {unknown|undefined}
 */
export function readJsonSafe(path) {
  if (!path) return undefined;
  try {
    const text = readFileSync(path, 'utf8');
    if (!text.trim()) return undefined;
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * 读文本；缺失返回空串。
 *
 * @param {string} path
 * @returns {string}
 */
export function readTextSafe(path) {
  if (!path) return '';
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

/**
 * 读-改-写一体（**同一同步原子段**）：读旧值 → mutate 产出新值 → 原子写回。
 *
 * 这是「并发覆写」的治本手段：调用方不得在 await 之间持有旧快照再整份写回。
 * - mutate 抛错 → warn，返回 `{ ok: false, value: undefined }`，不写盘、不抛
 * - mutate 返回 `undefined` → 视为「本次不写」，`ok: true`
 * - 写盘失败 → `{ ok: false, value: 新值 }`
 *
 * @param {string} path
 * @param {(prev: unknown) => unknown} mutate
 * @param {object} [logger]
 * @returns {{ok: boolean, value: unknown}}
 */
export function mutateJsonAtomic(path, mutate, logger) {
  const previous = readJsonSafe(path);
  let next;
  try {
    next = mutate(previous);
  } catch (error) {
    warn(logger, `[atomic] 读改写失败（未写盘）：${path}：${error instanceof Error ? error.message : String(error)}`);
    return { ok: false, value: undefined };
  }
  if (next === undefined) return { ok: true, value: previous };
  const ok = writeJsonAtomic(path, next, logger);
  return { ok, value: next };
}

/** 判断一个值是否是「普通对象」（数组/null 都不算）。 */
export function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ═══════════════════════════════════════════════════════════════════════════
// 兼容别名（memory 侧历史签名）
// ═══════════════════════════════════════════════════════════════════════════

/**
 * memory 侧历史签名：atomicWriteText(path, content) → `{ ok, error? }`。
 *
 * ⚠️ 返回的是**对象**不是布尔（memory 的调用点写 `r.ok ? ... : ...`）。
 * 保留这个形状是为了让 memory 的 2 个调用点零改动。
 */
export function atomicWriteText(path, content) {
  const ok = writeTextAtomic(path, content);
  return ok ? { ok: true } : { ok: false, error: new Error('atomic write failed') };
}

/**
 * 原子写 Buffer（memory 曾用；当前无人调用，保留以备将来写二进制）。
 */
export const atomicWriteBuffer = (path, buf) => writeContentAtomic(path, buf);

/**
 * 新式命名别名：atomicWriteJson / atomicWriteText。
 *
 * 历史上有两套命名：
 *   · persona 侧：writeJsonAtomic / writeTextAtomic（返回 boolean）
 *   · 新式（本模块推荐）：atomicWriteJson / atomicWriteText
 * 两者行为一致，保留双名避免调用方改动。
 */
export const atomicWriteJson = (path, value, opts) => writeJsonAtomic(path, value, opts);

/**
 * 取父目录（memory 侧历史工具）。
 */
export function dirOf(path) {
  return dirname(String(path ?? ''));
}

export default {
  writeContentAtomic,
  writeTextAtomic,
  writeJsonAtomic,
  readJsonSafe,
  readTextSafe,
  mutateJsonAtomic,
  isPlainObject,
  atomicWriteText,
  atomicWriteBuffer,
  dirOf,
};