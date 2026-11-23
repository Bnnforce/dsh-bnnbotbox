import assert from 'node:assert/strict';

const judge = await import('../../lib/persona/judge.js');

assert.equal(judge.shouldJudge('短句', 15, 1).judge, false);
assert.equal(judge.shouldJudge('这是一段超过十五个字的普通回复，没有格式特征需要审查。', 15, 1).judge, true);
const hard = judge.shouldJudge('1. 凯文\n2. 爱莉', 15, 1);
assert.equal(hard.hardFail, true, '数字列表必须本地直接判死');
assert.equal(hard.judge, false);
assert.equal(hard.reason, '使用了数字/无序列表排版');
assert.equal(judge.hasListLayout('- 第一条\n- 第二条'), true);
assert.equal(judge.hasListLayout('- 单条'), false);
assert.equal(judge.shouldJudge('- 第一条\n- 第二条', 15, 1).judge, false, '双条无序列表应硬失败');
assert.equal(judge.shouldJudge('```js\nconsole.log(1)\n```', 15, 1).judge, true, '代码块即使短也应送审');
assert.equal(judge.shouldJudge('这是一段很长很长很长的文本，应该被审查。', 15, 0).judge, false);
assert.equal(judge.shouldJudge('这是一段很长很长很长的文本，应该被审查。', 15, 0.5, () => 0.9).judge, false);
assert.equal(judge.shouldJudge('这是一段很长很长很长的文本，应该被审查。', 15, 0.5, () => 0.1).judge, true);

// ── 2026-11-05 方案 B：代码排版本地强杀（不调模型，省时间省 Token）──
assert.equal(judge.hasBareCodeLayout('我给你写个排序：\ndef bubble(arr):\n    return arr'), true, '代码裸奔（无代码块）必须命中');
assert.equal(judge.hasBareCodeLayout('```python\ndef bubble(arr):\n    return arr\n```'), false, '标准代码块不算');
assert.equal(judge.hasBareCodeLayout('```python，def bubble(arr)：return arr```'), true, '代码被压成一行必须命中');
assert.equal(judge.hasBareCodeLayout('那台 python 都烧到 97% 了，可比我用功多啦。'), false, '闲聊提 python 不能误杀');
assert.equal(judge.hasBareCodeLayout('我刚刚用 const 声明了一个量，但没写代码。'), false, '提到 const 但无代码结构不能误杀');
assert.equal(judge.hasBareCodeLayout('普通回复，一点代码都没有。'), false, '普通回复不能命中');
const bareCode = judge.shouldJudge('好的，我给你写：\ndef bubble(arr):\n    return arr', 15, 1);
assert.equal(bareCode.hardFail, true, '代码裸奔必须本地直接判死');
assert.equal(bareCode.judge, false, '硬判死不应再调模型');
assert.equal(bareCode.reason, '代码排版拥挤/未使用代码块');
assert.equal(judge.shouldJudge('```python\ndef bubble(arr):\n    return arr\n```', 15, 1).judge, true, '标准代码块应送审');

const prompt = judge.judgePrompt('爱莉希雅', '这是一段很长的回复');
assert.ok(prompt.includes('爱莉希雅'));
assert.ok(prompt.includes('这是一段很长的回复'));
assert.ok(prompt.includes('【FAIL】'));
assert.ok(prompt.includes('【PASS】'));
assert.ok(prompt.includes('【严厉警告】'));
assert.ok(prompt.includes('群聊不是百科全书'));
// ── 2026-11-02 新增：人设豁免（主人明确要求「防误杀判官」）──
assert.ok(prompt.includes('人设豁免'), '必须写入人设豁免段');
assert.ok(prompt.includes('傲娇'), '傲娇必须列为豁免');
assert.ok(prompt.includes('调侃'), '调侃必须列为豁免');
assert.ok(prompt.includes('故意卖关子'), '卖关子必须列为豁免');
assert.ok(prompt.includes('自恋'), '自恋必须列为豁免');
assert.ok(prompt.includes('绝对不属于 OOC'), '必须写明不属于 OOC');
assert.ok(prompt.includes('必须判 PASS'), '豁免项必须判 PASS');
// 只在明确 5 类问题才 FAIL
for (const must of ['长篇大论', '列表', '客服腔', '伤痛文学', '知心大姐']) {
  assert.ok(prompt.includes(must), `判死标准应含「${must}」`);
}
// 2026-11-05 方案 B：prompt 里也要写入代码排版判死口径（模型层的第二道防线）
assert.ok(prompt.includes('代码排版硬性要求'), 'prompt 必须含代码排版硬性要求段');
assert.ok(prompt.includes('代码排版拥挤/未使用代码块'), 'prompt 必须写明代码排版 FAIL 理由');
assert.ok(prompt.includes('代码本身不算 OOC'), 'prompt 必须说明正常代码块不算 OOC');

