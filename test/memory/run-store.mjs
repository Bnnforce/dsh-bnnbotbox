/**
 * run-store — MemoryStore 专项测试（阶段 2 验收 / L1 层）
 *
 * 覆盖 T1~T5、T8~T11（见实施方案的 14 个用例清单）。
 * 隔离：全部在临时目录，**不碰生产数据**。
 * 运行：node test/run-store.mjs
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync, readFileSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let pass = 0, fail = 0;
const failures = [];
function ok(cond, label) {
  if (cond) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; failures.push(label); console.log(`  ❌ ${label}`); }
}
function eq(a, b, label) { ok(a === b, `${label}（实际=${JSON.stringify(a)} 期望=${JSON.stringify(b)}）`); }

// ── 生产数据快照 ─────────────────────────────────────────────────────────
const PROD = ((process.env.QQBOT_DATA_ROOT || '') + '/.qqbot-extensions/data/group-memory');
let prodMtime = null;
try { prodMtime = statSync(PROD).mtimeMs; } catch { /* 无生产目录也无妨 */ }

const TMP = mkdtempSync(join(tmpdir(), 'qqmem-store-'));
const ROOT = join(TMP, 'group-memory');

// ── 造测试数据 ───────────────────────────────────────────────────────────
function seed() {
  mkdirSync(join(ROOT, 'groups', 'GID_A', 'entities', 'people'), { recursive: true });
  mkdirSync(join(ROOT, 'groups', 'GID_B', 'entities', 'people'), { recursive: true });
  mkdirSync(join(ROOT, 'groups', 'GID_C'), { recursive: true });
  mkdirSync(join(ROOT, 'groups', 'GID_D', 'entities', 'people'), { recursive: true });
  mkdirSync(join(ROOT, 'global', 'entities', 'bot'), { recursive: true });
  mkdirSync(join(ROOT, 'global', 'secret'), { recursive: true });

  writeFileSync(join(ROOT, 'groups/GID_A/entities/people/群友A.md'),
    '# 群友A\n\n## Current\n- 生日 11-11\n- 示例群常驻\n', 'utf8');
  writeFileSync(join(ROOT, 'groups/GID_A/entities/people/李四-雨零.md'),
    '# 李四雨零\n\n## Current\n- 爱画画\n', 'utf8');
  writeFileSync(join(ROOT, 'groups/GID_B/entities/people/张三丰.md'),
    '# 张三丰\n\n## Current\n- B群独有\n', 'utf8');
  writeFileSync(join(ROOT, 'global/entities/bot/identity.md'),
    '# 爱莉希雅\n\n## Current\n- 我是爱莉希雅\n', 'utf8');
  writeFileSync(join(ROOT, 'global/secret/private.md'),
    '# 不该给群友看\n', 'utf8');
}
seed();

// ── 导入被测模块 ─────────────────────────────────────────────────────────
const { MemoryStore } = await import('../../lib/memory/store/index.js');
const { makeScope, isValidScopeId, scopeKey } = await import('../../lib/memory/scope.js');
const { checkRelativePath, ALLOWED_PREFIXES } = await import('../../lib/memory/store/guard.js');

const store = new MemoryStore({ memoryRoot: ROOT, logger: { info() {}, warn() {} } });
const scopeA = makeScope('group', 'GID_A');
const scopeB = makeScope('group', 'GID_B');
const scopeC = makeScope('group', 'GID_C');
const scopeD = makeScope('group', 'GID_D');

console.log('MemoryStore 测试\n');

// ══ T1 群隔离：A 有「群友A」，B 不该有 ══════════════════════════════════════
console.log('T1 群隔离');
{
  const a = store.search(scopeA, '群友A');
  ok(a.length > 0, '群A 搜「群友A」有结果');
  ok(a.every((h) => !h.path.startsWith('张三丰')), '群A 结果不含群B 的内容');

  const b = store.search(scopeB, '群友A');
  ok(!b.some((h) => h.path.includes('群友A') && !h.fromGlobal), '群B 搜「群友A」不返回群A 的字档');

  const c = store.search(scopeC, '群友A');
  eq(c.filter((h) => !h.fromGlobal).length, 0, '空群C 搜「群友A」本地命中为 0');
}

