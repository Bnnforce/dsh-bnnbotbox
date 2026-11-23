/**
 * run-distill.mjs — 记忆沉淀链路测试（2026-11-15 A-Phase 3）
 *
 * 重点验证「不破坏」而不是「能工作」：
 *   T1 默认关闭 → 不写任何东西
 *   T2 只追加 History，绝不改 Current
 *   T3 History 超上限 → 删最旧
 *   T4 同样事实不重复写
 *   T5 提炼失败 → 一个字节都不写（宁可不长，不写幻觉）
 *   T6 没卡的人 → 不建卡（建档是 auto-card 的职责）
 *   T7 生产数据零污染
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP = mkdtempSync(join(tmpdir(), 'distill-'));
const GID = 'FADE0001FADE0001FADE0001FADE0001';
const MEM = join(TMP, 'mem');
const QQ = join(TMP, 'qq');
const PEOPLE = join(MEM, 'groups', GID, 'entities', 'people');
const HIST = join(QQ, '.qqbot', 'msg-history', `group_${GID}`);

mkdirSync(PEOPLE, { recursive: true });
mkdirSync(HIST, { recursive: true });

// 造一张人物卡（带 Current + History）
writeFileSync(join(PEOPLE, '群友A.md'), `# 群成员-群友A

## Current
- 群成员：群友A；openid：FADE0002FADE0002FADE0002FADE0002。
- 备注：会调侃 bot。

## History

## Related
`, 'utf8');

// 造消息记录
writeFileSync(join(HIST, '2026-11-15.jsonl'), [
  JSON.stringify({ s: 'U1', n: '群友A', t: '我今天双休，准备睡觉', k: 'text', at: Date.now() }),
  JSON.stringify({ s: 'U2', n: '路人甲', t: '随便说一句', k: 'text', at: Date.now() }),
  JSON.stringify({ s: 'U1', n: '群友A', t: '', k: 'image', at: Date.now() }),   // 空文本，应跳过
].join('\n') + '\n', 'utf8');

const { runDistill, appendFactToCard, readRecentMessages } = await import('../../lib/memory/distill.js');

let pass = 0, fail = 0;
const ok = (c, label, detail) => { if (c) { pass++; console.log('  ✅ ' + label); } else { fail++; console.log('  ❌ ' + label + (detail ? ' — ' + detail : '')); } };
const cardOf = () => readFileSync(join(PEOPLE, '群友A.md'), 'utf8');

const baseCfg = { enabled: true, groupIds: [], maxMessagesPerRun: 50, maxHistoryPerPerson: 20, minIntervalMs: 0 };

console.log('\nT1 默认关闭 → 不写');
{
  const before = cardOf();
  const r = await runDistill({
    memoryRoot: MEM, qqbotRoot: QQ,
    config: { ...baseCfg, enabled: false },
    extractor: () => [{ name: '群友A', fact: '不该被写入' }],
  });
  ok(r.ok === false && r.skipped === 'disabled', '返回 disabled');
  ok(cardOf() === before, '卡片未变');
}

console.log('\nT2 只追加 History，Current 不动');
{
  const before = cardOf();
  const r = await runDistill({
    memoryRoot: MEM, qqbotRoot: QQ, config: baseCfg,
    extractor: () => [{ name: '群友A', fact: '喜欢双休，准备睡觉' }],
  });
  const after = cardOf();
  ok(r.ok === true && r.cards === 1, '写入 1 张卡', JSON.stringify(r));
  ok(after.includes('喜欢双休'), 'History 有新事实');
  // Current 段必须逐字节不变
  const curBefore = before.split('## History')[0];
  const curAfter = after.split('## History')[0];
  ok(curBefore === curAfter, 'Current 段完全未变');
}

console.log('\nT3 History 超上限 → 删最旧');
{
  const dir = join(MEM, 'groups', GID, 'entities', 'people');
  const p = join(dir, '上限测试.md');
  writeFileSync(p, `# x\n\n## Current\n- a\n\n## History\n${Array.from({length: 5}, (_,i)=>`- 2026-11-0${i+1}: 旧事实${i}`).join('\n')}\n\n## Related\n`, 'utf8');
  let t = readFileSync(p, 'utf8');
  const r = appendFactToCard(t, '新事实X', '2026-11-15', 3);
  ok(r.added === true, '追加成功');
  ok(r.dropped > 0, `超限删了 ${r.dropped} 条`);
  const hist = r.text.split('## History')[1].split('##')[0];
  ok(!hist.includes('旧事实0'), '最旧的被删');
  ok(hist.includes('新事实X'), '最新的保留');
}

console.log('\nT4 同样事实不重复写');
{
  const t = `# x\n\n## Current\n- a\n\n## History\n- 2026-11-15: 喜欢双休\n\n## Related\n`;
  const r = appendFactToCard(t, '喜欢双休', '2026-11-15', 20);
  ok(r.added === false, '重复事实被拒');
}

console.log('\nT5 提炼失败 → 一个字节都不写');
{
  const before = cardOf();
  const r = await runDistill({
    memoryRoot: MEM, qqbotRoot: QQ, config: baseCfg,
    extractor: () => { throw new Error('LLM 挂了'); },
  });
  ok(cardOf() === before, '卡片未变');
  ok(r.cards === 0, '没写任何卡');
}

console.log('\nT6 没卡的人 → 不建卡');
{
  const r = await runDistill({
    memoryRoot: MEM, qqbotRoot: QQ, config: baseCfg,
    extractor: () => [{ name: '从来没建过卡的人', fact: '不该建卡' }],
  });
  ok(!existsSync(join(PEOPLE, '从来没建过卡的人.md')), '未新建卡片');
}

console.log('\nT7 只读文字消息（跳过图片/空文本）');
{
  const msgs = readRecentMessages(QQ, GID, 50);
  ok(msgs.length === 2, `读到 2 条文字（实际 ${msgs.length}）`, JSON.stringify(msgs.map(m=>m.name)));
  ok(msgs.every((m) => m.text && m.text.trim()), '无空文本');
}

rmSync(TMP, { recursive: true, force: true });
console.log(`\n通过 ${pass} / 失败 ${fail}`);
if (fail > 0) process.exitCode = 1;
