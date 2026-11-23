/**
 * run-persona-service — PersonaService 专项测试（阶段 1 验收）
 *
 * 隔离：PERSONA_DATA_ROOT / DSH_HOME 指向临时目录，绝不碰生产数据。
 * 运行：node test/run-persona-service.mjs
 */
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let pass = 0, fail = 0;
const failures = [];

function ok(cond, label) {
  if (cond) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; failures.push(label); console.log(`  ❌ ${label}`); }
}
function eq(actual, expected, label) {
  ok(actual === expected, `${label}（实际=${JSON.stringify(actual)} 期望=${JSON.stringify(expected)}）`);
}

// ── 生产数据 mtime 快照（测完校验没被动过）──────────────────────────────
const PROD_FILES = [
  join(process.env.DSH_HOME || join(process.env.HOME || '', '.dsh'), 'data', 'dsh-anti-ai-persona', 'session-groups.json'),
];
const beforeMtime = new Map();
for (const f of PROD_FILES) {
  try { beforeMtime.set(f, statSync(f).mtimeMs); } catch { beforeMtime.set(f, null); }
}

// ── 建临时环境 ───────────────────────────────────────────────────────────
const TMP = mkdtempSync(join(tmpdir(), 'persona-svc-'));
const TMP_DSH = join(TMP, 'dshhome');
mkdirSync(join(TMP_DSH, 'qqbot-settings', 'web'), { recursive: true });
mkdirSync(join(TMP_DSH, 'data', 'dsh-anti-ai-persona', 'guidelines'), { recursive: true });

const SETTINGS = join(TMP_DSH, 'qqbot-settings', 'web', 'im-qqbot-2.json');
writeFileSync(SETTINGS, JSON.stringify({
  groupAdmin: { enabled: true, owners: ['OWNER-1', 'OWNER-2'] },
}), 'utf8');

const GUIDELINE = join(TMP_DSH, 'data', 'dsh-anti-ai-persona', 'guidelines', 'GID-A.md');
writeFileSync(GUIDELINE, '# 群A语感\n短句为主，爱用语气词。', 'utf8');

const SESSION_MAP = join(TMP, 'session-groups.json');
writeFileSync(SESSION_MAP, JSON.stringify({
  'sess-a': 'GID-A',
  'sess-b': 'GID-B',
}), 'utf8');

const prevDshHome = process.env.DSH_HOME;
process.env.DSH_HOME = TMP_DSH;

// ── 动态 import（必须在环境变量设好之后）──────────────────────────────────
const { PersonaService } = await import('../../lib/persona/persona-service.js');

// 假的 session-map（模拟 R4 的 createSessionMap 行为）
function fakeSessionMap() {
  const raw = JSON.parse(readFileSync(SESSION_MAP, 'utf8'));
  return (sid) => raw[String(sid)] ?? '';
}

// fake ctx（Service 构造需要）
function fakeCtx() {
  const provided = new Map();
  return {
    logger: { info() {}, warn() {} },
    reflect: { provide: (name, self) => provided.set(name, self) },
    effect() { return () => {}; },
    _provided: provided,
  };
}

console.log('persona-service 测试\n');

// ══ T1 服务注册 ═══════════════════════════════════════════════════════════
console.log('T1 服务注册');
{
  const ctx = fakeCtx();
  const svc = new PersonaService(ctx, {
    logger: ctx.logger,
    groupIdForSession: fakeSessionMap(),
    senderOf: () => 'SENDER-X',
    settingsFilePath: () => SETTINGS,
  });
  ok(ctx._provided.get('persona') === svc, 'Service 以 name=persona 注册进 ctx');
  eq(svc.name, 'persona', 'Service.name 正确');
}

// ══ T2 resolveGroup 转调 session-map ══════════════════════════════════════
console.log('T2 resolveGroup');
{
  const svc = new PersonaService(fakeCtx(), {
    groupIdForSession: fakeSessionMap(),
    senderOf: () => '',
    settingsFilePath: () => SETTINGS,
  });
  eq(svc.resolveGroup('sess-a'), 'GID-A', 'sess-a → GID-A');
  eq(svc.resolveGroup('sess-b'), 'GID-B', 'sess-b → GID-B');
  eq(svc.resolveGroup('sess-未知'), '', '未知 sessionId → 空串');
  eq(svc.resolveGroup(''), '', '空 sessionId → 空串');
  eq(svc.resolveGroup('  '), '', '空白 sessionId → 空串');
}

// ══ T3 resolveGroup 底层抛错时不崩 ═══════════════════════════════════════
console.log('T3 resolveGroup 容错');
{
  const svc = new PersonaService(fakeCtx(), {
    groupIdForSession: () => { throw new Error('boom'); },
    senderOf: () => '',
    settingsFilePath: () => SETTINGS,
  });
  eq(svc.resolveGroup('sess-a'), '', 'session-map 抛错 → 返回空串而非崩溃');
}

