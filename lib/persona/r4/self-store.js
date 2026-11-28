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

/**
 * ★★ 2026-11-28 分级预算（主人选方案 C）。
 *
 * ── 为什么需要（实测）──────────────────────────────────────────────────────
 *
 *   原来是一刀切 400 字，按顺序塞。实测结果：
 *
 *     ✅ 我是谁.md        167 字（累计 168）
 *     ✅ 我想要什么.md    124 字（累计 293）
 *     ✅ 我怎么想事.md     81 字（累计 375）
 *     ✂️ 我的规则.md       52 字 —— 只剩 25，装不下
 *
 *   ⇒ 她改了「我的规则」，下次说话**根本看不到自己写的规则**。
 *     闭环是断的：改了生效，但看不到。
 *
 * ── 怎么分 ─────────────────────────────────────────────────────────────────
 *
 *   核心三件（她最该知道的）给足：
 *     我是谁        200 字
 *     我想要什么    150 字
 *     我怎么想事    120 字
 *
 *   其余每个保底，保证都能露一面：
 *     我的规则       80 字
 *     我知道的       80 字
 *     我猜想的       80 字
 *
 *   总上限 710 字（原来是 400）。
 */
export const TIERED_BUDGET = Object.freeze({
  '我是谁.md': 200,
  '我想要什么.md': 150,
  '我怎么想事.md': 120,
  '我的规则.md': 80,
  '我知道的.md': 80,
  '我猜想的.md': 80,
});

/** 分级预算总和。 */
export const TIERED_TOTAL = Object.freeze(
  Object.values(TIERED_BUDGET).reduce((a, b) => a + b, 0),
);
/** 要跳过的目录（不是 .md 文件）。 */
const SKIP_DIRS = new Set(['.snapshot', '.archive']);

/**
 * 要跳过的文件（不注入人格）。
 *
 * 为什么排除造物规范：它是给「造物时刻」读的操作手册（1500+ 字），
 * 塞进人格会挤掉真正的自我认知，而且不该影响日常说话。
 */
/**
 * 不注入人格的文件（它们不是「自我认知」）。
 *
 * ★★ 2026-11-28 补：原来只排除两本手册，实测发现另外三个文件也在注入里
 *    而且**没有长度上限**（合计 3327 字），把分级预算整个撑爆：
 *      · 我的反思.md              2000 字（反思记录，属于「过程」不是「我是谁」）
 *      · 我的变化记录.md           279 字（成长史，同上）
 *      · 无人维护时我怎么活.md     1048 字（运维手册，不该注入）
 *
 *    这些文件她照样能读能写（造物时刻用），只是不进日常人格注入。
 */
const SKIP_FILES = new Set([
  // 手册类（给她看的操作指南）
  '我的造物规范.md',
  '我的造物手册.md',
  // 记录类（过程/历史，不是「我是谁」）
  '我的反思.md',
  '我的变化记录.md',
  // 运维手册
  '无人维护时我怎么活.md',
]);

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

  // ① 先按固定顺序读（★ 分级预算：每个文件有专属上限，不会被前面的吃光）
  for (const name of SELF_FILE_ORDER) {
    if (SKIP_FILES.has(name)) continue;
    const file = join(dir, name);
    if (!existsSync(file)) continue;
    const raw = readOne(file).trim();
    if (!raw) continue;

    // 分级裁剪：优先用本文件预算，没有就 80 字保底
    const budget = TIERED_BUDGET[name] ?? 80;
    const body = clip(raw);
    const over = charLen(body) > budget;
    const clipped = over ? body.slice(0, budget) + '…' : body;

    files.push({ name, chars: [...clipped].length, budget, truncated: over });
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
