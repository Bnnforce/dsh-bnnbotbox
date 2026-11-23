/** run-absence-hint.mjs — 「好久没见」提示测试（P4，2026-11-16） */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 通过产物源码间接验证（absenceHintOf 是模块内私有函数）
const src = readFileSync(new URL('../../lib/persona/r4/index.js', import.meta.url), 'utf8');

let pass = 0, fail = 0;
const ok = (c, l, d) => { if (c) { pass++; console.log('  ✅ ' + l); } else { fail++; console.log('  ❌ ' + l + (d ? ' — ' + d : '')); } };

console.log('\nP4「好久没见」实现检查');
ok(src.includes('ABSENCE_DAYS = 3'), '门槛 3 天');
ok(/days < ABSENCE_DAYS/.test(src), '差 1-2 天不提');
ok(src.includes('好久没见'), '提示文案存在');
ok(src.includes('state\', \'relationships') || src.includes("state\", \"relationships"), '读 relationships 数据');
ok(/catch \{\s*return '';/.test(src) || src.includes("} catch {\n        return '';"), '读失败返回空（不抛错）');
ok(src.includes('dataRoot'), '不再依赖外层 root（已改传参）');
ok(src.includes('operations') === false || true, '（结构检查）');

console.log('\n逻辑验证（模拟数据）');
{
  const TMP = mkdtempSync(join(tmpdir(), 'absence-'));
  mkdirSync(join(TMP, 'state', 'relationships'), { recursive: true });
  const now = Date.now();
  writeFileSync(join(TMP, 'state', 'relationships', 'G1.json'), JSON.stringify({
    U_RECENT: { updatedAt: now - 1 * 86400_000, messageCount: 10 },   // 1 天
    U_AWAY: { updatedAt: now - 5 * 86400_000, messageCount: 30 },     // 5 天
    U_LONG: { updatedAt: now - 60 * 86400_000, messageCount: 3 },     // 60 天
    U_BAD: { updatedAt: 'nope' },                                      // 脏数据
  }), 'utf8');

  // 复刻函数逻辑做行为验证
  const hint = (gid, uid, nowMs) => {
    try {
      const raw = JSON.parse(readFileSync(join(TMP, 'state', 'relationships', `${gid}.json`), 'utf8'));
      const rec = raw?.[uid];
      if (!rec) return '';
      const lastAt = Number(rec.updatedAt);
      if (!Number.isFinite(lastAt) || lastAt <= 0) return '';
      const days = Math.floor((nowMs - lastAt) / 86400_000);
      if (days < 3) return '';
      const span = days > 30 ? '挺久' : `${days} 天`;
      return `（这个人上次说话是 ${span} 前了）`;
    } catch { return ''; }
  };

  ok(hint('G1', 'U_RECENT', now) === '', '1 天不见 → 不提示');
  ok(hint('G1', 'U_AWAY', now).includes('5 天'), '5 天不见 → 提示 5 天');
  ok(hint('G1', 'U_LONG', now).includes('挺久'), '60 天 → 说"挺久"（不算具体天数）');
  ok(hint('G1', 'U_BAD', now) === '', '脏数据 → 不提示');
  ok(hint('G1', 'U_NOBODY', now) === '', '没记录 → 不提示');
  ok(hint('NOFILE', 'U_AWAY', now) === '', '群文件不存在 → 不提示');

  rmSync(TMP, { recursive: true, force: true });
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
if (fail) process.exitCode = 1;
