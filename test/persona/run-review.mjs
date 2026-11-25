import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = mkdtempSync(join(process.cwd(), '.anti-ai-review-test-'));
process.env.DSH_HOME = root;
// 2026-11-02：断言失败时旧写法直接退出，临时目录留在仓库里（实测残留 2 个 ~100K 目录）。
// 统一挂 process exit 兜底，成功/失败都清。
process.on('exit', () => { try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ } });

const review = await import('../../lib/persona/review.js');
const store = await import('../../lib/persona/store.js');
const { createPromptInjector } = await import('../../lib/persona/prompt-injector.js');
const persona = await import('../../lib/persona/persona.js');

// persona 目录：模拟 Bot/人格 + dshqqbot persona 状态
const botRoot = join(root, 'bot');
const dataRoot = join(botRoot, 'dshqqbot');
const roleDir = join(botRoot, '人格', '角色卡');
const { mkdirSync, writeFileSync } = await import('node:fs');
mkdirSync(roleDir, { recursive: true });
writeFileSync(join(roleDir, '比安安.md'), '比安安角色卡');
writeFileSync(join(roleDir, '爱莉希雅.md'), '爱莉希雅角色卡');
writeFileSync(join(botRoot, '人格', 'persona-config.json'), JSON.stringify({ defaultPersona: '比安安' }));
writeFileSync(join(botRoot, '人格', 'persona-aliases.json'), JSON.stringify({ 爱莉希雅: ['爱莉'] }));
const stateDir = join(dataRoot, '.qqbot-extensions', 'data');
mkdirSync(stateDir, { recursive: true });
writeFileSync(join(stateDir, 'persona-groups.json'), JSON.stringify({ groups: { AAAA: { persona: '爱莉希雅' } } }));
assert.equal(persona.personaForGroup([dataRoot], 'AAAA'), '爱莉希雅');
assert.equal(persona.personaForGroup([dataRoot], 'BBBB'), '比安安');
const assembly = { sections: [{ text: '你是群聊角色卡：爱莉希雅' }] };
assert.equal(persona.personaForAssembly([dataRoot], assembly, 'BBBB'), '爱莉希雅');
assert.equal(persona.personaForAssembly([dataRoot], { sections: [{ text: '普通群聊' }] }, 'BBBB'), '比安安');

assert.equal(review.isCorrectionText('太长不看，说重点'), true);
assert.equal(review.isCorrectionText('今天吃什么'), false);
assert.equal(review.isCorrectionText('你像AI一样'), true);

const assistantEvent = {
  type: 'assistant/message',
  data: { message: { content: [{ type: 'text', text: '这是一段很长很长的机器人回复，堆了很多解释。' }] } },
};
const userEvent = {
  type: 'user/message',
  data: { source: { kind: 'user' }, message: { content: [{ type: 'text', text: '太长不看' }] } },
};
assert.equal(review.eventText(assistantEvent).includes('很长很长'), true);
assert.equal(review.eventText(userEvent), '太长不看');
assert.equal(review.isRealUserMessage(userEvent), true);
assert.equal(review.isRealUserMessage({ type: 'user/message', data: { source: { kind: 'runtime-context' } } }), false);

