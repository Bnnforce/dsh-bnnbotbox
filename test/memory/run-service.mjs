/**
 * run-service — QqMemoryService + 工具集成测试（阶段 3 验收 / L2 层）
 *
 * 覆盖 T6（非主人写被拒）、T7（主人写成功）、工具注册、scope 链路、
 * 以及「persona 不可用」降级。
 *
 * 隔离：临时目录，不碰生产。
 */
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let pass = 0, fail = 0;
const failures = [];
function ok(cond, label) {
  if (cond) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; failures.push(label); console.log(`  ❌ ${label}`); }
}
function eq(a, b, label) { ok(a === b, `${label}（实际=${JSON.stringify(a)} 期望=${JSON.stringify(b)}）`); }

// ── 测试隔离（🔴 P1-3，2026-11-06 修）──────────────────────────────────────
// 背景：工具里的 diag() 用 `process.env.DSH_HOME || ~/.dsh` 决定诊断日志路径。
//   测试不设隔离时，跑一次就会往**生产** `~/.dsh/data/dsh-qq-memory/tool-diag.log`
//   写 `sess-a`/`GID_A` 这类假数据（实测 41→45 行），污染真实诊断日志。
//   所以**必须在 import 被测模块之前**把 DSH_HOME 指到临时目录。
const TMP = mkdtempSync(join(tmpdir(), 'qqmem-svc-'));
process.env.DSH_HOME = join(TMP, 'dshhome');
mkdirSync(process.env.DSH_HOME, { recursive: true });

// ── 生产数据快照 ─────────────────────────────────────────────────────────
const PROD = ((process.env.QQBOT_DATA_ROOT || '') + '/.qqbot-extensions/data/group-memory');
let prodMtime = null;
try { prodMtime = statSync(PROD).mtimeMs; } catch { /* ignore */ }

const ROOT = join(TMP, 'group-memory');
mkdirSync(join(ROOT, 'groups', 'GID_A', 'entities', 'people'), { recursive: true });
writeFileSync(join(ROOT, 'groups/GID_A/entities/people/群友A.md'),
  '# 群友A\n\n## Current\n- 生日 11-11\n', 'utf8');
mkdirSync(join(ROOT, 'groups', 'GID_B'), { recursive: true });

const { MemoryStore } = await import('../../lib/memory/store/index.js');
const { QqMemoryService } = await import('../../lib/memory/service.js');
const { createQqMemoryTool } = await import('../../lib/memory/tools/qq-memory.js');
const { resolveConfig } = await import('../../lib/memory/config.js');
const { resolveQqbotRoot } = await import('../../lib/memory/index.js');

const store = new MemoryStore({ memoryRoot: ROOT, logger: { info() {}, warn() {} } });

/** 假的 cordis ctx（Service 构造需要） */
function fakeCtx() {
  const provided = new Map();
  const getMap = new Map();
  return {
    logger: { info() {}, warn() {} },
    reflect: { provide: (n, s) => provided.set(n, s) },
    effect() { return () => {}; },
    get(n) { return getMap.get(n); },
    _provided: provided,
    _set(name, v) { getMap.set(name, v); },
  };
}

/** 假 persona 服务 */
function fakePersona({ owners = ['OWNER-1'], sessions = { 'sess-a': 'GID_A', 'sess-b': 'GID_B' } } = {}) {
  return {
    resolveGroup: (sid) => sessions[String(sid)] ?? '',
    resolveSender: (sid) => (sid === 'sess-a' ? 'OWNER-1' : 'SOMEONE'),
    isOwner: (sid) => owners.includes(String(sid)),
  };
}

console.log('QqMemoryService + 工具 测试\n');

// ══ T1 scope 解析走 persona ══════════════════════════════════════════════
console.log('T1 scope 链路');
{
  const svc = new QqMemoryService(fakeCtx(), {
    store, logger: { info() {}, warn() {} }, getPersona: () => fakePersona(),
  });
  const a = svc.scopeOfSession('sess-a');
  eq(a?.type, 'group', 'sess-a 解析为 group scope');
  eq(a?.id, 'GID_A', 'sess-a → GID_A');
  eq(svc.scopeOfSession('sess-未知'), null, '未知 sessionId → null');
  eq(svc.scopeOfSession(''), null, '空 sessionId → null');
}

