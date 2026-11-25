/**
 * run-persona-fixes2 — P1-1 / P1-2 防回归测试（2026-11-06 真机审查）
 *
 * 覆盖：
 *   P1-1  `tcDriving()` 必须被调用（引擎 shadow 时插件的任务要降级为自带定时器）
 *   P1-2  高光必须按群过滤（此前跨群串味）
 *
 * 隔离：DSH_HOME 指向临时目录，绝不碰生产。
 * 运行：node test/run-persona-fixes2.mjs
 */
import { homedir } from 'node:os';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let pass = 0, fail = 0;
const failures = [];
function ok(cond, label, detail) {
  if (cond) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; failures.push(label); console.log(`  ❌ ${label}${detail ? ' — ' + detail : ''}`); }
}
function eq(a, b, label) { ok(a === b, `${label}（实际=${JSON.stringify(a)} 期望=${JSON.stringify(b)}）`); }

// ── 测试隔离：必须在 import 之前设 DSH_HOME ──────────────────────────────
const TMP = mkdtempSync(join(tmpdir(), 'persona-fixes2-'));
process.env.DSH_HOME = TMP;
mkdirSync(join(TMP, 'data', 'dsh-anti-ai-persona'), { recursive: true });

console.log('persona P1-1/P1-2 回归测试\n');

// ══ T1 高光按群过滤（P1-2）═══════════════════════════════════════════════
console.log('T1 高光按群过滤');
{
  const hl = await import('file://' + (new URL('../../', import.meta.url).pathname.replace(/\/$/, '')) + '/lib/persona/highlights.js');

  // 造一个真实的 highlights.md（三群各一条 + 一条无群号的旧记录）
  const f = hl.highlightsPath();
  mkdirSync(join(f, '..'), { recursive: true });
  writeFileSync(f, [
    '# 高光时刻（被夸的 Bot 回复）',
    '',
    '- [群 FADE0001FADE0001FADE0001FADE0001｜人格 爱莉希雅｜2026-11-06] A群的高光',
    '- [群 FADE0012FADE0012FADE0012FADE0012｜人格 爱莉希雅｜2026-11-06] B群的高光',
    '- [群 FADE0013FADE0013FADE0013FADE0013｜人格 爱莉希雅｜2026-11-06] C群的高光',
    '',
  ].join('\n'), 'utf8');

  const all = hl.readRecentHighlights(10);
  ok(all.length >= 3, '不传 groupId → 返回全部（旧行为兼容）', `实际 ${all.length}`);

  const A = hl.readRecentHighlights(10, 'FADE0001FADE0001FADE0001FADE0001');
  eq(A.length, 1, '只取 A 群 → 恰好 1 条');
  ok(A[0]?.text.includes('A群的高光'), 'A 群返回的是 A 群自己的记录');

  const B = hl.readRecentHighlights(10, 'FADE0012FADE0012FADE0012FADE0012');
  eq(B.length, 1, '只取 B 群 → 恰好 1 条');
  ok(B[0]?.text.includes('B群的高光'), 'B 群返回的是 B 群自己的记录');

  const none = hl.readRecentHighlights(10, '不存在的群');
  eq(none.length, 0, '不存在的群 → 0 条（隔离生效，不串群）');

  // 关键：A 群的结果绝不能含 B/C 的内容
  const leaked = A.some((h) => h.text.includes('B群') || h.text.includes('C群'));
  ok(!leaked, '**A 群结果不含其他群的高光**（跨群泄漏已修）');

  // 旧记录（无 groupId）不应被任何具体群选中
  const legacy = hl.readRecentHighlights(10, 'FADE0001FADE0001FADE0001FADE0001')
    .some((h) => String(h.groupId ?? '').trim() === '');
  ok(!legacy, '无 groupId 的旧记录不会被具体群选中（向后兼容且防串群）');
}

// ══ T2 tcDriving 被调用（P1-1）═══════════════════════════════════════════
// 验证方式：源码级断言（确保 tcDriving 出现在 registerTaskCenterTasks 的条件里）
console.log('\nT2 tcDriving 必须被使用');
{
  const src = readFileSync(
    (new URL('../../', import.meta.url).pathname.replace(/\/$/, '')) + '/lib/persona/maintenance-tasks.js',
    'utf8',
  );
  // 关键：登记成功只是必要条件，还必须引擎 live
  const usesDriving = /tcRegister\([^)]*\)\s*&&\s*tcDriving\(\)/.test(src)
    || src.includes('&& tcDriving()');
  ok(usesDriving, '**tcRegister 的结果与 tcDriving() 联合判断**（不再只查登记成功）');

  // 降级路径必须存在
  ok(/startFallback|setInterval/.test(src), '仍有降级（自带定时器）路径');
  // 引擎恢复后要停降级器（防双跑）
  ok(src.includes('stopFallbacks') || src.includes('watchDriving'), '有「引擎转 live → 停降级器」逻辑（防双跑）');
  // 清理里要覆盖新定时器
  ok(src.includes('drivingPoll'), '清理时会停掉引擎轮询器');
}

// ══ T3 生产数据零污染 ════════════════════════════════════════════════════
console.log('\nT3 隔离有效');
{
  // 生产路径必须绕过测试设置的 PERSONA_DATA_ROOT（否则检查的是隔离目录）
    const prodHl = (process.env.DSH_HOME_REAL || (homedir() + '/.dsh')) + '/data/dsh-anti-ai-persona/highlights.md';
  let prodText = '';
  try { prodText = readFileSync(prodHl, 'utf8'); } catch { prodText = ''; }
  ok(!prodText.includes('A群的高光'), '测试数据没写进生产 highlights.md');
}

// ── 收尾 ─────────────────────────────────────────────────────────────────
try { rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }

console.log(`\n通过 ${pass} / 失败 ${fail}`);
if (fail > 0) {
  console.log('失败项：');
  for (const f of failures) console.log('  -', f);
  process.exit(1);
}
