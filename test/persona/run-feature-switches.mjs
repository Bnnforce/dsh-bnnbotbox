/** run-feature-switches.mjs — 5 个功能开关测试（关闭 = 零开销） */
import { readFileSync } from 'node:fs';

const CFG = await import('../../lib/persona/r4/config.js');
const INJ = await import('../../lib/persona/r4/inject.js');

let pass=0, fail=0;
const ok=(c,l,d)=>{ if(c){pass++;console.log('  ✅ '+l);} else {fail++;console.log('  ❌ '+l+(d?' — '+d:''));} };
/** mergeConfig 返回 {config,warnings} */
const parse = (raw) => CFG.mergeConfig(raw).config;

console.log('\nT1 默认值');
{
  const f = parse({}).features_config;
  ok(f.life_continuity === true, 'P2 默认开');
  ok(f.absence_hint === true, 'P4 默认开');
  ok(f.own_time === false, '★ P1 默认关（唯一有成本）');
  ok(f.mood_tint === true, 'P3 默认开');
  ok(f.life_slot_fix === true, 'P5 默认开');
}

console.log('\nT2 显式关闭');
{
  const f = parse({ features_config: {
    life_continuity: false, absence_hint: false,
    own_time: false, mood_tint: false, life_slot_fix: false,
  } }).features_config;
  ok(f.life_continuity === false, 'P2 可关');
  ok(f.absence_hint === false, 'P4 可关');
  ok(f.mood_tint === false, 'P3 可关');
  ok(f.life_slot_fix === false, 'P5 可关');
}

console.log('\nT3 显式开启 P1');
{
  const f = parse({ features_config: { own_time: true } }).features_config;
  ok(f.own_time === true, 'P1 可开（试运行）');
}

console.log('\nT4 脏值保守处理');
{
  const f = parse({ features_config: {
    life_continuity: 'yes', absence_hint: 1, mood_tint: null,
  } }).features_config;
  ok(typeof f.life_continuity === 'boolean', 'P2 归一为布尔');
  ok(typeof f.absence_hint === 'boolean', 'P4 归一为布尔');
  ok(typeof f.mood_tint === 'boolean', 'P3 归一为布尔');
  // 布尔开关用非 true 值应该保守
  ok(f.own_time === false, '脏值不误开 P1');
}

console.log('\nT5 P3 关闭 → 不注入（模拟 index 的 early return）');
{
  const r = INJ.buildInjection({
    groupId: 'G', userId: 'U', persona: 'p', levels: { user: 'L2', others: [] },
    sources: {
      getProfile: () => 'p', getOverlay: () => '', getRelationshipTag: () => '',
      getContestHint: () => '', getOtherTags: () => [], getHighlights: () => '',
      getTimeState: () => '[t]',
      getMoodTint: () => '',   // 开关关 → 返回空串
    },
  });
  ok(r.present.moodTint === false, 'P3 关闭 → 无注入');
}

console.log('\nT6 产物含全部开关接线');
{
  const src = readFileSync(new URL('../../lib/persona/r4/index.js', import.meta.url), 'utf8');
  ok(src.includes('lifeContinuity'), '诊断含 P2');
  ok(src.includes('ownTimeRunning'), '诊断含 P1 运行态');
  ok(src.includes('moodTint'), '诊断含 P3');
  ok(src.includes('startOwnTime'), 'R4Handle 有 startOwnTime');
  ok(src.includes('absence_hint'), 'P4 开关已接线');
  ok(src.includes('life_slot_fix'), 'P5 开关已接线');
}

console.log('\nT7 P1 参数配置（可调）');
{
  const c = parse({ own_time_config: { intervalMin: 60, dailyMax: 2, quietFromHour: 1, quietToHour: 7 } });
  const o = c.own_time_config;
  ok(o.intervalMin === 60, 'intervalMin 可调');
  ok(o.dailyMax === 2, 'dailyMax 可调');
  ok(o.quietFromHour === 1, 'quietFromHour 可调');
  ok(o.quietToHour === 7, 'quietToHour 可调');
}

console.log('\nT8 P1 参数钳制（防手滑）');
{
  const o = parse({ own_time_config: { intervalMin: 99999, dailyMax: 999, quietFromHour: -5, quietToHour: 99 } }).own_time_config;
  ok(o.intervalMin <= 1440, `intervalMin 钳到 ${o.intervalMin}（≤1440）`);
  ok(o.dailyMax <= 24, `dailyMax 钳到 ${o.dailyMax}（≤24）`);
  ok(o.quietFromHour >= 0, `quietFromHour 钳到 ${o.quietFromHour}（≥0）`);
  ok(o.quietToHour <= 23, `quietToHour 钳到 ${o.quietToHour}（≤23）`);
}

const fail2 = fail;
console.log(`\n最终通过 ${pass} / 失败 ${fail2}`);
if (fail2) process.exitCode = 1;
