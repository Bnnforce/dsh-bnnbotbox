/** run-feature-diag.mjs — 统一诊断埋点测试 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, statSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP = mkdtempSync(join(tmpdir(), 'fdiag-'));
const FD = await import('../../lib/persona/r4/feature-diag.js');

let pass=0, fail=0;
const ok=(c,l,d)=>{ if(c){pass++;console.log('  ✅ '+l);} else {fail++;console.log('  ❌ '+l+(d?' — '+d:''));} };

console.log('\nT1 基础写入');
FD.record(TMP, { feature: 'P2', on: true, chars: 180, detail: { carried: 2 } });
const f = join(TMP, 'state', 'feature-diag.jsonl');
ok(existsSync(f), '文件已创建');
const lines = readFileSync(f, 'utf8').trim().split('\n');
ok(lines.length === 1, '1 条记录');
const rec = JSON.parse(lines[0]);
ok(rec.feature === 'P2', 'feature 正确');
ok(rec.on === true, 'on 正确');
ok(rec.chars === 180, 'chars 正确');
ok(rec.detail?.carried === 2, 'detail 正确');
ok(typeof rec.ts === 'number', 'ts 存在');

console.log('\nT2 跳过记录');
FD.recordSkip(TMP, 'P1', 'disabled');
const l2 = readFileSync(f, 'utf8').trim().split('\n');
const r2 = JSON.parse(l2[l2.length-1]);
ok(r2.on === false, 'on=false');
ok(r2.reason === 'disabled', 'reason 正确');
ok(r2.chars === 0, 'chars 归零');

console.log('\nT3 错误记录');
FD.recordError(TMP, 'P3', new Error('boom'));
const l3 = readFileSync(f, 'utf8').trim().split('\n');
const r3 = JSON.parse(l3[l3.length-1]);
ok(r3.err.includes('boom'), 'err 含信息');
ok(r3.on === false, 'on=false');

console.log('\nT4 全局关闭（零开销）');
{
  const before = readFileSync(f, 'utf8').split('\n').filter(Boolean).length;
  FD.setDiagEnabled(false);
  FD.record(TMP, { feature: 'P4', on: true, chars: 10 });
  const after = readFileSync(f, 'utf8').split('\n').filter(Boolean).length;
  ok(before === after, '关闭后不写入');
  FD.setDiagEnabled(true);
  FD.record(TMP, { feature: 'P4', on: true, chars: 10 });
  const after2 = readFileSync(f, 'utf8').split('\n').filter(Boolean).length;
  ok(after2 === after + 1, '重新开启后恢复写入');
}

console.log('\nT5 降级机制');
{
  FD.resetDegraded();
  ok(!FD.isDegraded('PX'), '初始未降级');
  for (let i=0;i<4;i++) FD.noteFailure('PX');
  ok(!FD.isDegraded('PX'), '4 次未降级');
  FD.noteFailure('PX');
  ok(FD.isDegraded('PX'), '5 次触发降级');
  FD.noteSuccess('PX');
  ok(!FD.isDegraded('PX'), '成功后解除');
}

console.log('\nT6 脏输入不炸');
{
  FD.record('', { feature: 'X', on: true });            // 空 root
  FD.record(TMP, { feature: '', on: true });            // 空 feature
  FD.record(TMP, { feature: 'X', on: true, chars: NaN }); // NaN chars
  FD.record(TMP, { feature: 'X', on: true, detail: null });
  ok(true, '脏输入未抛错');
  const last = JSON.parse(readFileSync(f, 'utf8').trim().split('\n').pop());
  ok(Number.isFinite(last.chars), 'chars 被规范为有限数');
}

console.log('\nT7 轮转（模拟超限）');
{
  const big = mkdtempSync(join(tmpdir(), 'fdiag-big-'));
  mkdirSync(join(big, 'state'), { recursive: true });
  const bigFile = join(big, 'state', 'feature-diag.jsonl');
  writeFileSync(bigFile, 'x'.repeat(2*1024*1024+100), 'utf8');
  FD.record(big, { feature: 'P5', on: true, chars: 5 });
  ok(existsSync(bigFile + '.old'), '产生 .old 轮转文件');
  const newSize = statSync(bigFile).size;
  ok(newSize < 1000, `新文件已重置（${newSize} 字节）`);
  rmSync(big, { recursive: true, force: true });
}

rmSync(TMP, { recursive: true, force: true });
console.log(`\n通过 ${pass} / 失败 ${fail}`);
if (fail) process.exitCode = 1;
