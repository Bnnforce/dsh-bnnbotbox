/**
 * goal-store — 目标管理（BabyAGI，R9，2026-11-27）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 定位
 *
 *   BabyAGI 的核心之一：目标分解 + 任务队列。
 *   本模块是「她的目标管理」：解析 我想要什么.md 的结构化目标。
 *
 *   目标文件格式（固定）：
 *     ## 本周目标
 *     - [ ] 做某事
 *     - [x] 已完成的事
 *
 *     ## 本月目标
 *     - [ ] ...
 *
 *     ## 长期目标
 *     - [ ] ...
 *
 *     ## 已完成
 *     - 已完成的事
 *
 * ── 设计铁律 ───────────────────────────────────────────────────────────────
 *
 *   ① 纯函数（parseGoals / countGoals），可单测
 *   ② 读文件失败 → 返回空结构，不抛
 *   ③ 不自动写（写入由自治调度负责）
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { selfDir } from './self-store.js';

/** 目标文件。 */
export const GOAL_FILE = '我想要什么.md';

/** 各段标题。 */
export const GOAL_SECTIONS = Object.freeze({
  week: '本周目标',
  month: '本月目标',
  long: '长期目标',
  done: '已完成',
});

function goalPath() {
  const dir = selfDir();
  return dir ? join(dir, GOAL_FILE) : '';
}

/** 读目标文件全文（失败返回空串）。 */
export function readGoals() {
  const file = goalPath();
  if (!file || !existsSync(file)) return '';
  try { return readFileSync(file, 'utf8'); } catch { return ''; }
}

/**
 * 解析目标（纯函数）。
 *
 * @param {string} text 目标文件全文
 * @returns {{week:Array<{text:string,done:boolean}>, month:Array<...>, long:Array<...>, done:Array<string>}}
 */
export function parseGoals(text) {
  const t = String(text ?? '');
  const out = { week: [], month: [], long: [], done: [] };

  // 按段切
  const sections = { current: null };
  const blocks = t.split(/\n(?=## )/);   // 按 ## 分段
  for (const block of blocks) {
    const m = block.match(/^##\s*(.+)$/m);
    if (!m) continue;
    const title = String(m[1] ?? '').trim();
    const body = block.replace(/^##\s*.+\n?/m, '');

    let target = null;
    if (title === GOAL_SECTIONS.week) target = 'week';
    else if (title === GOAL_SECTIONS.month) target = 'month';
    else if (title === GOAL_SECTIONS.long) target = 'long';
    else if (title === GOAL_SECTIONS.done) target = 'done';

    if (!target) continue;

    for (const line of body.split('\n')) {
      const s = line.trim();
      if (!s.startsWith('-')) continue;
      const item = s.replace(/^-\s*/, '').trim();
      if (!item) continue;

      if (target === 'done') {
        out.done.push(item.replace(/^\[x\]\s*/i, '').trim());
      } else {
        const done = /^\[x\]/i.test(item);
        const cleanText = item.replace(/^\[[ x]\]\s*/i, '').trim();
        if (cleanText) out[target].push({ text: cleanText, done });
      }
    }
  }
  return out;
}

/** 统计目标数量（诊断用）。 */
export function countGoals(parsed) {
  const p = parsed || { week: [], month: [], long: [], done: [] };
  return {
    week: p.week.length,
    weekDone: p.week.filter((g) => g.done).length,
    month: p.month.length,
    monthDone: p.month.filter((g) => g.done).length,
    long: p.long.length,
    longDone: p.long.filter((g) => g.done).length,
    done: p.done.length,
  };
}

export default {
  GOAL_FILE, GOAL_SECTIONS, goalPath,
  readGoals, parseGoals, countGoals,
};