// ══ T4 owner 白名单 ═══════════════════════════════════════════════════════
console.log('T4 isOwner 白名单');
{
  const svc = new PersonaService(fakeCtx(), {
    groupIdForSession: fakeSessionMap(),
    senderOf: () => '',
    settingsFilePath: () => SETTINGS,
  });
  ok(svc.isOwner('OWNER-1') === true, 'OWNER-1 是主人');
  ok(svc.isOwner('OWNER-2') === true, 'OWNER-2 是主人');
  ok(svc.isOwner('STRANGER') === false, '陌生人是主人 = false');
  ok(svc.isOwner('') === false, '空 senderId = false');
  const list = svc.owners();
  eq(list.length, 2, '白名单读到 2 人');
}

// ══ T5 设置文件缺失 → fail-closed ═════════════════════════════════════════
console.log('T5 设置文件缺失');
{
  const svc = new PersonaService(fakeCtx(), {
    groupIdForSession: fakeSessionMap(),
    senderOf: () => '',
    settingsFilePath: () => join(TMP, '不存在的文件.json'),
  });
  eq(svc.owners().length, 0, '读不到设置 → 白名单为空');
  ok(svc.isOwner('任何人') === false, '白名单空 + 无旁路 → fail-closed');
}

// ══ T6 设置文件是坏 JSON → 不崩 ══════════════════════════════════════════
console.log('T6 坏 JSON');
{
  const bad = join(TMP, 'bad-settings.json');
  writeFileSync(bad, '{ 这不是 JSON', 'utf8');
  const svc = new PersonaService(fakeCtx(), {
    groupIdForSession: fakeSessionMap(),
    senderOf: () => '',
    settingsFilePath: () => bad,
  });
  eq(svc.owners().length, 0, '坏 JSON → 白名单为空（不崩）');
}

// ══ T7 guideline ══════════════════════════════════════════════════════════
console.log('T7 guideline');
{
  const svc = new PersonaService(fakeCtx(), {
    groupIdForSession: fakeSessionMap(),
    senderOf: () => '',
    settingsFilePath: () => SETTINGS,
  });
  const g = svc.guideline('GID-A');
  ok(g.includes('群A语感'), '读到 GID-A 的 guideline');
  ok(g.includes('短句为主'), 'guideline 内容完整');
  eq(svc.guideline('GID-不存在'), '', '无 guideline 的群 → 空串');
  eq(svc.guideline(''), '', '空 groupId → 空串');
}

// ══ T8 guidelineFresh ═════════════════════════════════════════════════════
console.log('T8 guidelineFresh');
{
  const svc = new PersonaService(fakeCtx(), {
    groupIdForSession: fakeSessionMap(),
    senderOf: () => '',
    settingsFilePath: () => SETTINGS,
  });
  ok(svc.guidelineFresh('GID-A', 60_000) === true, '刚写的 guideline 24h 内 = fresh');
  ok(svc.guidelineFresh('GID-A', 0) === false, 'maxAge=0 → 不算 fresh');
  ok(svc.guidelineFresh('GID-不存在') === false, '不存在 → false');
}

// ══ T9 current-sender 旁路兜底 ════════════════════════════════════════════
console.log('T9 current-sender 兜底');
{
  // 白名单为空时才走旁路
  const svc = new PersonaService(fakeCtx(), {
    groupIdForSession: fakeSessionMap(),
    senderOf: () => '',
    settingsFilePath: () => join(TMP, '无此文件.json'),
  });
  const KEY = Symbol.for('qqbot.current-sender');
  const m = new Map();
  m.set('group:GID-A', { senderId: 'SIDE-OWNER', isOwner: true, ts: Date.now() });
  globalThis[KEY] = m;

  ok(svc.isOwner('SIDE-OWNER', 'GID-A') === true, '白名单空时，旁路 isOwner 生效');
  ok(svc.isOwner('SIDE-OWNER') === false, '不给 groupId 时查不到旁路');
  ok(svc.isOwner('别的人', 'GID-A') === false, '旁路里没有的人 = false');

  // 过期记录不认
  m.set('group:GID-A', { senderId: 'OLD', isOwner: true, ts: Date.now() - 20 * 60 * 1000 });
  ok(svc.isOwner('OLD', 'GID-A') === false, '15 分钟前的记录已过期，不认');

  delete globalThis[KEY];
}

// ══ T10 diagnostics ═══════════════════════════════════════════════════════
console.log('T10 diagnostics');
{
  const svc = new PersonaService(fakeCtx(), {
    groupIdForSession: fakeSessionMap(),
    senderOf: () => '',
    settingsFilePath: () => SETTINGS,
  });
  const d = svc.diagnostics();
  eq(d.ownerCount, 2, 'diagnostics.ownerCount');
  ok(d.hasSettingsFile === true, 'diagnostics.hasSettingsFile');
}

// ══ T11 生产数据未被污染 ══════════════════════════════════════════════════
console.log('T11 生产数据未被污染');
{
  let polluted = false;
  for (const [f, mt] of beforeMtime) {
    if (mt === null) continue;
    try { if (statSync(f).mtimeMs !== mt) polluted = true; } catch { polluted = true; }
  }
  ok(!polluted, '生产 session-groups.json 的 mtime 未变');
}

// ── 收尾 ─────────────────────────────────────────────────────────────────
if (prevDshHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prevDshHome;
try { rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }

console.log(`\n通过 ${pass} / 失败 ${fail}`);
if (fail > 0) {
  console.log('失败项：');
  for (const f of failures) console.log('  -', f);
  process.exit(1);
}
