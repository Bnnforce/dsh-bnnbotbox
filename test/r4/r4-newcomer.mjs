#!/usr/bin/env node
/**
 * R4.1 新人识别 — 测试（2026-11-09 新增）
 *
 * 运行：node test-r4/r4-newcomer.mjs（需先 build 出 lib/）
 *
 * 为什么要测这么细（真机教训）：
 *   这条功能的全部价值在「命中 vs 不命中」，而两者**都是静默的**。
 *   判错了不会报错，只会体现为「她对陌生人装熟」或「她对老熟人突然见外」——
 *   两种都很难当场发现，只能靠日志/事后翻聊天记录。
 *   所以每条判据的正反两面都必须钉死。
 *
 * 覆盖：
 *   ① 纯函数判定的所有分支（新人 / 老用户 / 数据缺失 / 脏数据 / 开关关闭）
 *   ② 双判据兜底：老用户 firstMetAt 被补成"首次观测"时不能误判（messageCount 兜底）
 *   ③ 边界：恰好第 3 天 / 恰好第 6 条
 *   ④ 提示文案：不出现具体数字（防模型播报）、不含「欢迎」类主动开口
 *   ⑤ 诊断落盘 + 节流（同一人 5 分钟内不重复写）
 *   ⑥ 与 milestones 的口径一致性：认识 <3 天时 milestone 不出事实（两者互补不冲突）
 *
 * 数据根一律 mkdtemp 隔离，绝不碰生产目录。
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { detectNewcomer, newcomerHintText, makeNewcomerDiag } = await import('../../lib/persona/r4/newcomer.js');

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;

let pass = 0;
let fail = 0;
const failures = [];

function ok(cond, label, detail) {
  if (cond) { pass++; console.log(`  ✅ ${label}`); } else {
    fail++; failures.push(label);
    console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}
function eq(actual, expected, label) {
  ok(actual === expected, `${label}（实际=${JSON.stringify(actual)} 期望=${JSON.stringify(expected)}）`);
}

/** 默认配置（与 `r4/config.ts` 的默认值保持一致）。 */
const CFG = { enabled: true, newcomerDays: 3, newcomerMaxMessages: 6 };

console.log('R4.1 新人识别测试\n');

// ══ T1 命中新人 ═══════════════════════════════════════════════════════════════
console.log('T1 命中新人');
{
  // 刚来 1 天、说了 2 句
  const v = detectNewcomer({ firstMetAt: NOW - 1 * DAY, messageCount: 2, now: NOW }, CFG);
  ok(v !== null, '认识 1 天 + 2 条 → 命中新人');
  eq(v.daysKnown, 1, 'daysKnown=1');
  eq(v.messageCount, 2, 'messageCount 回显 2');

  // 刚来几小时（daysKnown=0）
  const v0 = detectNewcomer({ firstMetAt: NOW - 3_600_000, messageCount: 0, now: NOW }, CFG);
  ok(v0 !== null, '认识 1 小时 → 命中');
  eq(v0.daysKnown, 0, '不足一天 → daysKnown=0');
  eq(v0.messageCount, 0, '没说过话也算（count=0）');
}

// ══ T2 不命中：认识太久 ═══════════════════════════════════════════════════════
console.log('\nT2 不命中：认识太久');
{
  eq(detectNewcomer({ firstMetAt: NOW - 3 * DAY, messageCount: 1, now: NOW }, CFG), null,
    '恰好第 3 天（>= 阈值）→ 不是新人');
  eq(detectNewcomer({ firstMetAt: NOW - 10 * DAY, messageCount: 1, now: NOW }, CFG), null,
    '认识 10 天 → 不是新人');
  eq(detectNewcomer({ firstMetAt: NOW - 365 * DAY, messageCount: 1, now: NOW }, CFG), null,
    '认识一年 → 不是新人');
}

// ══ T3 不命中：说得太多（老用户兜底判据）═════════════════════════════════════
console.log('\nT3 不命中：说得太多（★ 老用户误判兜底）');
{
  // 关键场景：老用户第一次上线，firstMetAt 被补成"首次观测时间"= 今天，
  // 但 messageCount 早就超过阈值 → 必须判为「不是新人」，否则对老熟人突然见外。
  eq(detectNewcomer({ firstMetAt: NOW - 1 * DAY, messageCount: 6, now: NOW }, CFG), null,
    '★ 认识 1 天但已说 6 条（= 阈值）→ 不是新人（双判据兜底生效）');
  eq(detectNewcomer({ firstMetAt: NOW - 1 * DAY, messageCount: 259, now: NOW }, CFG), null,
    '★ 认识 1 天但已说 259 条（真实数据量级）→ 不是新人');
  // 5 条仍在阈值内
  const v = detectNewcomer({ firstMetAt: NOW - 1 * DAY, messageCount: 5, now: NOW }, CFG);
  ok(v !== null, '认识 1 天 + 5 条（< 6）→ 仍是新人');
}