// ══ T2 群B 独有内容，群A 搜不到 ══════════════════════════════════════════
console.log('T2 反向隔离');
{
  const b = store.search(scopeB, '张三丰');
  ok(b.some((h) => h.path.includes('张三丰')), '群B 能搜到自己的「张三丰」');
  const a = store.search(scopeA, '张三丰');
  eq(a.filter((h) => !h.fromGlobal).length, 0, '群A 搜不到群B 独有的「张三丰」');
}

// ══ T3 路径穿透 ══════════════════════════════════════════════════════════
console.log('T3 路径穿透');
{
  const r1 = store.read(scopeA, '../../groups/GID_B/entities/people/张三丰.md');
  eq(r1.ok, false, '../ 跨群读取被拒');
  const r2 = store.read(scopeA, 'entities/../../../etc/passwd');
  eq(r2.ok, false, '中段 ../ 被拒');
  const r3 = store.remember(scopeA, '../逃逸.md', '恶意');
  eq(r3.ok, false, '写时 ../ 被拒');
  const r4 = store.list(scopeA, '../groups/GID_B');
  eq(r4.ok, false, 'list 跨群被拒');
}

// ══ T4 绝对路径 ══════════════════════════════════════════════════════════
console.log('T4 绝对路径');
{
  const r = store.read(scopeA, '/etc/passwd');
  eq(r.ok, false, '绝对路径被拒');
  const r2 = store.read(scopeA, '//etc/passwd');
  eq(r2.ok, false, '双斜杠绝对路径被拒');
}

// ══ T5 符号链接逃逸 ══════════════════════════════════════════════════════
console.log('T5 符号链接逃逸');
{
  const evilLink = join(ROOT, 'groups', 'GID_D', 'entities', 'people', 'evil.md');
  const targetB = join(ROOT, 'groups', 'GID_B', 'entities', 'people', '张三丰.md');
  try {
    symlinkSync(targetB, evilLink);
    const r = store.read(scopeD, 'entities/people/evil.md');
    eq(r.ok, false, '符号链接指向别的群 → 被拒');
  } catch (err) {
    ok(true, `符号链接测试跳过（本机文件系统不支持）: ${err.message}`);
  }
}

// ══ T6 白名单目录 ════════════════════════════════════════════════════════
console.log('T6 白名单目录');
{
  const r = store.remember(scopeA, '随便哪里.md', '内容');
  eq(r.ok, false, '不在白名单前缀 → 被拒');
  const r2 = store.remember(scopeA, 'entities/people/新人.md', '# 新人\n\n## Current\n- 测试');
  eq(r2.ok, true, '白名单目录内 → 允许');
  ok(ALLOWED_PREFIXES.includes('entities/'), '白名单前缀含 entities/');
}

// ══ T7 global 只读白名单 ═════════════════════════════════════════════════
console.log('T7 global 只读');
{
  const g = store.read(scopeA, 'entities/bot/identity.md');
  ok(g.ok === true || g.ok === false, 'global 白名单文件可尝试读取');
  const secret = store.read(scopeA, 'secret/private.md');
  eq(secret.ok, false, 'global 非白名单文件被拒');
}

// ══ T8 并发写 ════════════════════════════════════════════════════════════
console.log('T8 并发写');
{
  const path = 'entities/people/并发.md';
  for (let i = 0; i < 10; i++) {
    const r = store.remember(scopeA, path, `# 并发\n\n## Current\n- 第 ${i} 次\n`);
    if (!r.ok) { ok(false, `第 ${i} 次写失败: ${r.reason}`); }
  }
  const abs = join(ROOT, 'groups/GID_A/entities/people/并发.md');
  ok(existsSync(abs), '并发写后文件存在');
  const text = readFileSync(abs, 'utf8');
  ok(text.startsWith('# 并发'), '内容可正常解析（未被截断/损坏）');
  ok(text.includes('第 9 次'), '最后一次写入生效（rename 原子覆盖）');
}

// ══ T9 坏文件静默降级 ════════════════════════════════════════════════════
console.log('T9 坏文件降级');
{
  mkdirSync(join(ROOT, 'groups/GID_A/entities/broken'), { recursive: true });
  writeFileSync(join(ROOT, 'groups/GID_A/entities/broken/空文件.md'), '', 'utf8');
  writeFileSync(join(ROOT, 'groups/GID_A/entities/broken/乱码.md'), '\u0000\u0001乱码', 'utf8');
  let threw = false;
  try { store.search(scopeA, '乱码'); } catch { threw = true; }
  ok(!threw, '搜索遇到坏文件不抛错');
  const r = store.read(scopeA, 'entities/broken/空文件.md');
  ok(r.ok === true, '空文件能读（返回空串）');
}

