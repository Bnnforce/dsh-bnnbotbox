/** run-inject-integration.mjs — 注入链路集成测试（P2/P3/P4 同时在场 + 预算熔断 + 失败隔离） */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const INJ = await import('../../lib/persona/r4/inject.js');
// ★ 2026-11-21 v3：mood-tint.js 已删除（死代码清理，见 R5.4 v3 方案 §5）。
//   本测试只验证**注入链路**（预算熔断、失败隔离、多源拼接），
//   不需要真实的情绪算法 —— 用固定文本模拟 getMoodTint 的返回即可。
const MOOD_TEXT = { warm: '[很放松。底色，语境优先，别解释自己。]', neutral: '' };

let pass=0, fail=0;
const ok=(c,l,d)=>{ if(c){pass++;console.log('  ✅ '+l);} else {fail++;console.log('  ❌ '+l+(d?' — '+d:''));} };

const base = {
  groupId: 'G1', userId: 'U1', persona: '爱莉希雅',
  levels: { user: 'L2', others: [] },
};

console.log('\nT1 全功能开启 → 三段都在');
{
  const r = INJ.buildInjection({
    ...base,
    sources: {
      getProfile: () => '【画像】群友A：喜欢双休',
      getOverlay: () => '',
      getRelationshipTag: () => '【关系】L2',
      getContestHint: () => '',
      getOtherTags: () => [],
      getHighlights: () => '',
      getTimeState: () => '[当前时间：2026-11-16 12:00，午后]',
      getLifeBackground: () => '[你的隐藏背景板：刚泡了茶]\n另外，前两天你还做过这些事：\n- 2026-11-14：追萤火虫',
      getMoodTint: () => MOOD_TEXT.warm,
    },
  });
  ok(r.text.includes('泡了茶'), 'P2 生活背景板在场');
  ok(r.text.includes('追萤火虫'), 'P2 旧事在场');
  ok(r.text.includes('很放松'), 'P3 情绪底色在场');
  ok(r.present.lifeBackground === true, 'present.lifeBackground');
  ok(r.present.moodTint === true, 'present.moodTint');
  ok(r.text.includes('当前时间'), '时间状态仍最后');
}

console.log('\nT2 P3 中性 → 不注入（province 省预算）');
{
  const r = INJ.buildInjection({
    ...base,
    sources: {
      getProfile: () => 'p', getOverlay: () => '', getRelationshipTag: () => '',
      getContestHint: () => '', getOtherTags: () => [], getHighlights: () => '',
      getTimeState: () => '[时间]',
      getMoodTint: () => MOOD_TEXT.neutral,
    },
  });
  ok(r.present.moodTint === false, 'neutral 不注入');
  ok(!r.text.includes('偏'), '无情绪文案');
}

console.log('\nT3 超预算 → P3 被丢弃（不截半句）');
{
  const r = INJ.buildInjection({
    ...base,
    sources: {
      getProfile: () => 'p', getOverlay: () => '', getRelationshipTag: () => '',
      getContestHint: () => '', getOtherTags: () => [], getHighlights: () => '',
      getTimeState: () => '[时间]',
      getMoodTint: () => 'x'.repeat(200),   // 超 90 字预算
    },
  });
  ok(r.present.moodTint === false, '超预算整段丢弃');
  ok(!r.text.includes('xxx'), '无残留');
}

console.log('\nT4 失败隔离：P3 抛错不影响其他段');
{
  const r = INJ.buildInjection({
    ...base,
    sources: {
      getProfile: () => '【画像】在', getOverlay: () => '', getRelationshipTag: () => '',
      getContestHint: () => '', getOtherTags: () => [], getHighlights: () => '',
      getTimeState: () => '[时间]',
      getLifeBackground: () => '[背景板]在',
      getMoodTint: () => { throw new Error('P3 boom'); },
    },
  });
  ok(r.text.includes('画像'), '画像仍在');
  ok(r.text.includes('背景板'), '背景板仍在');
  ok(r.text.includes('[时间]'), '时间仍在');
  ok(r.present.moodTint === false, 'P3 缺席但没崩');
}

console.log('\nT5 失败隔离：P2 抛错不影响其他段');
{
  const r = INJ.buildInjection({
    ...base,
    sources: {
      getProfile: () => '【画像】在', getOverlay: () => '', getRelationshipTag: () => '',
      getContestHint: () => '', getOtherTags: () => [], getHighlights: () => '',
      getTimeState: () => '[时间]',
      getLifeBackground: () => { throw new Error('P2 boom'); },
      getMoodTint: () => MOOD_TEXT.warm,
    },
  });
  ok(r.text.includes('画像'), '画像仍在');
  ok(r.present.moodTint === true, 'P3 仍在');
  ok(r.present.lifeBackground === false, 'P2 缺席');
}

console.log('\nT6 全功能关闭 → 零注入');
{
  const r = INJ.buildInjection({
    ...base,
    sources: {
      getProfile: () => '', getOverlay: () => '', getRelationshipTag: () => '',
      getContestHint: () => '', getOtherTags: () => [], getHighlights: () => '',
      getTimeState: () => '',
      getLifeBackground: () => '',
      getMoodTint: () => '',
    },
  });
  ok(r.text.trim() === '', '空注入');
  ok(r.present.moodTint === false && r.present.lifeBackground === false, '两段都缺席');
}

console.log('\nT7 预算总量检查（工业标准：≤1200 字）');
{
  const r = INJ.buildInjection({
    ...base,
    sources: {
      getProfile: () => '【画像】' + 'x'.repeat(300),
      getOverlay: () => '', getRelationshipTag: () => '【关系】L2',
      getContestHint: () => '', getOtherTags: () => [], getHighlights: () => '',
      getTimeState: () => '[当前时间：2026-11-16 12:00，午后]',
      getLifeBackground: () => '[你的隐藏背景板：' + 'y'.repeat(100) + ']',
      getMoodTint: () => MOOD_TEXT.warm,
    },
  });
  const len = [...r.text].length;
  ok(len < 1200, `总长度 ${len} < 1200`);
  ok(r.present.moodTint === true, 'P3 未被挤掉');
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
if (fail) process.exitCode = 1;
