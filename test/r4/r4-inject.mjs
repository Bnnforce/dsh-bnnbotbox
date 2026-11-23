import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const root = mkdtempSync(join(process.cwd(), '.r4-inject-test-'));
process.env.PERSONA_DATA_ROOT = root;
process.on('exit', () => { try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ } });

const inject = await import('../../lib/persona/r4/inject.js');
const fuse = await import('../../lib/persona/r4/fuse.js');

let checks = 0;
const ok = (c, m) => { assert.ok(c, m); checks += 1; };
const eq = (a, b, m) => { assert.equal(a, b, m); checks += 1; };

const levels = { L0: '高信任', L1: '熟悉', L2: '普通', L3: '低互动' };
const fullSources = {
  getProfile: () => '[当前画像] 喜欢猫图，爱打游戏',
  getOverlay: () => '[错题本摘要] 别长篇大论。',
  getRelationshipTag: () => '[当前关系标签：熟悉]',
  getContestHint: () => fuse.CONTEST_HINT,
  getOtherTags: () => [{ userId: 'U9', text: '[U9：低互动]' }, { userId: 'U1', text: '[U1：普通]' }],
  getHighlights: () => '[高光] 这句绝了',
  getTimeState: () => '[当前时间：2026-11-03 20:00，夜晚。你最兴奋，活跃开玩笑。]',
};

/* ── 1. 全段在场时顺序严格符合图纸 3.1 ── */
const full = inject.buildInjection({ groupId: 'GID', userId: 'U1', persona: '爱莉希雅', levels, sources: fullSources });
eq(full.present.highlights, true, '高光在场');
eq(full.present.others, 2, '其他在场标签 2 个');
const order = ['[高光]', '[当前画像]', '[错题本摘要]', '[当前关系标签', '[提示：对低互动对象', '[U1：普通]', '[U9：低互动]', '[当前时间'];
let cursor = -1;
for (const needle of order) {
  const at = full.text.indexOf(needle);
  ok(at > cursor, `顺序：${needle} 位于前面各段之后（at=${at}）`);
  cursor = at;
}

/* ── 2. 其他在场标签按 userId 字典序（U1 在 U9 之前）── */
eq(full.text.indexOf('[U1：普通]') < full.text.indexOf('[U9：低互动]'), true, 'others 按字典序');

/* ── 3. used 口径 = 六段之和，不含高光（图纸 3.2）── */
const usedSections = [
  '[当前画像] 喜欢猫图，爱打游戏',
  '[错题本摘要] 别长篇大论。',
  '[当前关系标签：熟悉]',
  fuse.CONTEST_HINT,
  '[U1：普通]\n[U9：低互动]',
  '[当前时间：2026-11-03 20:00，夜晚。你最兴奋，活跃开玩笑。]',
];
// 2026-11-03 修复 P2-5：段间分隔符（\n\n）必须计入 1000 字口径
const expectUsed = usedSections.reduce((n, s) => n + [...s].length, 0) + (usedSections.length - 1) * 2;
eq(full.used, expectUsed, 'used = 六段之和 + 段间分隔符（不含高光）');
eq(fuse.charLen(full.text) > full.used, true, '正文含高光 → 正文总长大于预算口径');

/* ── 4. 回调抛错 → 降级为空，绝不抛（红线 0.1）── */
const throwing = {
  getProfile: () => { throw new Error('boom'); },
  getOverlay: () => { throw new Error('boom'); },
  getRelationshipTag: () => { throw new Error('boom'); },
  getContestHint: () => { throw new Error('boom'); },
  getOtherTags: () => { throw new Error('boom'); },
  getHighlights: () => { throw new Error('boom'); },
  getTimeState: () => '[当前时间：2026-11-03 20:00，夜晚。你最兴奋，活跃开玩笑。]',
};
const safeOut = inject.buildInjection({ groupId: 'GID', userId: 'U1', persona: '爱莉希雅', levels, sources: throwing });
eq(safeOut.present.profile, false, '抛错的画像降级为空');
eq(safeOut.present.others, 0, '抛错的 others 降级为空数组');
eq(safeOut.text, '[当前时间：2026-11-03 20:00，夜晚。你最兴奋，活跃开玩笑。]', '只剩时间状态（永不丢）');

/* ── 5. 无任何段 → 空注入（不注入垃圾）── */
const empty = inject.buildInjection({
  groupId: 'GID', userId: 'U1', persona: '爱莉希雅', levels,
  sources: {
    getProfile: () => '', getOverlay: () => '', getRelationshipTag: () => '',
    getContestHint: () => '', getOtherTags: () => [], getHighlights: () => '', getTimeState: () => '',
  },
});
eq(empty.text, '', '全空 → 空正文');
eq(empty.used, 0, '全空 → used=0');

/* ── 6. 超预算时从右往左丢，时间状态永不丢 ── */
const big = inject.buildInjection({
  groupId: 'GID', userId: 'U1', persona: '爱莉希雅', levels,
  sources: {
    getProfile: () => `[当前画像]${'啊'.repeat(600)}`,
    getOverlay: () => `[错题本摘要]${'啊'.repeat(600)}`,
    getRelationshipTag: () => '[当前关系标签：熟悉]',
    getContestHint: () => fuse.CONTEST_HINT,
    getOtherTags: () => [{ userId: 'U1', text: `[U1：普通]${'啊'.repeat(100)}` }],
    getHighlights: () => '[高光] 这句绝了',
    getTimeState: () => '[当前时间：2026-11-03 20:00，夜晚。你最兴奋，活跃开玩笑。]',
  },
});
eq(big.fused, true, '超预算 → 熔断');
eq(big.text.includes('[U1：普通]'), false, '第 1 步丢 others');
eq(big.text.includes('[提示：对低互动对象'), false, '第 2 步丢争宠');
eq(big.text.includes('[当前关系标签'), false, '第 3 步丢关系标签');
ok(big.used <= fuse.FUSE_BUDGET, '熔断后 ≤ 1000');
eq(big.text.includes('[当前时间'), true, '时间状态永不丢');
eq(big.text.includes('[高光]'), true, '高光永不丢');

/* ── 7. 关系标签渲染（缺 level → 按 L2「普通」）── */
eq(inject.relationshipTagOf('L0', levels), '[当前关系标签：高信任]', 'L0 标签');
eq(inject.relationshipTagOf('L3', levels), '[当前关系标签：低互动]', 'L3 标签');
eq(inject.relationshipTagOf(undefined, levels), '[当前关系标签：普通]', '缺省 → L2 普通');
eq(inject.otherTagText('U1', 'L1', levels), '[U1：熟悉]', '其他在场标签渲染');
eq(inject.otherTagText('U2', undefined, levels), '[U2：普通]', '其他在场标签缺省 L2');

/* ── 8. section 名唯一避免与 2.5.0 锚点冲突 ── */
eq(inject.r4SectionName('GID'), 'dsh-anti-ai-persona:r4:GID', 'section 名带群号前缀');
ok(inject.r4SectionName('GID') !== 'anti-ai-persona:anchors:GID', '不与旧锚点 section 重名');

/* ── 9. 诊断串不含正文内容（只含状态标记）── */
const desc = inject.describeInjection(full);
ok(desc.startsWith('[r4] 注入 '), '诊断前缀');
eq(desc.includes('喜欢猫图'), false, '诊断不含画像正文（避免日志泄漏内容）');
eq(desc.includes('used='), true, '诊断含 used');

console.log(`r4-inject: passed ${checks} checks`);