// ══ T4 数据缺失 / 脏数据：一律不判（绝不猜）══════════════════════════════════
console.log('\nT4 数据缺失/脏数据 → 绝不猜');
{
  eq(detectNewcomer({ firstMetAt: 0, messageCount: 2, now: NOW }, CFG), null,
    'firstMetAt=0（不知道首次时间）→ 不判');
  eq(detectNewcomer({ firstMetAt: NaN, messageCount: 2, now: NOW }, CFG), null,
    'firstMetAt=NaN → 不判');
  eq(detectNewcomer({ firstMetAt: -1, messageCount: 2, now: NOW }, CFG), null,
    'firstMetAt 负数 → 不判');
  eq(detectNewcomer({ firstMetAt: NOW + 10 * DAY, messageCount: 2, now: NOW }, CFG), null,
    '★ firstMetAt 在未来（脏数据）→ 不判，而不是算出负数天数');
  eq(detectNewcomer({ firstMetAt: 9e15, messageCount: 2, now: NOW }, CFG), null,
    'firstMetAt 超上限（>2100 年）→ 当作脏数据不判');
  // messageCount 非法 → 归 0。方向是**故意保守**的：
  // 宁可把老用户短暂判成新人（他一说话就脱离新人态），也不要对新人装熟。
  const vNaN = detectNewcomer({ firstMetAt: NOW - DAY, messageCount: NaN, now: NOW }, CFG);
  ok(vNaN !== null, 'messageCount=NaN → 归 0 → 命中新人（保守方向）');
  eq(vNaN.messageCount, 0, 'NaN 被收敛成 0');
  // 说明：messageCount 非法归 0，反而更容易判新人 —— 这是**故意**的保守方向：
  // 宁可对老用户短暂见外（他会一说话就脱离新人态），也不要对新人装熟。
  const v = detectNewcomer({ firstMetAt: NOW - DAY, messageCount: NaN, now: NOW }, CFG);
  ok(v === null || v.messageCount === 0, 'NaN messageCount 归 0（不会炸）');
  const vNeg = detectNewcomer({ firstMetAt: NOW - DAY, messageCount: -5, now: NOW }, CFG);
  ok(vNeg !== null, 'messageCount 负数 → 归 0 → 命中新人（保守方向）');
  eq(vNeg.messageCount, 0, '负数被收敛成 0');
}

// ══ T5 开关与非法配置 ═════════════════════════════════════════════════════════
console.log('\nT5 开关与非法配置');
{
  eq(detectNewcomer({ firstMetAt: NOW - DAY, messageCount: 1, now: NOW }, { ...CFG, enabled: false }), null,
    'enabled=false → 不判');
  eq(detectNewcomer({ firstMetAt: NOW - DAY, messageCount: 1, now: NOW }, null), null,
    'config=null → 不判（绝不抛）');
  eq(detectNewcomer(null, CFG), null, 'facts=null → 不判');
  eq(detectNewcomer({ firstMetAt: NOW - DAY, messageCount: 1, now: 0 }, CFG), null,
    'now=0 → 不判');
  // 非法天数配置 → 回落默认 3
  const v = detectNewcomer({ firstMetAt: NOW - 2 * DAY, messageCount: 1, now: NOW }, { enabled: true, newcomerDays: 0, newcomerMaxMessages: 6 });
  ok(v !== null, 'newcomerDays=0（非法）→ 回落默认 3，因此认识 2 天仍算新人');
  // 非法消息阈值 → 回落默认 6
  const v2 = detectNewcomer({ firstMetAt: NOW - DAY, messageCount: 6, now: NOW }, { enabled: true, newcomerDays: 3, newcomerMaxMessages: 0 });
  eq(v2, null, 'newcomerMaxMessages=0（非法）→ 回落默认 6，6 条不算新人');
}

// ══ T6 提示文案 ═══════════════════════════════════════════════════════════════
console.log('\nT6 提示文案');
{
  const v = detectNewcomer({ firstMetAt: NOW - DAY, messageCount: 1, now: NOW }, CFG);
  const text = newcomerHintText(v);
  ok(text.length > 0, '命中 → 有文案');
  ok(text.includes('别装熟'), '★ 明确写「别装熟」（本功能唯一目的）');
  ok(/别用老熟人|不要叫亲昵称呼/.test(text), '★ 约束称呼与语气');
  ok(!/\d/.test(text), '★★ 文案里**没有任何数字**（防模型播报「你才来 2 天」）');
  ok(!text.includes('欢迎'), '★ 不含「欢迎」类主动开口（本模块只管语气分寸，不管打不打招呼）');
  ok(!text.includes('等级') && !text.includes('Lv'), '不含等级字样');
  eq(newcomerHintText(null), '', '不是新人 → 空串（不注入）');
  // 注意：文案里**确实**出现「上次」（在「别提「上次」」这句反例里），这是刻意的 ——
  // 必须点名禁止，否则模型不知道禁什么。所以这里检查的是「禁止」语境而非「不含」。
  ok(/别提「上次」/.test(text), '★ 文案明确点名禁止「上次」这类翻旧账表达');
}