// ══ T2 persona 不可用 → 降级为 null（不崩）════════════════════════════════
console.log('T2 persona 不可用降级');
{
  const svc = new QqMemoryService(fakeCtx(), {
    store, logger: { info() {}, warn() {} }, getPersona: () => undefined,
  });
  eq(svc.scopeOfSession('sess-a'), null, '无 persona → scope 为 null（不猜群号）');
  ok(svc.diagnostics().hasPersona === false, 'diagnostics 反映 persona 缺失');
}

// ══ T3 persona 抛错 → 不崩 ═══════════════════════════════════════════════
console.log('T3 persona 抛错');
{
  const svc = new QqMemoryService(fakeCtx(), {
    store, logger: { info() {}, warn() {} },
    getPersona: () => ({ resolveGroup: () => { throw new Error('boom'); }, isOwner: () => false }),
  });
  eq(svc.scopeOfSession('sess-a'), null, 'persona 抛错 → null（不崩）');
}

// ══ T4 读操作群友可用 ════════════════════════════════════════════════════
console.log('T4 读操作（群友）');
{
  const svc = new QqMemoryService(fakeCtx(), {
    store, logger: { info() {}, warn() {} }, getPersona: () => fakePersona(),
  });
  const scope = { type: 'group', id: 'GID_A' };
  const hits = svc.search(scope, '群友A');
  ok(hits.length > 0, 'search 有结果');
  const r = svc.read(scope, 'entities/people/群友A.md');
  eq(r.ok, true, 'read 成功');
  ok(r.ok && r.text.includes('11-11'), 'read 内容正确');
  const l = svc.list(scope);
  eq(l.ok, true, 'list 成功');
  ok(l.ok && l.files.length > 0, 'list 有文件');
}

// ══ T5 非主人写被拒（T6 用例）═════════════════════════════════════════════
console.log('T5 非主人写被拒');
{
  const svc = new QqMemoryService(fakeCtx(), {
    store, logger: { info() {}, warn() {} }, getPersona: () => fakePersona(),
  });
  const scope = { type: 'group', id: 'GID_A' };
  const r = svc.remember(scope, 'entities/people/新人.md', '# 新人\n', { senderId: 'SOMEONE' });
  eq(r.ok, false, '非主人 remember → 被拒');
  ok(!r.ok && r.reason.includes('仅限主人'), '拒绝原因明确');
  const f = svc.forget(scope, 'entities/people/群友A.md', { senderId: 'SOMEONE' });
  eq(f.ok, false, '非主人 forget → 被拒');
}

// ══ T6 主人写成功（T7 用例）═════════════════════════════════════════════
console.log('T6 主人写成功');
{
  const svc = new QqMemoryService(fakeCtx(), {
    store, logger: { info() {}, warn() {} }, getPersona: () => fakePersona(),
  });
  const scope = { type: 'group', id: 'GID_A' };
  const r = svc.remember(scope, 'entities/people/新人.md', '# 新人\n\n## Current\n- 测试\n', { senderId: 'OWNER-1' });
  eq(r.ok, true, '主人 remember → 成功');
  const readBack = svc.read(scope, 'entities/people/新人.md');
  ok(readBack.ok && readBack.text.includes('测试'), '写入内容可读回');
}

// ══ T7 ownersFallback 兜底 ══════════════════════════════════════════════
console.log('T7 ownersFallback');
{
  const svc = new QqMemoryService(fakeCtx(), {
    store, logger: { info() {}, warn() {} },
    getPersona: () => ({ resolveGroup: () => 'GID_A', isOwner: () => false }),
    ownersFallback: ['FB-OWNER'],
  });
  ok(svc.isOwner('FB-OWNER') === true, 'persona 说不主人，但 fallback 命中');
  ok(svc.isOwner('别人') === false, '两者都不命中 → false');
}

// ══ T8 工具：scope 解析失败时明确报错 ═══════════════════════════════════
console.log('T8 工具降级');
{
  const config = resolveConfig({});
  const tool = createQqMemoryTool({
    store, getPersona: () => undefined, logger: { info() {}, warn() {} }, config,
  });
  const r = await tool.execute({ action: 'search', query: '群友A' }, { agent: { session: { id: 'sess-a' } } });
  eq(r.ok, false, '无 persona → 工具明确返回失败');
  ok(r.msg.includes('scope'), '错误信息说明 scope 问题');
}

// ══ T9 工具：非群会话被拒 ═══════════════════════════════════════════════
console.log('T9 工具非群会话');
{
  const config = resolveConfig({});
  const tool = createQqMemoryTool({
    store, getPersona: () => fakePersona(), logger: { info() {}, warn() {} }, config,
  });
  const r = await tool.execute({ action: 'search' }, { agent: { session: { id: '是网页会话' } } });
  eq(r.ok, false, '非 QQ 群会话 → 工具拒绝');
  ok(r.msg.includes('群'), '错误信息提到「群」');
}

