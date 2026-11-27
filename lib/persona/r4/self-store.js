/**
 * self-store — Bot/自我/ 目录读取（R9，2026-11-27）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 定位
 *
 *   她自己的「自我」目录（不是被设定，是长出来的）：
 *     {WORKSPACE}/Bot/自我/
 *       ├── 我是谁.md      自我认知
 *       ├── 我想要什么.md   目标
 *       ├── 我怎么想事.md   思考方式
 *       ├── 我的反思.md     反思记忆
 *       ├── 我的变化记录.md  成长史
 *       ├── 我的规则.md     她给自己定的规则
 *       ├── 我知道的.md     真实发生的事
 *       ├── 我猜想的.md     推测（明确标注）
 *       ├── .snapshot/      删除快照
 *       └── .archive/       归档
 *
 * ── 设计铁律 ───────────────────────────────────────────────────────────────
 *
 *   ① 本模块**只读**，绝不写（写入由 reflection-store / goal-store / 自治调度负责）
 *   ② 任何文件读失败 → 静默跳过，绝不抛到主链
 *   ③ 字数上限 2000 字/文件（防 token 爆炸）
 *   ④ 路径走 resolveQqbotDataRoot() 推导，不硬编码
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { resolveQqbotDataRoot } from '../../shared/paths.js';

/** 单文件字数上限。 */
export const SELF_FILE_CHAR_LIMIT = 2000;

/** 读入顺序（也是注入顺序，前面的更重要）。 */
export const SELF_FILE_ORDER = Object.freeze([
  '我是谁.md',
  '我想要什么.md',
  '我怎么想事.md',
  '我的规则.md',
  '我知道的.md',
  '我猜想的.md',
]);

/** 要跳过的目录（不是 .md 文件）。 */
const SKIP_DIRS = new Set(['.snapshot', '.archive']);

/**
 * 要跳过的文件（不注入人格）。
 *
 * 为什么排除造物规范：它是给「造物时刻」读的操作手册（1500+ 字），
 * 塞进人格会挤掉真正的自我认知，而且不该影响日常说话。
 */
const SKIP_FILES = new Set(['我的造物规范.md', '我的造物手册.md']);

/**
 * 解析「自我」目录绝对路径。
 *
 * @returns {string} .../Bot/自我
 */
export function selfDir() {
  try {
    const qqbotRoot = resolveQqbotDataRoot();
    // qqbotRoot = .../Bot/dshqqbot → dirname = .../Bot → join 自我
    return join(dirname(qqbotRoot), '自我');
  } catch {
    return '';
  }
}

/** 按字节数近似字数（中文 1 字 = 3 字节，这里用字符数）。 */
function charLen(s) {
  return [...String(s ?? '')].length;
}

/** 截断到字数上限。 */
function clip(s, limit = SELF_FILE_CHAR_LIMIT) {
  const t = String(s ?? '');
  const chars = [...t];
  return chars.length <= limit ? t : chars.slice(0, limit).join('');
}

/**
 * 读一个 .md 文件（失败返回空串）。
 */
function readOne(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/**
 * 读所有自我文件（按固定顺序），返回拼接文本 + 文件清单。
 *
 * @returns {{text:string, files:Array<{name:string, chars:number}>}}
 */
export function readSelfFiles() {
  const dir = selfDir();
  const files = [];
  let text = '';

  if (!dir || !existsSync(dir)) {
    return { text: '', files: [] };
  }

  // ① 先按固定顺序读
  for (const name of SELF_FILE_ORDER) {
    if (SKIP_FILES.has(name)) continue;
    const file = join(dir, name);
    if (!existsSync(file)) continue;
    const raw = readOne(file).trim();
    if (!raw) continue;
    const clipped = clip(raw);
    files.push({ name, chars: [...clipped].length });
    text += (text ? '\n\n---\n\n' : '') + clipped;
  }

  // ② 再读目录里其他 .md（不在固定顺序里的，也带上，但排后面）
  try {
    const extra = readdirSync(dir)
      .filter((f) => f.endsWith('.md') && !SELF_FILE_ORDER.includes(f) && !SKIP_DIRS.has(f) && !SKIP_FILES.has(f))
      .sort();
    for (const name of extra) {
      const file = join(dir, name);
      const raw = readOne(file).trim();
      if (!raw) continue;
      const clipped = clip(raw);
      files.push({ name, chars: [...clipped].length });
      text += (text ? '\n\n---\n\n' : '') + clipped;
    }
  } catch { /* 目录遍历失败 → 用已读到的 */ }

  return { text, files };
}

/**
 * 分别读「我知道的」和「我猜想的」。
 *
 * @returns {{facts:string, guesses:string}}
 */
export function readFactGuess() {
  const dir = selfDir();
  if (!dir || !existsSync(dir)) return { facts: '', guesses: '' };
  return {
    facts: readOne(join(dir, '我知道的.md')).trim(),
    guesses: readOne(join(dir, '我猜想的.md')).trim(),
  };
}

/** 目录体量（诊断用）。 */
export function selfStats() {
  const dir = selfDir();
  if (!dir || !existsSync(dir)) return { exists: false, files: 0, chars: 0 };
  let files = 0;
  let chars = 0;
  try {
    for (const name of SELF_FILE_ORDER) {
      const file = join(dir, name);
      if (!existsSync(file)) continue;
      files += 1;
      try { chars += [...readFileSync(file, 'utf8')].length; } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  return { exists: true, files, chars };
}

export default {
  SELF_FILE_CHAR_LIMIT, SELF_FILE_ORDER, selfDir,
  readSelfFiles, readFactGuess, selfStats,
};
