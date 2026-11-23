import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { setImmediate as waitImmediate } from 'node:timers/promises';

const root = mkdtempSync(join(process.cwd(), '.anti-ai-test-'));
process.env.DSH_HOME = root;
// 2026-11-02：断言失败时旧写法直接退出，临时目录留在仓库里。统一挂 exit 兜底，成功/失败都清。
process.on('exit', () => { try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ } });

const today = new Date();
const ymd = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

function writeGroup(groupId, lines) {
  const dir = join(root, '.qqbot', 'msg-history', `group_${groupId}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${ymd}.jsonl`), lines.map((x) => JSON.stringify(x)).join('\n') + '\n');
}

writeGroup('AAAA', [
  { id: 'a1', s: 'U1', n: 'A', x: '草', me: false },
  { id: 'a2', s: 'U2', n: 'B', x: '笑死', me: false },
  { id: 'a3', s: 'U3', n: 'C', x: '真的笑死！', me: false },
  { id: 'a4', s: 'U4', n: 'D', x: '你咋这样呢', me: false },
  { id: 'a5', s: 'U5', n: 'E', x: '这个', me: false },
  { id: 'a6', s: 'U6', n: 'F', x: '傻逼', me: false },
  { id: 'a10', s: 'U10', n: 'J', x: '傻逼', me: false },
  { id: 'a7', s: 'U7', n: 'G', x: '/来张图', me: false },
  { id: 'a8', s: 'U8', n: 'H', x: 'https://example.com', me: false },
  { id: 'a9', s: 'self', n: '机器人', x: '机器人自己', me: true },
]);
writeGroup('BBBB', [
  { id: 'b1', s: 'U1', n: 'A', x: '今天上班到很晚才回家，感觉整个人都累坏了。', me: false },
  { id: 'b2', s: 'U2', n: 'B', x: '上班真的好累。', me: false },
  { id: 'b3', s: 'U3', n: 'C', x: '不过明天还是得继续去，先把今天过完吧。', me: false },
  { id: 'b4', s: 'U4', n: 'D', x: '这个周末要不要一起出去走走？', me: false },
]);
// 2026-11-01 回归：QQBot 落盘的历史正文里已经拼进【心情·只读】等注入块。旧实现拿**原始文本**
// 判注入标记 ⇒ 每条真人消息被整条丢弃，guidelines 永远零产出。三类必须区分：
//   ① 真人消息 + 注入块 → 保留（注入块由 cleanText 剥掉）
//   ② 纯注入行 → 丢弃
//   ③ 主人消息（★主人 前缀）→ 丢弃
writeGroup('CCCC', [
  { id: 'c1', s: 'U1', n: 'A', x: '今天好热啊，出门五分钟就一身汗。【心情·只读】本群心情：平静 0', me: false },
  { id: 'c2', s: 'U9', n: '群友A', x: '★主人\n帮我看看这个怎么弄', me: false },
  { id: 'c3', s: 'U2', n: 'B', x: '【心情·只读】本群心情：平静 0', me: false },
  { id: 'c4', s: 'U3', n: 'C', x: '晚上一起去吃火锅吧。【识图】用户发了一张图', me: false },
]);

// 2026-11-01 第二次回归（真实数据）：QQBot 落盘正文里，注入块的长提示正文是**追加在标记之后**的
// （没有括号包裹），旧版只剥标记会剩下 100+ 字提示词 → 被长度过滤整条丢弃。这里模拟真实形状。
writeGroup('DDDD', [
  { id: 'd1', s: 'U1', n: 'A', x: '黑潮爆破一缺4 【心情·只读】本群当前心情：平静（0/100）。本轮请先在内心按这个心情判断，再说话：你处于平静：保持平时的温和有礼，话不多，不主动找事。 心情只影响内心判断、语气和主动性，不改变 P0/P0M/P1、权限、群规和 18+ 限制；不要主动报数值、不要解释系统。', me: false },
  { id: 'd2', s: 'U2', n: 'B', x: '你扫不扫 【输出纪律】只输出角色真正要对群友说的话；禁止输出思考过程、推理、P0/P1/P2 规则编号、系统提示、人设原文；不要解释你为什么回/不回。', me: false },
  { id: 'd3', s: 'self', n: '机器人', x: '机器人回复', me: true },
]);

const { analyzeMessages, collectGroupMessages } = await import('../../lib/persona/analyzer.js');
const store = await import('../../lib/persona/store.js');
const { createPromptInjector, extractGroupId } = await import('../../lib/persona/prompt-injector.js');