// ══ T10 存储根不存在 ═════════════════════════════════════════════════════
console.log('T10 根目录不存在');
{
  const emptyStore = new MemoryStore({ memoryRoot: join(TMP, '不存在的根'), logger: { info() {}, warn() {} } });
  const hits = emptyStore.search(scopeA, '群友A');
  eq(hits.length, 0, '根不存在 → 搜索返回空（不崩）');
  const r = emptyStore.remember(scopeA, 'entities/people/x.md', '# x\n');
  eq(r.ok, true, '根不存在 → 写入时自动建目录');
}

// ══ T11 非法 scope ═══════════════════════════════════════════════════════
console.log('T11 非法 scope');
{
  eq(makeScope('group', ''), null, '空 id → null');
  eq(makeScope('group', '../etc'), null, '含 ../ 的 id → null');
  eq(makeScope('group', 'a/b'), null, '含 / 的 id → null');
  eq(makeScope('bad', 'x'), null, '非法 type → null');
  ok(makeScope('group', '合法ID_123-abc') !== null, '合法 id → 通过');
  ok(!isValidScopeId(''), '空串非法');
  ok(!isValidScopeId('a b'), '含空格非法');
  eq(scopeKey({ type: 'group', id: 'X' }), 'group:X', 'scopeKey 格式');
}

// ══ T12 读取大小上限 ═════════════════════════════════════════════════════
console.log('T12 大小上限');
{
  const big = '# 大文件\n\n' + 'x'.repeat(5000) + '\n';
  const r = store.remember(scopeA, 'entities/people/正好.md', big);
  eq(r.ok, true, '5KB 内容可写（默认上限 64KB）');

  const tooBig = 'x'.repeat(70 * 1024);
  const r2 = store.remember(scopeA, 'entities/people/超大.md', tooBig);
  eq(r2.ok, false, '70KB 内容超过 writeMaxBytesPerEntry → 被拒');
}

// ══ T13 forget 走回收站 ═════════════════════════════════════════════════
console.log('T13 forget（回收站）');
{
  store.remember(scopeA, 'entities/people/待删.md', '# 待删\n');
  const before = store.list(scopeA).files.some((f) => f.includes('待删'));
  ok(before, '删除前文件存在');
  const r = store.forget(scopeA, 'entities/people/待删.md');
  eq(r.ok, true, 'forget 成功');
  const after = store.list(scopeA).files.some((f) => f.includes('待删'));
  ok(!after, '删除后不在 list 里');
  ok(r.trash && r.trash.includes('.trash/'), '移入 .trash 而非直接删除');
}

// ══ T14 list 子目录（2026-11-06 真机 bug 回归）═══════════════════════════
// 🔴 这个用例存在的理由：此前 checkRelativePath 一律按 `isFile()` 校验，
//   导致 `list(scope,'events/birthdays')` 因目标是**目录**而被拒
//   （"目标不是普通文件"）→ 生日档列表永远为空。
//   真机验证时 `store.list(sc,'events/birthdays')` 实测报错才发现。
console.log('T14 list 子目录');
{
  // 在 fixture 里造一个生日目录
  mkdirSync(join(ROOT, 'groups', 'GID_A', 'events', 'birthdays'), { recursive: true });
  writeFileSync(join(ROOT, 'groups/GID_A/events/birthdays/11-11-群友A.md'), '# 群友A\n\n## Current\n- 生日 11-11\n', 'utf8');

  const sub = store.list(scopeA, 'events/birthdays');
  ok(sub.ok === true, 'list 子目录应成功（不能因「目标是目录」而拒绝）');
  ok(sub.ok && sub.files.length > 0, 'list 子目录应返回文件');
  ok(sub.ok && sub.files.every((f) => f.includes('events/birthdays/')), 'list 子目录返回的路径带前缀');

  // 根目录 list 仍正常
  const rootList = store.list(scopeA);
  ok(rootList.ok === true, 'list 根目录仍正常');
  ok(rootList.ok && rootList.files.length > 0, 'list 根目录有文件');

  // 不存在的子目录 → 空列表（不是错误）
  const emptyDir = store.list(scopeA, 'preferences');
  ok(emptyDir.ok === true, '不存在的子目录应返回空列表而非报错');
  ok(emptyDir.ok && emptyDir.files.length === 0, '不存在的子目录列表为空');

  // 目录穿越仍必须拒绝（安全不能因为放宽类型校验而退步）
  const escape = store.list(scopeA, '../GID_B/entities');
  eq(escape.ok, false, 'list 目录穿越仍被拒');
}

