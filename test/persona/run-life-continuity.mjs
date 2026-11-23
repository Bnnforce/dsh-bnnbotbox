/**
 * run-life-continuity.mjs — 生活痕迹跨天延续测试（2026-11-16 P2）
 *
 * 验证重点：
 *   T1 跨天保留旧条目（今天抽新卡，昨天的还在）
 *   T2 超期自动丢弃（保留 3 天，第 4 天的丢）
 *   T3 同一天不重复写入
 *   T4 recent 容量上限
 *   T5 carried 注入文案（有旧事 / 无旧事）
 *   T6 脏数据容错（不整份丢弃）
 *   T7 生产零污染
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP = mkdtempSync(join(tmpdir(), 'lifecont-'));
process.env.PERSONA_DATA_ROOT = TMP;
mkdirSync(join(TMP, 'state'), { recursive: true });

const LE = await import('../../lib/persona/r4/life-events.js');
const LS = await import('../../lib/persona/r4/life-store.js');

let pass = 0, fail = 0;
const ok = (c, l, d) => { if (c) { pass++; console.log('  ✅ ' + l); } else { fail++; console.log('  ❌ ' + l + (d ? ' — ' + d : '')); } };

const cfg = { enabled: true, max_event_chars: 80 };
const cand = { late_night: ['LN'], morning: ['M'], afternoon: ['A'], evening: ['E'] };
const rand = () => 0.5;

console.log('\nT1 跨天保留旧条目');
{
  // ★ 默认行为不变：4 段都抽（P5 是可选优化，需显式传 skipSlots）
  const d1 = LE.pickLifeEvents({ date: '2026-11-14', now: 1, random: rand, candidates: cand, config: cfg });
  ok(d1.recent.length === 4, `第1天 4 条（默认不跳过，实际 ${d1.recent?.length}）`);
  ok(Boolean(d1.slots.late_night), '默认仍抽 late_night（不破坏既有行为）');
  const d2 = LE.pickLifeEvents({ date: '2026-11-15', now: 2, random: rand, candidates: cand, config: cfg, previous: d1 });
  ok(d2.recent.length === 8, `第2天累计 8 条（实际 ${d2.recent?.length}）`);
  const oldStill = d2.recent.filter(x => x.date === '2026-11-14');
  ok(oldStill.length === 4, `昨天的 4 条仍在（${oldStill.length}）`);
}

console.log('\nT2 超期自动丢弃（保留 3 天）');
{
  let state = LE.pickLifeEvents({ date: '2026-11-10', now: 1, random: rand, candidates: cand, config: cfg });
  state = LE.pickLifeEvents({ date: '2026-11-11', now: 2, random: rand, candidates: cand, config: cfg, previous: state });
  state = LE.pickLifeEvents({ date: '2026-11-12', now: 3, random: rand, candidates: cand, config: cfg, previous: state });
  state = LE.pickLifeEvents({ date: '2026-11-13', now: 4, random: rand, candidates: cand, config: cfg, previous: state });
  const dates = new Set(state.recent.map(x => x.date));
  ok(!dates.has('2026-11-10'), '11-10 已丢弃');
  ok(dates.has('2026-11-13'), '11-13 保留');
  ok(state.recent.length <= LE.RECENT_MAX_ITEMS, `不超上限（${state.recent.length} <= ${LE.RECENT_MAX_ITEMS}）`);
}

console.log('\nT3 同一天不重复');
{
  const a = LE.pickLifeEvents({ date: '2026-11-16', now: 1, random: rand, candidates: cand, config: cfg });
  const b = LE.pickLifeEvents({ date: '2026-11-16', now: 2, random: rand, candidates: cand, config: cfg, previous: a });
  const todayCount = b.recent.filter(x => x.date === '2026-11-16').length;
  ok(todayCount === 4, `今天只有 4 条（实际 ${todayCount}）`);
}

console.log('\nT4 recentPastEvents 只取旧事');
{
  const s1 = LE.pickLifeEvents({ date: '2026-11-14', now: 1, random: rand, candidates: { ...cand, morning: ['昨天早上我去了公园'] }, config: cfg });
  const s2 = LE.pickLifeEvents({ date: '2026-11-15', now: 2, random: rand, candidates: cand, config: cfg, previous: s1 });
  const past = LE.recentPastEvents(s2, '2026-11-15', 2);
  ok(past.length === 2, `取到 2 条（${past.length}）`);
  ok(past.every(p => p.date !== '2026-11-15'), '不含今天');
}

console.log('\nT5 carried 注入文案');
{
  const withOld = LE.lifeBackgroundText('今天在喝茶', '- 2026-11-14：去了公园');
  ok(withOld.includes('去了公园'), '带旧事时含旧事');
  ok(withOld.includes('别硬凑'), '有"不用硬提"约束');
  ok(withOld.includes('隐藏背景板'), '保留原有约束');
  const noOld = LE.lifeBackgroundText('今天在喝茶');
  ok(!noOld.includes('这两天你还做过'), '无旧事时不多注入');
}

console.log('\nT6 脏数据容错');
{
  const p = join(TMP, 'state', 'daily-mood.json');
  writeFileSync(p, JSON.stringify({
    date: '2026-11-16',
    slots: { morning: 'ok' },
    generatedAt: 1,
    recent: [null, 123, { date: '', text: 'x' }, { date: '2026-11-15', text: '有效' }, { date: '2026-11-14', text: '' }],
  }), 'utf8');
  const st = LS.readDailyMood(TMP);
  ok(st.recent.length === 1, `只保留有效 1 条（${st.recent?.length}）`);
  ok(st.recent[0].text === '有效', '内容正确');
}

console.log('\nT7 生产零污染');
{
  const prod = (process.env.PERSONA_DATA_ROOT || ((process.env.DSH_HOME || '') + '/data/dsh-anti-ai-persona')) + '/state/daily-mood.json';
  const txt = existsSync(prod) ? readFileSync(prod, 'utf8') : '';
  ok(!txt.includes('lifecont-'), '测试内容没写进生产');
}

rmSync(TMP, { recursive: true, force: true });
console.log(`\n通过 ${pass} / 失败 ${fail}`);
if (fail) process.exitCode = 1;