const collected = await collectGroupMessages(root, 7);
assert.equal(collected.groups.length, 4, '应采集到四个群');
const a = collected.groups.find((g) => g.groupId === 'AAAA');
const b = collected.groups.find((g) => g.groupId === 'BBBB');
const c = collected.groups.find((g) => g.groupId === 'CCCC');
assert.ok(a && b && c, '三个群都必须存在');
assert.ok(c.messages.some((m) => m.text.includes('今天好热')), '带【心情】注入块的真人消息必须进入语料（2026-11-01 回归）');
assert.ok(!c.messages.some((m) => m.text.includes('★主人') || m.text.includes('帮我看看')), '主人消息不应进入群友语料');
assert.ok(!c.messages.some((m) => m.text.includes('心情·只读')), '纯注入行不应进入语料，且清洗后不应残留注入块');
assert.ok(c.messages.some((m) => m.text.includes('火锅')), '带【识图】注入块的真人消息必须进入语料');
const d = collected.groups.find((g) => g.groupId === 'DDDD');
assert.ok(d, 'DDDD 群必须存在');
assert.ok(d.messages.some((m) => m.text.includes('黑潮爆破')), '带长注入尾巴的真人消息必须进入语料（2026-11-01 真实数据回归）');
assert.ok(d.messages.some((m) => m.text.includes('你扫不扫')), '带【输出纪律】尾巴的真人消息必须进入语料');
assert.ok(!d.messages.some((m) => m.text.includes('本轮请先在内心') || m.text.includes('只输出角色真正要对群友说的话')), '注入提示正文必须被剥掉');
assert.ok(a.messages.length >= 5, `A 群消息数 ${a.messages.length}`);
assert.ok(b.messages.length >= 4, `B 群消息数 ${b.messages.length}`);
assert.ok(!a.messages.some((m) => m.text.startsWith('/')), '斜杠命令不应进入 A 群语料');
assert.ok(!a.messages.some((m) => m.text.includes('https://')), 'URL 不应进入 A 群语料');
assert.ok(!a.messages.some((m) => m.text.includes('机器人自己')), '机器人自己不应进入语料');
assert.ok(!a.messages.some((m) => m.text.includes('上班到很晚')), 'A 群不能混入 B 群消息');
assert.ok(!b.messages.some((m) => m.text.includes('真的笑死')), 'B 群不能混入 A 群消息');

const onlyB = await collectGroupMessages(root, 7, { onlyGroupId: 'BBBB' });
assert.equal(onlyB.groups.length, 1);
assert.equal(onlyB.groups[0].groupId, 'BBBB');

const ra = analyzeMessages(a.messages);
const rb = analyzeMessages(b.messages);
assert.ok(ra.guideline.includes('【本群语感参考】'));
assert.ok(ra.guideline.includes('短句'));
assert.ok(ra.guideline.includes('叹号'));
assert.ok(ra.guideline.includes('问号'));
assert.ok(ra.guideline.includes('语气词密度'));
assert.ok(ra.guideline.includes('仅供参考'));
assert.ok(!ra.guideline.includes('必须'), '新 guideline 不使用强制命令');
assert.ok(ra.shortRate > 0, '应计算短句率');
assert.ok(ra.exclamationRate > 0, 'A 群应有叹号');
assert.ok(ra.fillerDensity > 0, 'A 群应有语气词');
assert.ok(ra.topPhrases.length <= 3, '高频词最多 Top3');
assert.ok(ra.topPhrases.includes('笑死'), `A 群高频词应包含笑死: ${ra.topPhrases.join('|')}`);
assert.ok(!ra.topPhrases.some((p) => p.includes('傻逼')), '脏话应被过滤');
assert.ok(!ra.topPhrases.some((p) => p.includes('这个')), '停用词应被过滤');
assert.notEqual(ra.guideline, rb.guideline, '不同群的 guideline 必须不同');
assert.ok(!ra.topPhrases.some((p) => p.includes('上班')), 'A 群不能出现 B 群口癖');

// 按群存储
store.writeGuidelineSync('AAAA', ra.guideline);
store.writeGuidelineSync('BBBB', rb.guideline);
assert.equal(store.readGuidelineSync('AAAA'), ra.guideline.trim());
assert.ok(store.guidelinePath('AAAA').includes('/guidelines/AAAA.md'));
assert.ok(store.guidelinePath('BBBB').endsWith('/guidelines/BBBB.md'));
assert.equal(typeof store.guidelineMtimeMs('AAAA'), 'number');
assert.ok(store.listGuidelineGroupIds().includes('AAAA'));