const now = Date.now();
review.appendReviewRecord({
  at: now,
  sessionId: 'SID-A',
  groupId: 'AAAA',
  persona: '爱莉希雅',
  userText: '太长不看',
  assistantText: '这是一段很长的机器人回复',
});
review.appendReviewRecord({
  at: now - 25 * 60 * 60 * 1000,
  sessionId: 'SID-OLD',
  groupId: 'AAAA',
  userText: '说人话',
  assistantText: '过期回复',
});
const records = review.readReviewRecords(24 * 60 * 60 * 1000);
assert.equal(records.length, 1, '24h 外的记录应被过滤');
assert.equal(records[0].groupId, 'AAAA');
assert.equal(records[0].persona, '爱莉希雅');
// 2026-11-02：错题本改为「按实际人格分流」（不再只特判比安安）。
assert.ok(review.reviewBufferPath().endsWith('/review-buffer.jsonl'), '无人格 → 主本');
assert.ok(review.reviewBufferPath('爱莉希雅').endsWith('/review-buffer-爱莉希雅.jsonl'), '具名人格 → 自己的本子');
assert.ok(review.reviewBufferPath('比安安').endsWith('/review-buffer-biananan.jsonl'), '比安安保留历史文件名（老数据兼容）');
assert.equal(review.reviewBufferName(''), 'review-buffer.jsonl');
assert.equal(review.reviewBufferName('爱莉希雅'), 'review-buffer-爱莉希雅.jsonl');
assert.equal(review.reviewBufferName('比安安'), 'review-buffer-biananan.jsonl');
assert.equal(review.reviewBufferName('a/b:c'), 'review-buffer-a_b_c.jsonl', '非法路径字符应被替换');
// 两个错题本都必须被复盘读到（原来漏了比安安本）
review.appendReviewRecord({ at: now, sessionId: 'SID-BA', groupId: 'BBBB', persona: '比安安', userText: '[自动判官] 客服腔', assistantText: '客服腔回复' });
assert.equal(review.readReviewRecords(24 * 60 * 60 * 1000).filter((r) => r.persona === '比安安').length, 1, '比安安错题本应被读取');
// 新增人格的本子同样能被读到（扫目录，不再写死文件名）
review.appendReviewRecord({ at: now, sessionId: 'SID-ELY', groupId: 'AAAA', persona: '爱莉希雅', userText: '[自动判官] 列表排版', assistantText: '1. a 2. b' });
assert.equal(review.readReviewRecords(24 * 60 * 60 * 1000).filter((r) => r.persona === '爱莉希雅').length, 2, '爱莉希雅错题本应被读取（扫目录）');
assert.ok(review.listReviewBufferFiles().some((f) => f === 'review-buffer-爱莉希雅.jsonl'), '应列出新人格本子');

const prompt = review.buildReviewPrompt(records, ['普通群聊：今天下班了吗']);
assert.ok(prompt.includes('反面教材'));
assert.ok(prompt.includes('太长不看'));
assert.ok(prompt.includes('普通群聊'));
assert.ok(prompt.includes('3 条避坑指南'));
assert.ok(review.REVIEW_SYSTEM.includes('3 条以内'));
assert.ok(review.REVIEW_SYSTEM.includes('40 个字'));
assert.ok(review.REVIEW_SYSTEM.includes('完整的话'));

assert.deepEqual(review.parseReviewOutput('- 回复短一点\n- 少用句号\n- 不要像 AI'), [
  '回复短一点', '少用句号', '不要像 AI',
]);
assert.deepEqual(review.parseReviewOutput('1. 别太长\n2. 别解释\n3. 别像AI'), [
  '别太长', '别解释', '别像AI',
]);
assert.equal(review.parseReviewOutput('只有一句').length, 0, '不足 3 条不应接受');

const fakeLlm = {
  listProviders: () => [{ id: 'p1', name: 'Provider 1' }],
  listModels: async () => [{ id: 'chat-pro', name: 'Pro' }, { id: 'flash-lite', name: 'Flash Lite' }],
};
const route = await review.resolveReviewRoute(fakeLlm);
assert.deepEqual(route, { provider: 'p1', model: 'flash-lite' });
const explicit = await review.resolveReviewRoute(fakeLlm, 'p1', 'chat-pro');
assert.deepEqual(explicit, { provider: 'p1', model: 'chat-pro' });

