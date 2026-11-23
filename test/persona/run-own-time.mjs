/** run-own-time.mjs — P1「自己的时间」测试 */
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const OT = await import('../../lib/persona/r4/own-time.js');

let pass=0, fail=0;
const ok=(c,l,d)=>{ if(c){pass++;console.log('  ✅ '+l);} else {fail++;console.log('  ❌ '+l+(d?' — '+d:''));} };

const cfg = { enabled: true, intervalMin: 150, dailyMax: 4, quietFromHour: 2, quietToHour: 6 };
const H = 3600_000;
const base = Date.UTC(2026, 10, 16, 4, 0, 0); // +08 = 12:00

console.log('\nT1 默认关闭');
{
  const d = OT.tick({ now: base, hour: 12, today: '2026-11-16', state: undefined, config: {} });
  ok(d.fire === false, '默认不触发');
  ok(d.reason === 'disabled', 'reason=disabled');
}

console.log('\nT2 安静时段（02-06 不叫）');
{
  for (const h of [2, 3, 4, 5]) {
    const d = OT.tick({ now: base, hour: h, today: '2026-11-16', state: undefined, config: cfg });
    ok(d.fire === false && d.reason === 'quiet-hours', `${String(h).padStart(2,'0')}:00 不叫`);
  }
  const d6 = OT.tick({ now: base, hour: 6, today: '2026-11-16', state: undefined, config: cfg });
  ok(d6.fire === true, '06:00 恢复（左闭右开）');
}

console.log('\nT3 日上限');
{
  const st = { lastAt: base - 3*H, count: 4, day: '2026-11-16' };
  const d = OT.tick({ now: base, hour: 12, today: '2026-11-16', state: st, config: cfg });
  ok(d.fire === false, '达上限不触发');
  ok(d.reason.includes('daily-max'), 'reason 含 daily-max');
}

console.log('\nT4 间隔下限');
{
  const st = { lastAt: base - 60*60_000, count: 1, day: '2026-11-16' };
  const d = OT.tick({ now: base, hour: 12, today: '2026-11-16', state: st, config: cfg });
  ok(d.fire === false, '1 小时前刚叫过 → 不触发');
  ok(d.reason.includes('interval'), 'reason 含 interval');
  ok(typeof d.nextAt === 'number', '给出下次时刻');
}

console.log('\nT5 跨天清零');
{
  const st = { lastAt: base - 20*H, count: 4, day: '2026-11-15' };
  const d = OT.tick({ now: base, hour: 12, today: '2026-11-16', state: st, config: cfg });
  ok(d.fire === true, '新的一天计数清零后可触发');
  ok(d.nextState?.count === 1, '新 count=1');
  ok(d.nextState?.day === '2026-11-16', 'day 已更新');
}

console.log('\nT6 正常触发');
{
  const st = { lastAt: base - 4*H, count: 1, day: '2026-11-16' };
  const d = OT.tick({ now: base, hour: 12, today: '2026-11-16', state: st, config: cfg });
  ok(d.fire === true, '4 小时前叫过 → 可触发');
  ok(d.nextState?.count === 2, '计数递增');
}

console.log('\nT7 提示文案');
{
  const t = OT.ownTimePrompt(['2026-11-14：追萤火虫', '2026-11-15：夜蝶']);
  ok(t.includes('自己的时间'), '含标题');
  ok(t.includes('不用回话'), '含"不用回话"');
  ok(t.includes('萤火虫'), '含旧事');
  const t2 = OT.ownTimePrompt();
  ok(!t2.includes('脑子里可能'), '无旧事时不带那段');
}

console.log('\nT8 状态读写');
{
  const TMP = mkdtempSync(join(tmpdir(), 'owntime-'));
  ok(OT.readOwnTimeState(TMP).count === 0, '无文件 → 空状态');
  ok(OT.writeOwnTimeState(TMP, { lastAt: 123, count: 2, day: '2026-11-16' }), '写成功');
  const st = OT.readOwnTimeState(TMP);
  ok(st.count === 2 && st.lastAt === 123, '读回一致');
  // 脏数据
  const fs = await import('node:fs');
  fs.writeFileSync(OT.ownTimeStatePath(TMP), '{bad json', 'utf8');
  ok(OT.readOwnTimeState(TMP).count === 0, '脏数据 → 空状态（不抛）');
  rmSync(TMP, { recursive: true, force: true });
}

console.log('\nT9 调度器默认不启动');
{
  const TMP = mkdtempSync(join(tmpdir(), 'owntime2-'));
  let delivered = 0;
  const stop = OT.startOwnTime(TMP, {}, { deliver: () => { delivered++; return true; } });
  ok(typeof stop === 'function', '返回停止函数');
  stop();
  await new Promise(r => setTimeout(r, 50));
  ok(delivered === 0, '默认关闭 → 零投递');
  rmSync(TMP, { recursive: true, force: true });
}

console.log('\nT10 启动补跑（setInterval 不会立即执行，必须手动补一次）');
{
  const OT2 = await import('../../lib/persona/r4/own-time.js');
  const TMP2 = mkdtempSync(join(tmpdir(), 'owntime3-'));
  const diags = [];
  let delivered = 0;
  const stop = OT2.startOwnTime(TMP2, {
    enabled: true, intervalMin: 10, dailyMax: 4, quietFromHour: 2, quietToHour: 6,
  }, {
    deliver: async () => { delivered++; return true; },
    now: () => Date.UTC(2026, 10, 16, 4, 0, 0),
    hourOf: () => 12,
    todayOf: () => '2026-11-16',
    onDiag: (r) => diags.push(r.reason),
    logger: { info: () => {}, warn: () => {} },
  });
  ok(diags.length === 0, '启动瞬间不立即触发（等 5 秒）');
  await new Promise((r) => setTimeout(r, 6500));
  ok(diags.includes('startup-check'), '★ 5 秒后有启动补跑记录');
  ok(delivered >= 1, `★ 启动补跑真的投递了（${delivered} 次）`);
  stop();
  rmSync(TMP2, { recursive: true, force: true });
}

console.log(`\n最终通过 ${pass} / 失败 ${fail}`);