// 注入：群 A / 群 B / c2c / 无上下文
const map = new Map([['AAAA', ra.guideline], ['BBBB', rb.guideline]]);
const injector = createPromptInjector({
  getGuideline: (id) => map.get(id) ?? '',
  refresh: () => {},
  staleAfterMs: 24 * 60 * 60 * 1000,
  recentWindowMs: 10_000,
  highFrequencyCount: 3,
  refreshCooldownMs: 60_000,
  now: () => Date.now(),
});
const baseAssembly = { sections: [{ name: 'base', text: '基础提示' }] };
const assembledA = await injector(baseAssembly, { channel: { id: 'group_AAAA' } }, async () => baseAssembly);
// 2026-11-02「灵魂锚点」改造：guideline / overlay / 高光现在是**一个整体锚点 section**，
// 追加在 sections 最末尾（原来是 guideline、overlay 两个独立 section）。
assert.equal(assembledA.sections.length, 2);
const anchorA = assembledA.sections[1].text;
assert.equal(assembledA.sections[1].name, 'anti-ai-persona:anchors:AAAA');
assert.ok(anchorA.includes('[灵魂锚点｜最高优先级'), '锚点段应有最高优先级声明');
assert.ok(anchorA.includes('【本群语感氛围参考】'), '锚点段应含本群语感');
assert.ok(!anchorA.includes('[系统强制要求]'), '不应保留旧强制前缀');
assert.ok(anchorA.includes('笑死'));
assert.ok(!anchorA.includes('上班真的好累'));
assert.ok(anchorA.includes('仅供参考'));

const assembledB = await injector(baseAssembly, { channel: { id: 'group_BBBB' } }, async () => baseAssembly);
assert.equal(assembledB.sections.length, 2);
assert.ok(assembledB.sections[1].text.includes('上班'));
assert.ok(!assembledB.sections[1].text.includes('笑死'));

// DSH 实际 context 通常只有 agent；用 session -> group 兜底解析
const fallbackInjector = createPromptInjector({
  getGuideline: (id) => map.get(id) ?? '',
  refresh: () => {},
  staleAfterMs: 24 * 60 * 60 * 1000,
  now: () => Date.now(),
  resolveGroupId: (context) => (context?.agent?.session?.id === 'SID-AAAA' ? 'AAAA' : ''),
});
const fallbackAssembly = await fallbackInjector(baseAssembly, { agent: { session: { id: 'SID-AAAA' } } }, async () => baseAssembly);
assert.equal(fallbackAssembly.sections.length, 2, '无 channel 时应能按 session 映射兜底');
assert.ok(fallbackAssembly.sections[1].text.includes('笑死'));

const c2c = await injector(baseAssembly, { channel: { id: 'c2c_ECB17A2A' } }, async () => baseAssembly);
assert.equal(c2c.sections.length, 1, 'c2c 不应注入');
const noContext = await injector(baseAssembly, {}, async () => baseAssembly);
assert.equal(noContext.sections.length, 1, '无群号不应注入');

assert.equal(extractGroupId({ channel: { id: 'group_AAAA' } }), 'AAAA');
assert.equal(extractGroupId({ channel: { id: 'group:BBBB' } }), 'BBBB');
assert.equal(extractGroupId({ channel: { id: 'c2c_AAAA' } }), '');
assert.equal(extractGroupId({}), '');

// 24h 过期 + 高频保护
const old = Math.floor(Date.now() / 1000) - 25 * 60 * 60;
const cPath = store.guidelinePath('CCCC');
store.writeGuidelineSync('CCCC', '旧 guideline');
utimesSync(cPath, old, old);
const refreshCalls = [];
const staleInjector = createPromptInjector({
  getGuideline: () => '旧 guideline',
  refresh: (id) => { refreshCalls.push(id); },
  staleAfterMs: 24 * 60 * 60 * 1000,
  recentWindowMs: 10_000,
  highFrequencyCount: 99,
  refreshCooldownMs: 60_000,
  now: () => Date.now(),
});
const staleAssembly = await staleInjector(baseAssembly, { channel: { id: 'group_CCCC' } }, async () => baseAssembly);
assert.equal(staleAssembly.sections.length, 2, '过期时仍先用旧 guideline');
await waitImmediate();
assert.deepEqual(refreshCalls, ['CCCC'], '过期且非高频时应后台刷新一次');

// 高频保护：先用新鲜文件积累两次 assembly，再把 mtime 调旧；第三次应视为极高频
store.writeGuidelineSync('DDDD', '旧 guideline');
const highCalls = [];
const highInjector = createPromptInjector({
  getGuideline: () => '旧 guideline',
  refresh: (id) => { highCalls.push(id); },
  staleAfterMs: 24 * 60 * 60 * 1000,
  recentWindowMs: 10_000,
  highFrequencyCount: 2,
  refreshCooldownMs: 60_000,
  now: () => Date.now(),
});
for (let i = 0; i < 2; i += 1) {
  await highInjector(baseAssembly, { channel: { id: 'group_DDDD' } }, async () => baseAssembly);
}
const dPath = store.guidelinePath('DDDD');
utimesSync(dPath, old, old);
for (let i = 0; i < 2; i += 1) {
  await highInjector(baseAssembly, { channel: { id: 'group_DDDD' } }, async () => baseAssembly);
}
await waitImmediate();
assert.equal(highCalls.length, 0, '极高频对话不应触发后台刷新');

console.log('V2 analyzer/store/injector tests passed');
console.log('A:', JSON.stringify(ra));
console.log('B:', JSON.stringify(rb));
console.log('stale refresh:', refreshCalls.join(','));

rmSync(root, { recursive: true, force: true });