// ══ T10 工具：群友 search 可用 ═══════════════════════════════════════════
console.log('T10 工具群友 search');
{
  const config = resolveConfig({});
  const tool = createQqMemoryTool({
    store, getPersona: () => fakePersona(), logger: { info() {}, warn() {} }, config,
  });
  const r = await tool.execute({ action: 'search', query: '群友A' }, { agent: { session: { id: 'sess-a' } } });
  eq(r.ok, true, '群友 search 成功');
  ok(r.msg.includes('群友A'), '返回内容含命中');
}

// ══ T11 工具：群友 remember 被拒 ═════════════════════════════════════════
console.log('T11 工具权限');
{
  const config = resolveConfig({});
  // persona 说 sess-a 的 sender 是 OWNER-1；这里造一个 sender 不是主人的
  const p = {
    resolveGroup: () => 'GID_A',
    resolveSender: () => 'SOMEONE',
    isOwner: (sid) => sid === 'OWNER-1',
  };
  const tool = createQqMemoryTool({
    store, getPersona: () => p, logger: { info() {}, warn() {} }, config,
  });
  const r = await tool.execute(
    { action: 'remember', path: 'entities/people/越权.md', content: '# 越权\n' },
    { agent: { session: { id: 'sess-a' } } },
  );
  eq(r.ok, false, '群友调用 remember → 被工具拒绝');
  ok(r.msg.includes('仅限主人'), '拒绝信息明确');
}

// ══ T12 工具：非法 action 被 defineTool 的 schema 校验拦住 ════════════════
console.log('T12 非法 action');
{
  const config = resolveConfig({});
  const tool = createQqMemoryTool({
    store, getPersona: () => fakePersona(), logger: { info() {}, warn() {} }, config,
  });
  // 注意：defineTool 会在 execute 之前做参数校验（enum 不匹配直接抛 ToolArgsError），
  //   所以非法 action **不会**进到我的 execute 里 —— 这正是期望的防线。
  let blocked = false;
  let errMsg = '';
  try {
    await tool.execute({ action: '删库' }, { agent: { session: { id: 'sess-a' } } });
  } catch (err) {
    blocked = true;
    errMsg = err instanceof Error ? err.message : String(err);
  }
  ok(blocked, '非法 action 被 schema 校验拦住（execute 未执行）');
  ok(errMsg.includes('must be one of') || errMsg.includes('action'), '报错信息指出 action 不合法');
}

// ══ T13 配置解析与数据根探测 ═════════════════════════════════════════════
console.log('T13 配置/根探测');
{
  const c = resolveConfig({});
  eq(c.searchMaxHits, 30, '默认 searchMaxHits=30');
  eq(c.ownerWriteOnly, true, '默认 ownerWriteOnly=true');
  eq(c.memorySubdir, '.qqbot-extensions/data/group-memory', '默认记忆子目录正确');
  // 2026-11-06：白名单从 1 项扩到 2 项（补上 群友A 档案，对齐旧 group_memory 的 GLOBAL_ALLOWED）
  eq(c.globalPublicFiles.length, 2, '默认 global 白名单 2 项');
  ok(c.globalPublicFiles.includes('entities/bot/identity.md'), '白名单含 bot identity');
  ok(c.globalPublicFiles.includes('entities/people/<owner>.md'), '白名单含 群友A 档案');

  const root = resolveQqbotRoot(c, { info() {}, warn() {} });
  ok(root.length > 0, '探测到 qqbot 数据根');
  ok(root.includes('dshqqbot'), '探测结果指向 dshqqbot');
}

// ══ T14 生产数据未被污染 ═════════════════════════════════════════════════
console.log('T14 生产数据未被污染');
{
  let polluted = false;
  if (prodMtime !== null) {
    try { if (statSync(PROD).mtimeMs !== prodMtime) polluted = true; } catch { polluted = true; }
  }
  ok(!polluted, '生产 group-memory mtime 未变');
}

