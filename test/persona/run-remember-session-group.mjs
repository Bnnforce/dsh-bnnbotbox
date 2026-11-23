/**
 * run-remember-session-group.mjs — persona 服务「唯一写入口」测试（2026-11-15）
 *
 * 覆盖：
 *   T1 合法写入 → ok，文件出现正确条目
 *   T2 非法 gid（NEWGID/空/非32HEX）→ 拒绝，文件不变（这是 11-15 事故的防线）
 *   T3 非法 sessionId（空/超长）→ 拒绝
 *   T4 清理：90 天前过期条目被删
 *   T5 清理：超 500 条保留最新 500
 *   T6 原子写：无 .tmp- 残留
 *   T7 **生产数据零污染**：全程不碰真实 session-groups.json
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REAL = join(process.env.DSH_HOME || join(process.env.HOME || '', '.dsh'), 'data', 'dsh-anti-ai-persona', 'session-groups.json');
let realMtime = null;
try { realMtime = statSync(REAL).mtimeMs; } catch { /* 不存在也 OK */ }

const TMP = mkdtempSync(join(tmpdir(), 'rsg-'));
const PREV = process.env.DSH_HOME;
process.env.DSH_HOME = TMP;

const { createSessionMap, sessionGroupsPath } = await import('../../lib/persona/session-map.js');
const PATH = sessionGroupsPath();

let pass = 0, fail = 0;
const ok = (c, label, detail) => { if (c) { pass++; console.log('  ✅ ' + label); } else { fail++; console.log('  ❌ ' + label + (detail ? ' — ' + detail : '')); } };
const GID = 'FADE0001FADE0001FADE0001FADE0001';

console.log('\nT1 合法写入');
{
  const m = createSessionMap(PATH);
  const r = m.rememberSessionGroup('sess-aaa', GID);
  ok(r.ok === true, '写入成功', JSON.stringify(r));
  const raw = JSON.parse(readFileSync(PATH, 'utf8'));
  ok(raw['sess-aaa']?.groupId === GID, '文件里有正确 groupId');
  ok(typeof raw['sess-aaa']?.updatedAt === 'number', '带 updatedAt');
}

console.log('\nT2 非法 gid → 拒绝（11-15 事故防线）');
{
  const m = createSessionMap(PATH);
  const before = readFileSync(PATH, 'utf8');
  for (const bad of ['NEWGID', '', 'session-test', 'abc', 'G'.repeat(32)]) {
    const r = m.rememberSessionGroup('sess-bad', bad);
    ok(r.ok === false && r.reason === 'bad-group-id', `拒绝 "${bad.slice(0,12)}"`);
  }
  ok(readFileSync(PATH, 'utf8') === before, '文件未被污染');
}

console.log('\nT3 非法 sessionId → 拒绝');
{
  const m = createSessionMap(PATH);
  ok(m.rememberSessionGroup('', GID).ok === false, '空 sessionId 拒绝');
  ok(m.rememberSessionGroup('x'.repeat(200), GID).ok === false, '超长 sessionId 拒绝');
}

console.log('\nT4 清理过期条目（90 天）');
{
  const old = Date.now() - 100 * 24 * 3600 * 1000;
  writeFileSync(PATH, JSON.stringify({
    'sess-old': { groupId: GID, updatedAt: old },
    'sess-new': { groupId: GID, updatedAt: Date.now() },
  }), 'utf8');
  const m = createSessionMap(PATH);
  m.rememberSessionGroup('sess-fresh', GID);
  const raw = JSON.parse(readFileSync(PATH, 'utf8'));
  ok(!raw['sess-old'], '过期条目已删');
  ok(Boolean(raw['sess-new']) && Boolean(raw['sess-fresh']), '新条目保留');
}

console.log('\nT5 超 500 条 → 保留最新');
{
  const big = {};
  for (let i = 0; i < 600; i++) big['s-' + i] = { groupId: GID, updatedAt: Date.now() - i * 1000 };
  writeFileSync(PATH, JSON.stringify(big), 'utf8');
  const m = createSessionMap(PATH);
  m.rememberSessionGroup('s-newest', GID);
  const raw = JSON.parse(readFileSync(PATH, 'utf8'));
  ok(Object.keys(raw).length <= 500, `条数收敛到 ${Object.keys(raw).length} ≤ 500`);
  ok(Boolean(raw['s-newest']), '最新条目保留');
}

console.log('\nT6 原子写：无 .tmp- 残留');
{
  const dir = join(TMP, 'data', 'dsh-anti-ai-persona');
  const stale = readdirSync(dir).filter((n) => n.includes('.tmp-'));
  ok(stale.length === 0, '无临时文件残留', stale.join(','));
}

console.log('\nT7 生产数据零污染');
{
  let nowMtime = null;
  try { nowMtime = statSync(REAL).mtimeMs; } catch { /* ignore */ }
  ok(nowMtime === realMtime, '真实 session-groups.json mtime 未变');
}

if (PREV === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = PREV;
try { rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }

console.log(`\n通过 ${pass} / 失败 ${fail}`);
if (fail > 0) process.exitCode = 1;