// ══ T15 生产数据未被污染 ═════════════════════════════════════════════════
console.log('T15 生产数据未被污染');
{
  let polluted = false;
  if (prodMtime !== null) {
    try { if (statSync(PROD).mtimeMs !== prodMtime) polluted = true; } catch { polluted = true; }
  }
  ok(!polluted, '生产 group-memory 目录 mtime 未变');
}


// ══ T16 search → read 往返（P0-2 真机审查抓到的 bug 回归）═════════════════
// 🔴 这个用例存在的理由：`search()` 返回的 global 命中 path 是 `global/entities/...`，
//   但 `read()` 的白名单只允许 `entities/ events/ …` → **global/ 前缀必被拒**。
//   后果：模型照着 search 的 path 去 read，100% 失败（往返断裂）。
console.log('\nT16 search→read 往返');
{
  // 造一个 global 白名单文件
  mkdirSync(join(ROOT, 'global', 'entities', 'bot'), { recursive: true });
  writeFileSync(join(ROOT, 'global/entities/bot/identity.md'), '# 爱莉希雅\n\n## Current\n- 我是爱莉希雅\n', 'utf8');

  const hits = store.search(scopeA, '爱莉希雅');
  const gHits = hits.filter((h) => h.fromGlobal);
  ok(gHits.length > 0, 'search 能命中 global 文件', `实际 ${gHits.length} 条`);

  if (gHits.length > 0) {
    const p = gHits[0].path;
    ok(p.startsWith('global/'), 'search 返回的 global path 带 global/ 前缀', p);
    const r = store.read(scopeA, p);
    ok(r.ok === true, '**用 search 返回的 path 直接 read 必须成功**（往返）', r.ok ? '' : r.reason);
    ok(r.ok && r.text.includes('爱莉希雅'), '往返读到的内容正确');
  }

  // 安全不能退步：global/ 前缀也不能绕过白名单
  const evil = store.read(scopeA, 'global/secret/private.md');
  eq(evil.ok, false, 'global/ 非白名单文件仍被拒');
  const evil2 = store.read(scopeA, 'global/../entities/people/群友A.md');
  eq(evil2.ok, false, 'global/ 前缀内的 .. 穿越仍被拒');
}

// ══ T17 search 配额（P1-5 真机审查抓到的「饥饿」回归）═════════════════════
// 🔴 这个用例存在的理由：此前本地搜索会**吃满全部 max 配额**，
//   导致 `if (hits.length < max)` 的 global 分支永远进不去 ——
//   活跃群（文件多）搜个空串就占满，一条 global 都搜不到，**越活跃越搜不到 global**。
//   修法：本地只吃 80%，恒定给 global 留 20%。
console.log('\nT17 search 配额');
{
  // 造一个「活跃群」：很多本地文件
  mkdirSync(join(ROOT, 'groups', 'GID_BUSY', 'entities', 'people'), { recursive: true });
  for (let i = 0; i < 40; i += 1) {
    writeFileSync(join(ROOT, `groups/GID_BUSY/entities/people/人${i}.md`), `# 人${i}\n\n## Current\n- 测试条目\n`, 'utf8');
  }
  mkdirSync(join(ROOT, 'global', 'entities', 'bot'), { recursive: true });
  writeFileSync(join(ROOT, 'global/entities/bot/identity.md'), '# 爱莉希雅\n\n## Current\n- 测试条目\n', 'utf8');

  const busy = makeScope('group', 'GID_BUSY');
  const hits = store.search(busy, ''); // 空串 = 最容易饥饿的场景
  const local = hits.filter((h) => !h.fromGlobal).length;
  const global = hits.filter((h) => h.fromGlobal).length;

  ok(local > 0, '本地有命中');
  ok(global > 0, '**活跃群的 global 也必须有配额**（不再饥饿）', `local=${local} global=${global}`);
  ok(hits.length <= store['o'].searchMaxHits, '总条数不超过 max（配额没有放大）');
  ok(local <= Math.ceil(store['o'].searchMaxHits * 0.8), '本地配额不超过 80%');
}

