#!/usr/bin/env node
/** 端到端：模拟一次完整沉淀（假模型 → 真写盘） */
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const D = await import('../../lib/memory/distiller.js');
const T = await import('../../lib/memory/distill.js');

const TMP = mkdtempSync(join(tmpdir(), 'bnn-e2e-distill-'));
let pass=0, fail=0;
const ok=(c,l,d)=>{ if(c){pass++;console.log('  ✅ '+l)}else{fail++;console.log('  ❌ '+l+(d?' — '+d:''))} };

try {
  const qqbotRoot = join(TMP,'qqbot');
  const memRoot = join(TMP,'mem');
  const gid = 'AAAABBBBCCCCDDDDEEEEFFFF00001111';

  // 造消息历史
  const histDir = join(qqbotRoot,'.qqbot','msg-history',`group_${gid}`);
  mkdirSync(histDir,{recursive:true});
  writeFileSync(join(histDir,'2026-11-17.jsonl'), [
    JSON.stringify({n:'张三',t:'我最近在学吉他',k:'text',at:1794900000000}),
    JSON.stringify({n:'李四',t:'我喜欢吃辣',k:'text',at:1794900001000}),
  ].join('\n'),'utf8');

  // 造人物卡
  const cardDir = join(memRoot,'groups',gid,'entities','people');
  mkdirSync(cardDir,{recursive:true});
  for (const n of ['张三','李四']) {
    writeFileSync(join(cardDir,`${n}.md`),
      `# 群成员-${n}\n\n## Current\n- 群成员：${n}\n\n## History\n- 2026-11-09：自动建档。\n`, 'utf8');
  }

  console.log('\nT1 完整沉淀链路（假模型返回2条事实）');
  {
    // 假模型：直接返回固定 JSON
    const fakeExtractor = async (input) => {
      console.log(`     [假模型] 收到 ${input.messages.length} 条消息`);
      return [
        { name:'张三', fact:'张三最近在学吉他' },
        { name:'李四', fact:'李四喜欢吃辣' },
      ];
    };
    const r = await T.runDistill({
      memoryRoot: memRoot, qqbotRoot,
      config: { enabled:true, groupIds:[gid], maxMessagesPerRun:50, maxHistoryPerPerson:20, minIntervalMs:0 },
      extractor: fakeExtractor,
    });
    ok(r.ok===true, 'runDistill 成功', r.error||'');
    ok(r.messages===2, `读到 ${r.messages} 条消息`);
    ok(r.facts===2, `提炼 ${r.facts} 条事实`);
    ok(r.cards===2, `写入 ${r.cards} 张卡`);

    // 验证真的写进去了
    const zs = readFileSync(join(cardDir,'张三.md'),'utf8');
    ok(zs.includes('学吉他'), '张三卡里有新内容');
    ok(zs.includes('## Current'), 'Current 段还在（没被破坏）');
  }

  console.log('\nT2 重复运行不重复写（去重）');
  {
    const fakeExtractor = async () => [{ name:'张三', fact:'张三最近在学吉他' }];
    const r = await T.runDistill({
      memoryRoot: memRoot, qqbotRoot,
      config: { enabled:true, groupIds:[gid], maxMessagesPerRun:50, maxHistoryPerPerson:20, minIntervalMs:0 },
      extractor: fakeExtractor,
    });
    ok(r.cards===0, '同样的事实不会重复写', `写入了 ${r.cards} 张`);
  }

  console.log('\nT3 提炼失败不写盘');
  {
    const before = readFileSync(join(cardDir,'张三.md'),'utf8');
    const r = await T.runDistill({
      memoryRoot: memRoot, qqbotRoot,
      config: { enabled:true, groupIds:[gid], maxMessagesPerRun:50, maxHistoryPerPerson:20, minIntervalMs:0 },
      extractor: async () => { throw new Error('模型挂了'); },
    });
    const after = readFileSync(join(cardDir,'张三.md'),'utf8');
    ok(before===after, '提炼异常时卡片不变');
    ok(r.ok===true, '整体不崩（单群跳过）');
  }

  console.log('\nT4 History 上限保护');
  {
    const fakeExtractor = async () => [
      { name:'张三', fact:'张三喜欢猫' },
      { name:'张三', fact:'张三喜欢狗' },
      { name:'张三', fact:'张三喜欢鸟' },
    ];
    await T.runDistill({
      memoryRoot: memRoot, qqbotRoot,
      config: { enabled:true, groupIds:[gid], maxMessagesPerRun:50, maxHistoryPerPerson:3, minIntervalMs:0 },
      extractor: fakeExtractor,
    });
    const zs = readFileSync(join(cardDir,'张三.md'),'utf8');
    const hist = zs.split('## History')[1]||'';
    const lines = hist.split('\n').filter(l=>l.trim().startsWith('-'));
    ok(lines.length<=3, `History 条数 ${lines.length} <= 3`);
  }

} finally {
  try { rmSync(TMP,{recursive:true,force:true}); } catch {}
}
console.log(`\n通过 ${pass} / 失败 ${fail}`);
if(fail) process.exitCode=1;