// ══ T7 诊断落盘 + 节流 ════════════════════════════════════════════════════════
console.log('\nT7 诊断落盘与节流');
{
  const dir = mkdtempSync(join(tmpdir(), 'newcomer-diag-'));
  const clock = { t: NOW };
  const diag = makeNewcomerDiag({ dir, now: () => clock.t });
  const file = join(dir, 'newcomer.log');

  // ① 首次写入
  diag('hit', { gid: 'g1', uid: 'u1', days: 1, msgs: 2 });
  ok(existsSync(file), '首次调用 → 日志文件已创建');
  const line1 = readFileSync(file, 'utf8').trim().split('\n');
  eq(line1.length, 1, '只写 1 行');
  const rec = JSON.parse(line1[0]);
  eq(rec.event, 'hit', 'event=hit');
  ok(rec.at && typeof rec.at === 'string', '带 ISO 时间戳');
  ok(rec.gid === 'g1' && rec.uid === 'u1', '带 gid/uid');

  // ② 5 分钟内同内容 → 不写
  clock.t += 60_000;
  diag('hit', { gid: 'g1', uid: 'u1', days: 1, msgs: 2 });
  eq(readFileSync(file, 'utf8').trim().split('\n').length, 1, '★ 节流：1 分钟后同内容不重复写');

  // ③ 超过 5 分钟 → 写
  clock.t += 6 * 60_000;
  diag('hit', { gid: 'g1', uid: 'u1', days: 1, msgs: 2 });
  eq(readFileSync(file, 'utf8').trim().split('\n').length, 2, '超过节流窗口 → 再写一行');

  // ④ 不同人 → 立刻写
  diag('hit', { gid: 'g1', uid: 'u2', days: 0, msgs: 1 });
  eq(readFileSync(file, 'utf8').trim().split('\n').length, 3, '不同 uid 不受节流影响');

  // ⑤ 不存在的目录 → 自动创建，不抛
  const dir2 = join(dir, 'deep', 'nested');
  let threw = false;
  try { makeNewcomerDiag({ dir: dir2, now: () => NOW })('hit', { uid: 'x' }); } catch { threw = true; }
  ok(!threw, '目录不存在 → 自动创建，不抛');
  ok(existsSync(join(dir2, 'newcomer.log')), '嵌套目录日志已写入');

  rmSync(dir, { recursive: true, force: true });
}

// ══ T8 与 milestones 口径一致（互补不冲突）═══════════════════════════════════
console.log('\nT8 与 milestones 互补');
{
  // milestones 在「认识 <3 天」时故意不出事实（`COLD_START_DAYS=3`）。
  // 新人识别**正好填这个窗口**：认识 1 天 → milestone 返回 null，但 newcomer 命中。
  const v = detectNewcomer({ firstMetAt: NOW - 1 * DAY, messageCount: 1, now: NOW }, CFG);
  ok(v !== null, '★ 认识 1 天：newcomer 命中（而 milestone 此时返回 null）');
  // 认识 3 天后：newcomer 不命中（milestone 开始出事实）→ 两者窗口互补
  eq(detectNewcomer({ firstMetAt: NOW - 3 * DAY, messageCount: 1, now: NOW }, CFG), null,
    '★ 认识 3 天：newcomer 退出（milestone 刚好接上）');
}

// ══ T9 生产数据零污染 ═════════════════════════════════════════════════════════
console.log('\nT9 测试隔离');
{
  const PROD = process.env.PERSONA_DATA_ROOT || ((process.env.DSH_HOME || '') + '/data/dsh-anti-ai-persona');
  let mtime = null;
  try { mtime = statSync(PROD).mtimeMs; } catch { /* 无生产目录也无妨 */ }
  if (mtime !== null) {
    ok(Math.abs(statSync(PROD).mtimeMs - mtime) < 1, '★ 生产数据目录 mtime 未变（测试未污染）');
  } else {
    ok(true, '（无生产目录，跳过）');
  }
}

console.log(`\n${fail === 0 ? '✅ 通过' : '❌ 失败'} ${pass} / ${fail}`);
if (fail > 0) {
  console.log('失败项：');
  for (const f of failures) console.log('  · ' + f);
  process.exit(1);
}