const fakeStreamLlm = {
  stream(options) {
    assert.equal(options.provider, 'p1');
    assert.equal(options.model, 'flash-lite');
    assert.ok(String(options.messages?.[0]?.content?.[0]?.text || '').includes('太长不看'));
    return (async function* () {
      yield { type: 'text-delta', text: '- 回复短一点\n' };
      yield { type: 'text-delta', text: '- 少用句号\n' };
      yield { type: 'text-delta', text: '- 别像 AI\n' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    })();
  },
};
const output = await review.callReviewLLM(fakeStreamLlm, route, prompt);
assert.ok(output.includes('回复短一点'));

const saved = review.saveReviewOverlay(output);
assert.deepEqual(saved, ['回复短一点', '少用句号', '别像 AI']);
const overlay = store.readOverlaySync();
assert.ok(!overlay.includes('[近期行为禁忌'), '文件只存正文，不存包装标签');
assert.ok(overlay.includes('回复短一点'));
// ★ 2026-11-25：不硬编码目录名——用 store 自己的路径函数（数据根可能是 dsh-anti-ai-persona 或 bnn-botbox）。
assert.ok(existsSync(store.overlayPath()));
store.writeOverlaySync('## 比安安专属\n- 短一点', 'AAAA', '比安安');
store.writeOverlaySync('## 爱莉希雅专属\n- 更活泼', 'AAAA', '爱莉希雅');
assert.ok(store.readOverlaySync('AAAA', '比安安').includes('比安安专属'));
assert.ok(store.readOverlaySync('AAAA', '爱莉希雅').includes('爱莉希雅专属'));
assert.ok(!store.readOverlaySync('AAAA', '比安安').includes('爱莉希雅专属'));
assert.ok(store.overlayPath('AAAA', '比安安').endsWith('/overlay/AAAA_比安安.md'));

// 旧 overlay 产生备份
review.saveReviewOverlay('- 新规则一\n- 新规则二\n- 新规则三');
const backups = review.listOverlayBackups();
assert.ok(backups.length >= 1, '保存新 overlay 前应有旧版备份');

// 标点截断：不得从句子中间砍断
const longRule = '遇到新闻和事实查询时，严禁使用来源播报格式，要用一句吐槽带过，并且不要解释为什么这样回答。';
const cut = review.truncateOverlayRule(longRule, 50);
assert.ok([...cut].length <= 50, `截断后应 <=50 字: ${[...cut].length}`);
assert.ok(/[。！？；，、,.!?;]$/u.test(cut), '截断必须落在标点后');
assert.ok(longRule.startsWith(cut), '截断应保留前缀，不制造新句');
const noPunct = '这一条规则是一整句没有任何标点但是长度明显超过五十个字的规则需要保持完整不能被从中间砍掉';
assert.equal(review.truncateOverlayRule(noPunct, 50), noPunct, '无标点时保留完整句子，不从中间砍');

// Overlay 限制：合并去重、最多 6 条、400 字内、保留绝对禁止
store.writeOverlaySync([
  '## 旧 overlay',
  '- 不要长篇大论',
  '- 客服腔很重',
  '- 普通规则一',
  '- 普通规则二',
  '- 普通规则三',
  '- 普通规则四',
  '- 普通规则五',
  '- 绝对禁止串台',
].join('\n'), 'MERGE', '比安安');
const merged = review.saveReviewOverlay('- 不要写小作文\n- 新规则甲\n- 新规则乙', 'MERGE', '比安安');
assert.ok(merged.length <= 6, `overlay 最多 6 条，实际 ${merged.length}`);
const mergedText = store.readOverlaySync('MERGE', '比安安');
const mergedRules = mergedText.split('\n').filter((l) => /^\s*-\s+/u.test(l));
assert.ok(mergedRules.length <= 6, `文件规则数 ${mergedRules.length}`);
assert.ok([...mergedText].length <= 400, `overlay 超过 400 字: ${[...mergedText].length}`);
assert.ok(mergedText.includes('绝对禁止串台'), '严重规则应优先保留');
assert.ok(mergedRules.every((l) => [...l.replace(/^\s*-\s+/u, '')].length <= 50), '每条规则不得超过 50 字');
assert.ok(!(mergedText.includes('长篇大论') && mergedText.includes('小作文')), '相似规则应合并');
const two = review.saveReviewOverlay('- 只有一条\n- 第二条', 'TWO', '比安安');
assert.equal(two.length, 2, '允许 1~3 条');

// Overlay 注入：2026-11-02 起 guideline / overlay / 高光合并为**一个**锚点 section 追加到末尾
store.writeGuidelineSync('AAAA', '【本群语感参考】\n短句。');
const injector = createPromptInjector({
  getGuideline: (id) => store.readGuidelineSync(id),
  refresh: () => {},
  staleAfterMs: 24 * 60 * 60 * 1000,
  now: () => Date.now(),
});
const base = { sections: [{ name: 'base', text: 'base' }] };
const assembled = await injector(base, { channel: { id: 'group_AAAA' } }, async () => base);
assert.equal(assembled.sections.length, 2, '一个整体锚点 section');
assert.equal(assembled.sections[0].text, 'base', '原 sections 必须保持不变、且在锚点之前');
assert.equal(assembled.sections[1].name, 'anti-ai-persona:anchors:AAAA');
const anchorText = assembled.sections[1].text;
assert.ok(anchorText.includes('【本群语感氛围参考】'), '锚点段含本群语感');
assert.ok(anchorText.includes('【近期行为禁忌（自我反省补丁）】'), '锚点段含禁忌 overlay');
assert.ok(anchorText.includes('新规则一'), '锚点段含具体规则正文');
assert.ok(anchorText.startsWith('\n[灵魂锚点'), '锚点段以最高优先级声明开头');
// ── 2026-11-05 方案 C：代码请求例外条款必须常驻锚点 ──
assert.ok(anchorText.includes('例外条款：代码请求'), '锚点必须含代码请求例外条款');
assert.ok(anchorText.includes('25 字'), '代码豁免必须显式点名 25 字规则');
assert.ok(anchorText.includes('代码本身不算 OOC'), '代码豁免必须声明代码不算 OOC');
assert.ok(anchorText.includes('代码块'), '代码豁免必须要求使用标准代码块');

// 2026-11-05 方案 C：连一句语料都没有的群，也要注入常驻的代码豁免
const bareInjector = createPromptInjector({
  getGuideline: () => '',
  refresh: () => {},
  getHighlights: () => [],
  staleAfterMs: 24 * 60 * 60 * 1000,
  now: () => Date.now(),
});
const bareAssembled = await bareInjector(base, { channel: { id: 'group_ZZZZ' } }, async () => base);
assert.equal(bareAssembled.sections.length, 2, '无语料也应注入常驻代码豁免');
assert.ok(bareAssembled.sections[1].text.includes('例外条款：代码请求'), '无语料群的锚点仍须含代码豁免');

// 按人格注入：只读当前人格 overlay
const personaInjector = createPromptInjector({
  getGuideline: (id) => store.readGuidelineSync(id),
  refresh: () => {},
  staleAfterMs: 24 * 60 * 60 * 1000,
  resolvePersona: () => '爱莉希雅',
  now: () => Date.now(),
});
const personaAssembled = await personaInjector(base, { channel: { id: 'group_AAAA' } }, async () => base);
assert.equal(personaAssembled.sections.length, 2);
assert.ok(personaAssembled.sections[1].text.includes('爱莉希雅专属'));
assert.ok(!personaAssembled.sections[1].text.includes('比安安专属'));

// 当前人格没有专属 overlay 时，回落到全局 overlay.md
store.writeOverlaySync('## 全局兜底\n- 全局规则', '', '');
const fallbackInjector = createPromptInjector({
  getGuideline: (id) => store.readGuidelineSync(id),
  refresh: () => {},
  staleAfterMs: 24 * 60 * 60 * 1000,
  resolvePersona: () => '不存在的人格',
  now: () => Date.now(),
});
const fallbackAssembled = await fallbackInjector(base, { channel: { id: 'group_AAAA' } }, async () => base);
assert.equal(fallbackAssembled.sections.length, 2);
assert.ok(fallbackAssembled.sections[1].text.includes('全局兜底'));

// ── 2026-11-02 新增：灵魂锚点三层（guideline + overlay + 高光）──
{
  const hl = await import('../../lib/persona/highlights.js');
  assert.equal(hl.isPraiseText('这句绝了'), true, '「这句绝了」应识别为夸赞');
  assert.equal(hl.isPraiseText('真像爱莉'), true);
  assert.equal(hl.isPraiseText('满分！'), true);
  assert.equal(hl.isPraiseText('这也叫满分？'), false, '反问/否定不算夸赞');
  assert.equal(hl.isPraiseText('太长了，说人话'), false, '纠偏不算夸赞');
  assert.equal(hl.isPraiseText('你像AI一样'), false, '负语境排除');
  assert.equal(hl.isPraiseText('今天吃什么'), false);

  assert.equal(hl.appendHighlight({ groupId: 'AAAA', persona: '爱莉希雅', text: '哎呀，被你发现了呢～' }), true);
  assert.equal(hl.appendHighlight({ groupId: 'AAAA', persona: '爱莉希雅', text: '哎呀，被你发现了呢～' }), false, '同句应去重');
  assert.equal(hl.appendHighlight({ groupId: 'BBBB', persona: '比安安', text: '哼，才不是特意等你呢。' }), true);
  assert.equal(hl.highlightCount(), 2);
  const recent = hl.readRecentHighlights(2);
  assert.equal(recent.length, 2);
  assert.equal(recent[0].text, '哼，才不是特意等你呢。', '最近一条排最前');

  const hlInjector = createPromptInjector({
    getGuideline: (id) => store.readGuidelineSync(id),
    refresh: () => {},
    staleAfterMs: 24 * 60 * 60 * 1000,
    highlightLimit: 2,
    now: () => Date.now(),
  });
  const hlAssembled = await hlInjector(base, { channel: { id: 'group_AAAA' } }, async () => base);
  const hlAnchor = hlAssembled.sections[1].text;
  assert.ok(hlAnchor.includes('【高光锚点'), '锚点段应含高光块');
  // ⚠️ 2026-11-08 修（P1-2 跨群串味修复后的陈旧断言）：
  //   高光从 2026-11-06 起**按群过滤**（`readRecentHighlights(limit, groupId)`），
  //   所以 AAAA 群只能看到自己那条；旧断言要求两条都出现，等于把串群 bug 当正确。
  assert.ok(hlAnchor.includes('哎呀，被你发现了呢'), 'AAAA 群应看到自己的高光');
  assert.ok(!hlAnchor.includes('哼，才不是特意等你呢。'), 'AAAA 群不应看到 BBBB 群的高光（跨群不串味）');

  // BBBB 群：能看到自己那条，看不到 AAAA 的
  const bbAssembled = await hlInjector(base, { channel: { id: 'group_BBBB' } }, async () => base);
  const bbAnchor = bbAssembled.sections[1].text;
  assert.ok(bbAnchor.includes('哼，才不是特意等你呢。'), 'BBBB 群应看到自己的高光');
  assert.ok(!bbAnchor.includes('哎呀，被你发现了呢'), 'BBBB 群不应看到 AAAA 群的高光');

  // 三层顺序：语感 → 禁忌 → 高光
  assert.ok(hlAnchor.indexOf('【本群语感氛围参考】') < hlAnchor.indexOf('【近期行为禁忌（自我反省补丁）】'));
  assert.ok(hlAnchor.indexOf('【近期行为禁忌（自我反省补丁）】') < hlAnchor.indexOf('【高光锚点'));

  // highlightLimit:0 应关闭高光注入
  const offInjector = createPromptInjector({
    getGuideline: (id) => store.readGuidelineSync(id),
    refresh: () => {},
    staleAfterMs: 24 * 60 * 60 * 1000,
    highlightLimit: 0,
    now: () => Date.now(),
  });
  const offAssembled = await offInjector(base, { channel: { id: 'group_AAAA' } }, async () => base);
  assert.ok(!offAssembled.sections[1].text.includes('【高光锚点'), 'highlightLimit:0 应关闭');

  // 高光容量上限
  for (let i = 0; i < 80; i += 1) hl.appendHighlight({ groupId: 'AAAA', persona: '爱莉希雅', text: `第${i}条测试高光句子。` });
  assert.ok(hl.highlightCount() <= hl.HIGHLIGHT_MAX_RECORDS, `高光条数不应超过 ${hl.HIGHLIGHT_MAX_RECORDS}，实际 ${hl.highlightCount()}`);
}

// ── 2026-11-02 新增：complete:true 防御 ──
{
  const completeBase = { sections: [{ name: 'persona', text: 'PERSONA_ONLY', complete: true }] };
  const ci = createPromptInjector({
    getGuideline: () => '本群语感：短句。',
    refresh: () => {},
    staleAfterMs: 24 * 60 * 60 * 1000,
    now: () => Date.now(),
  });
  const out = await ci(completeBase, { channel: { id: 'group_AAAA' } }, async () => completeBase);
  assert.equal(out.sections.length, 1, '有 complete section 时不应新增 section（宿主会丢）');
  assert.equal(out.sections[0].name, 'persona');
  assert.ok(out.sections[0].text.startsWith('PERSONA_ONLY'), '原正文必须保留在最前');
  assert.ok(out.sections[0].text.includes('[灵魂锚点'), '锚点应改写进 complete 段内部');
}

console.log('review tests passed');

rmSync(root, { recursive: true, force: true });