let v = judge.parseJudgeOutput('【FAIL】客服腔');
assert.equal(v.passed, false);
assert.equal(v.reason, '客服腔');
v = judge.parseJudgeOutput('【PASS】');
assert.equal(v.passed, true);
v = judge.parseJudgeOutput('FAIL: 太长');
assert.equal(v.passed, false);
assert.ok([...v.reason].length <= 15);
v = judge.parseJudgeOutput('随便说说');
assert.equal(v.passed, true, '不合格式时不制造假失败');

// 本地硬杀：即使 llm 会抛错也不应该调用
const noLlm = new Proxy({}, { get() { throw new Error('不该调用模型'); } });
const hardResult = await judge.judgeReply(
  { llm: noLlm }, 'G1', '爱莉希雅', '1. 凯文\n2. 爱莉', { llm: noLlm, minLength: 15, rate: 1 },
);
assert.equal(hardResult.passed, false);
assert.equal(hardResult.hardFail, true);
assert.equal(hardResult.reason, '使用了数字/无序列表排版');

// 2026-11-05 方案 B：代码裸奔同样必须在本地短路，绝不触碰模型
const bareResult = await judge.judgeReply(
  { llm: noLlm }, 'G1', '爱莉希雅', '写给你：\ndef bubble(arr):\n    return arr', { llm: noLlm, minLength: 15, rate: 1 },
);
assert.equal(bareResult.passed, false);
assert.equal(bareResult.hardFail, true);
assert.equal(bareResult.reason, '代码排版拥挤/未使用代码块');

const fakeLlm = {
  listProviders: () => [{ id: 'p', name: 'P' }],
  listModels: async () => [{ id: 'flash-lite', name: 'Flash Lite' }],
  stream(options) {
    assert.equal(options.provider, 'p');
    assert.equal(options.model, 'flash-lite');
    assert.ok(String(options.messages?.[0]?.content?.[0]?.text || '').includes('这段回复'));
    // 2026-11-02：system 提示也要带人设豁免（有些模型只看 system 不看 user）
    assert.ok(String(options.system || '').includes('傲娇'), 'system 提示必须含人设豁免');
    assert.ok(String(options.system || '').includes('不是 OOC'), 'system 提示必须说明不是 OOC');
    // 2026-11-05 方案 B 配套：system 与 user prompt 口径必须一致
    assert.ok(String(options.system || '').includes('代码排版拥挤/未使用代码块'), 'system 提示必须含代码排版口径');
    return (async function* () {
      yield { type: 'text-delta', text: '【FAIL】客服腔' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    })();
  },
};

const short = await judge.judgeReply({ llm: fakeLlm }, 'G1', '比安安', '短句', { minLength: 15 });
assert.equal(short.passed, true);
assert.equal(short.skipped, true);

const result = await judge.judgeReply(
  { llm: fakeLlm },
  'G1',
  '比安安',
  '这段回复有点长，而且很像客服腔，需要审查一下。',
  { llm: fakeLlm, minLength: 15, rate: 1 },
);
assert.equal(result.passed, false);
assert.equal(result.reason, '客服腔');

console.log('auto-judge tests passed');