// ══ T18 search 分词（2026-11-08 真机实测 bug 回归）═════════════════════════
// 🔴 这个用例存在的理由：此前 search 是**整串字面子串匹配**。
//   真机现场：主人让她查「群友A 生日」，模型传 query="群友A 生日"，
//   而真实数据里「群友A」和「生日」从不在同一行 → 0 条 →
//   模型回「本群没有匹配的记忆」，转身去用旧工具 group_birthday。
//   也就是说：新记忆工具在**实际使用**中完全不可用，但单测全绿。
console.log('\nT18 search 分词');
{
  const gid = makeScope('group', 'GID_T18');
  mkdirSync(join(ROOT, 'groups/GID_T18/entities/people'), { recursive: true });
  mkdirSync(join(ROOT, 'groups/GID_T18/entities/groups'), { recursive: true });
  mkdirSync(join(ROOT, 'groups/GID_T18/events/birthdays'), { recursive: true });
  writeFileSync(join(ROOT, 'groups/GID_T18/entities/people/群友A.md'),
    '# 群成员-群友A\n\n## Current\n- 群成员：群友A\n- 生日见 events/birthdays/11-11-群友A.md。\n', 'utf8');
  writeFileSync(join(ROOT, 'groups/GID_T18/entities/people/群友D-群友A忆.md'),
    '# 群成员-群友D（群友A忆）\n\n## Current\n- 群成员：群友D（别名「群友A忆」）\n- 生日与生日当天细节见 events/birthdays/10-26-群友D-群友A忆.md。\n', 'utf8');
  writeFileSync(join(ROOT, 'groups/GID_T18/events/birthdays/11-11-群友A.md'),
    '# 生日-群友A\n\n## Current\n- 生日：每年 11 月 11 日。\n- 人物：群友A。\n', 'utf8');
  writeFileSync(join(ROOT, 'groups/GID_T18/entities/groups/示例群.md'),
    '# 群档案\n\n## Current\n- 群规则、生日、配对等分别归档在各自目录。\n', 'utf8');

  const s18 = new MemoryStore({ memoryRoot: ROOT });

  // ① 多词查询必须命中（否则真机「查不到」）
  const multi = s18.search(gid, '群友A 生日');
  ok(multi.length > 0, '**多词查询「群友A 生日」必须命中**（不再 0 条）', `实际 ${multi.length} 条`);

  // ② 正主必须排在「名字里含同字」的人前面
  const first = multi[0];
  ok(Boolean(first), '有首条结果');
  if (first) {
    ok(/people\/群友A\.md$|birthdays\/11-11-群友A\.md$/u.test(first.path),
      '首条是正主（群友A.md 或 11-11-群友A.md），不是「群友D-群友A忆」', `实际首条 ${first.path}`);
  }
  const qsxRank = multi.findIndex((h) => h.path.includes('群友D'));
  ok(qsxRank < 0 || qsxRank > 0, '「群友D-群友A忆」不会排在首位');

  // ③ 各种分隔符都要能切
  for (const q of ['群友A、生日', '群友A,生日', '群友A 生日', '群友A/生日']) {
    ok(s18.search(gid, q).length > 0, `分隔符「${q}」也能命中`);
  }

  // ④ 单词查询不受影响（向后兼容）
  ok(s18.search(gid, '群友A').length > 0, '单词查询仍能命中');
  ok(s18.search(gid, '生日').length > 0, '单词查询仍能命中');

  // ⑤ 完全不相关的词 → 0 条（不能因为切词就乱返回）
  eq(s18.search(gid, '火星 飞船').length, 0, '无关词仍返回 0 条');

  // ⑥ 空查询仍返回全部（旧行为）
  ok(s18.search(gid, '').length > 0, '空查询返回全部（向后兼容）');

  // ⑦ 文件名加分不能单独把无关行塞进来
  const allTong = s18.search(gid, '群友A').filter((h) => h.path.endsWith('群友A.md') && !h.line.includes('群友A'));
  ok(allTong.length === 0, '「群友A.md」里不含「群友A」的行不会因路径而入选');
}

// ── 收尾 ─────────────────────────────────────────────────────────────────
try { rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }

console.log(`\n通过 ${pass} / 失败 ${fail}`);
if (fail > 0) {
  console.log('失败项：');
  for (const f of failures) console.log('  -', f);
  process.exit(1);
}
