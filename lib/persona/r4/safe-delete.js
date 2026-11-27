/**
 * safe-delete — 删除留快照（R9，2026-11-27）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 定位
 *
 *   主人决定「边界①放开」：她自己的记忆爱干嘛干嘛。
 *   但删除必须留快照 —— 不是禁止她删，是「删了也能找回来」。
 *
 * ── 为什么用 fs 复制而非 tar ───────────────────────────────────────────────
 *
 *   实测：Android 环境没有 gzip，`tar czf` 直接报
 *     "gzip: Cannot exec: No such file or directory"
 *   而 `tar cf`（不压缩）虽然能用，但多进程/路径含空格时易出问题。
 *   所以这里用**纯 fs 递归复制**，零外部依赖，最可靠。
 *
 * ── 设计铁律 ───────────────────────────────────────────────────────────────
 *
 *   ① 快照放 .snapshot/<timestamp>/，保留最近 30 天
 *   ② 删除前快照成功才删（快照失败 → 不删，报错）
 *   ③ 日志写 .snapshot/delete-log.jsonl（可审计）
 *   ④ 失败静默，但快照失败时**拒绝删除**（宁可不动，不冒丢数据险）
 * ═══════════════════════════════════════════════════════════════════════════
 */
import {
  existsSync, mkdirSync, readdirSync, statSync,
  copyFileSync, rmSync, appendFileSync,
} from 'node:fs';
import { join, basename } from 'node:path';
import { selfDir } from './self-store.js';

/** 快照目录。 */
export const SNAPSHOT_DIR = '.snapshot';
/** 保留最近 N 天快照。 */
export const SNAPSHOT_KEEP_DAYS = 30;

function snapshotDir() {
  const dir = selfDir();
  return dir ? join(dir, SNAPSHOT_DIR) : '';
}

/** 递归复制目录（纯 fs，零依赖）。 */
function copyDirRecursive(src, dst) {
  mkdirSync(dst, { recursive: true });
  for (const name of readdirSync(src)) {
    const s = join(src, name);
    const d = join(dst, name);
    const st = statSync(s);
    if (st.isDirectory()) {
      copyDirRecursive(s, d);
    } else {
      copyFileSync(s, d);
    }
  }
}

/** 递归删除（rmSync 已处理目录，这里是兜底显式）。 */
function removeRecursive(p) {
  if (existsSync(p)) rmSync(p, { recursive: true, force: true });
}

/**
 * 安全删除：先快照，再删除。
 *
 * @param {Array<string>} relPaths 相对 selfDir 的路径列表（如 ['我是谁.md']）
 * @returns {{ok:boolean, reason?:string, snapshot?:string}}
 */
export function safeDelete(relPaths) {
  try {
    const dir = selfDir();
    if (!dir) return { ok: false, reason: 'no-self-dir' };

    const list = Array.isArray(relPaths) ? relPaths : [];
    if (!list.length) return { ok: false, reason: 'empty-paths' };

    // ① 快照到 .snapshot/<timestamp>/
    const ts = Date.now();
    const snapRoot = join(dir, SNAPSHOT_DIR, String(ts));
    mkdirSync(snapRoot, { recursive: true });

    for (const rel of list) {
      const src = join(dir, rel);
      if (!existsSync(src)) continue;   // 不存在就跳过（也算安全）
      const dst = join(snapRoot, rel);
      try {
        if (statSync(src).isDirectory()) {
          copyDirRecursive(src, dst);
        } else {
          mkdirSync(join(dst, '..'), { recursive: true });
          copyFileSync(src, dst);
        }
      } catch (e) {
        // 快照失败 → 整体回滚快照，不删除
        removeRecursive(snapRoot);
        return { ok: false, reason: `snapshot-failed: ${e instanceof Error ? e.message : String(e)}` };
      }
    }

    // ② 快照成功 → 删除原文件
    for (const rel of list) {
      const src = join(dir, rel);
      if (existsSync(src)) removeRecursive(src);
    }

    // ③ 写审计日志
    appendDeleteLog({ at: ts, paths: list, snapshot: String(ts) });

    // ④ 清理过期快照
    pruneOldSnapshots();

    return { ok: true, snapshot: String(ts) };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

/** 审计日志（失败静默）。 */
function appendDeleteLog(entry) {
  try {
    const dir = snapshotDir();
    if (!dir) return;
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, 'delete-log.jsonl'), JSON.stringify(entry) + '\n', 'utf8');
  } catch { /* ignore */ }
}

/** 清理超过保留期的快照。 */
function pruneOldSnapshots() {
  try {
    const dir = snapshotDir();
    if (!dir || !existsSync(dir)) return;
    const cutoff = Date.now() - SNAPSHOT_KEEP_DAYS * 24 * 3600_000;
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (name === 'delete-log.jsonl') continue;
      const st = statSync(p);
      if (st.isDirectory() && st.mtimeMs < cutoff) {
        removeRecursive(p);
      }
    }
  } catch { /* ignore */ }
}

export default {
  SNAPSHOT_DIR, SNAPSHOT_KEEP_DAYS,
  snapshotDir, safeDelete,
};