// ══ T15 工具层 search 展示裁剪（真机实测：24 条 1503 字符塞满上下文）════════════
// 🔴 为什么需要：`store.search` 按相关度返回最多 30 条，工具层若全塞给模型：
//   ① 上下文成本高（实测 query="群友A 生日" ≈ 1503 字符 / ~800 tokens）；
//   ② 信息重复（24 条只来自 5 个文件，同文件多行吃光预算）。
//   现在按文件分组，每文件最多 3 行、最多 5 个文件，并明确提示「还有未展开的」。
console.log('\nT15 工具层 search 裁剪');
{
  const { MemoryStore } = await import('../../lib/memory/store/index.js');
  const { createQqMemoryTool } = await import('../../lib/memory/tools/qq-memory.js');

  // 造一批同文件多行的数据（模拟真实记忆库：一个人 5 行都含关键词）
  const gid = 'GID_T15';
  const base = join(ROOT, 'groups', gid);
  mkdirSync(join(base, 'entities/people'), { recursive: true });
  for (let i = 0; i < 4; i += 1) {
    const lines = ['# 人物' + i, '', '## Current'];
    for (let j = 0; j < 6; j += 1) lines.push(`- 第${j}行 关键词 群友A 生日 备注`);
    writeFileSync(join(base, `entities/people/人物${i}.md`), lines.join('\n'), 'utf8');
  }

  const store15 = new MemoryStore({ memoryRoot: ROOT, searchMaxHits: 30 });
  const scope15 = { type: 'group', id: gid };
  const svc15 = {
    list: (s, r) => store15.list(s, r),
    read: (s, r) => store15.read(s, r),
    search: (s, q) => store15.search(s, q),
  };
  const tool15 = createQqMemoryTool({
    store: store15,
    service: svc15,
    getPersona: () => ({ resolveGroup: () => gid }),
    logger: {},
    config: {},
  });
  const exec15 = { agent: { session: { id: 'sess-t15' } }, channel: { id: 'group_' + gid }, get: () => ({}) };

  const r = await tool15.execute({ action: 'search', query: '群友A 生日' }, exec15);
  ok(r.ok === true, 'search 成功');
  ok(r.count > 0, '有命中', `count=${r.count}`);

  // ① 展示体积必须显著小于「全量拼接」
  const fullText = (r.data || []).map((h) => '- ' + h.path + '｜' + h.line).join('\n');
  const msgChars = [...String(r.msg ?? '')].length;
  const fullChars = [...fullText].length;
  ok(msgChars < fullChars,
    '展示文本必须比全量小（做了裁剪）',
    `msg=${msgChars} full=${fullChars}`);

  // ② 同一文件最多 3 行
  const perFile = {};
  for (const line of String(r.msg).split('\n')) {
    if (!line.startsWith('【')) continue;
    const m = /【(.+)】/u.exec(line);
    if (m) perFile[m[1]] = 0;
  }
  // 逐文件数「  」开头的正文行
  let curFile = '';
  for (const line of String(r.msg).split('\n')) {
    const m = /【(.+)】/u.exec(line);
    if (m) { curFile = m[1]; perFile[curFile] = 0; continue; }
    if (curFile && line.startsWith('  ')) perFile[curFile] += 1;
  }
  const overLimit = Object.entries(perFile).filter(([, n]) => n > 3);
  ok(overLimit.length === 0, '每个文件展示不超过 3 行', JSON.stringify(perFile));

  // ③ 文件数不超过 5
  ok(Object.keys(perFile).length <= 5, '展示文件数不超过 5', `实际 ${Object.keys(perFile).length}`);

  // ④ 有未展开提示（模型才知道还能 read）
  ok(/还有 \d+ 条/u.test(String(r.msg)), '有命中时就提示「还有 N 条未展开」');

  // ⑤ data 里仍是完整命中（只是展示层裁剪，不丢数据）
  ok(Array.isArray(r.data) && r.data.length === r.count, 'data 保留完整命中共 count 条');

  // ⑥ 空查询也不爆
  const r2 = await tool15.execute({ action: 'search', query: '' }, exec15);
  ok([...String(r2.msg ?? '')].length < 1500, '空查询的展示文本也受控', `实际 ${[...String(r2.msg ?? '')].length} 字符`);

  // ⑦ 无命中仍是明确文案
  const r3 = await tool15.execute({ action: 'search', query: '火星飞船不存在' }, exec15);
  ok(r3.count === 0, '无关词 count=0');
  ok(String(r3.msg).includes('没有匹配'), '无关词给出明确「没有匹配」');
}

// ── 收尾 ─────────────────────────────────────────────────────────────────
try { rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }

console.log(`\n通过 ${pass} / 失败 ${fail}`);
if (fail > 0) {
  console.log('失败项：');
  for (const f of failures) console.log('  -', f);
  process.exit(1);
}
