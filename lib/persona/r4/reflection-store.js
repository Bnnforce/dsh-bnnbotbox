/**
 * reflection-store — 反思记忆（Reflexion，R9，2026-11-27）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 定位
 *
 *   Reflexion（arXiv 2303.11366）的核心：用语言化反思改进下一次决策，
 *   不改权重。本模块就是「她的反思记忆」。
 *
 *   每次改进前先读反思（避免重复犯过的错），改进后写一条（失败必写）。
 *
 * ── 设计铁律 ───────────────────────────────────────────────────────────────
 *
 *   ① 反思保留最近 30 条，超了归档到 .archive/
 *   ② 追加用原子写（shared/atomic）
 *   ③ 失败静默，绝不抛到主链
 *   ④ 格式固定：`## YYYY-MM-DD\n- 内容`
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { readFileSync, existsSync, mkdirSync, readdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { selfDir } from './self-store.js';
import { writeTextAtomic } from '../../shared/atomic.js';

/** 反思文件。 */
export const REFLECTION_FILE = '我的反思.md';
/** 保留最近 N 条反思。 */
export const MAX_REFLECTIONS = 30;
/** 归档目录。 */
export const ARCHIVE_DIR = '.archive';

function reflectionPath() {
  const dir = selfDir();
  return dir ? join(dir, REFLECTION_FILE) : '';
}

function archivePath() {
  const dir = selfDir();
  return dir ? join(dir, ARCHIVE_DIR) : '';
}

/** 读整个反思文件（失败返回空串）。 */
export function readAllReflections() {
  const file = reflectionPath();
  if (!file || !existsSync(file)) return '';
  try { return readFileSync(file, 'utf8'); } catch { return ''; }
}

/** 拆成单条反思（按 `## 日期` 分段）。 */
export function parseReflections(text) {
  const t = String(text ?? '');
  const out = [];
  const blocks = t.split(/^## /m).slice(1);
  for (const b of blocks) {
    const lines = b.split('\n');
    const date = String(lines[0] ?? '').trim();
    const body = lines.slice(1).join('\n').trim();
    if (date) out.push({ date, body });
  }
  return out;
}

/**
 * 读最近 N 天反思（纯文本，给 Meta-Agent 提案前用）。
 *
 * @param {number} [days=7]
 * @returns {string}
 */
export function readRecentReflections(days = 7) {
  const all = readAllReflections();
  if (!all) return '';
  const list = parseReflections(all);
  if (!list.length) return '';

  // 简单按「最近 N 条」取（条数比天数更稳，避免日期解析复杂）
  const n = Math.max(1, Math.min(30, Number(days) || 7));
  const recent = list.slice(-n);
  return recent.map((r) => `## ${r.date}\n${r.body}`).join('\n\n');
}

/** 生成今天的日期段。 */
function todayStr(now = Date.now()) {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * 追加一条反思（原子写）。
 *
 * @param {object} entry
 * @param {string} entry.text 反思内容（一句话）
 * @param {number} [entry.at] 时间戳
 * @returns {boolean} 是否成功
 */
export function appendReflection(entry) {
  try {
    const file = reflectionPath();
    if (!file) return false;
    const text = String(entry?.text ?? '').trim();
    if (!text) return false;

    const at = Number(entry?.at) || Date.now();
    const date = todayStr(at);
    const block = `## ${date}\n- ${text}`;

    const existing = readAllReflections();
    const next = existing.trim()
      ? `${existing.trim()}\n\n${block}`
      : block;

    // 超上限 → 归档旧的一半
    const list = parseReflections(next);
    let finalText = next;
    if (list.length > MAX_REFLECTIONS) {
      finalText = archiveAndTrim(next, list);
    }

    return writeTextAtomic(file, finalText + '\n');
  } catch {
    return false;
  }
}

/** 归档旧反思，保留最近 MAX 条。 */
function archiveAndTrim(text, list) {
  const overflow = list.slice(0, list.length - MAX_REFLECTIONS);
  const keep = list.slice(list.length - MAX_REFLECTIONS);

  // 归档溢出的部分
  try {
    const arch = archivePath();
    if (arch) {
      mkdirSync(arch, { recursive: true });
      const stamp = todayStr();
      const archFile = join(arch, `反思-${stamp}.md`);
      const overflowText = overflow.map((r) => `## ${r.date}\n${r.body}`).join('\n\n');
      // 原子写归档文件（追加用简单的 read + write）
      try {
        const old = existsSync(archFile) ? readFileSync(archFile, 'utf8') : '';
        writeTextAtomic(archFile, (old.trim() ? old.trim() + '\n\n' : '') + overflowText);
      } catch { /* 归档失败不影响主流程 */ }
    }
  } catch { /* ignore */ }

  return keep.map((r) => `## ${r.date}\n${r.body}`).join('\n\n');
}

export default {
  REFLECTION_FILE, MAX_REFLECTIONS, ARCHIVE_DIR,
  readAllReflections, parseReflections, readRecentReflections, appendReflection,
};
