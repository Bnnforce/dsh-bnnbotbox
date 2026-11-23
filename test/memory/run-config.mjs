/**
 * run-config — 配置解析专项测试（阶段 3.5 真机 bug 回归）
 *
 * 🔴 这个测试存在的理由（务必保留）：
 *   2026-11-06 真机踩到一个**沉默的错误**：schemastery 的 `.volatile()` 字段
 *   在未显式配置时，`validate()` 输出的是 `{}` **空对象**而非默认值。
 *   于是 `String({})` → `"[object Object]"`，
 *   memoryRoot 变成 `.../dshqqbot/[object Object]`（不存在的路径）
 *   → 工具搜索结果永远为空，**而且不报错**，排查了三轮才定位（靠 boot.log 落盘）。
 *
 *   本测试确保：无论 cordis 传进来的是空对象、schemastery 输出、还是完整配置，
 *   resolveConfig 都必须产出**类型正确的纯值**，绝不出现 `[object Object]`。
 *
 * 运行：node test/run-config.mjs
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let pass = 0, fail = 0;
const failures = [];
function ok(cond, label) {
  if (cond) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; failures.push(label); console.log(`  ❌ ${label}`); }
}
/** 相等断言（带实际/期望，排查时不用再猜）。 */
function eq(actual, expected, label) {
  ok(actual === expected, `${label}（实际=${JSON.stringify(actual)} 期望=${JSON.stringify(expected)}）`);
}

const PLUGIN = new URL('../../', import.meta.url).pathname.replace(/\/$/, '') + '/lib/memory';
const { Config, resolveConfig } = await import(`file://${join(PLUGIN, 'config.js')}`);

/** 断言一个配置对象的所有字段类型都正确。 */
function assertShape(c, label) {
  const checks = [
    ['memorySubdir 是字符串且不含 [object', typeof c.memorySubdir === 'string' && !c.memorySubdir.includes('[object')],
    ['qqbotDataRoot 是字符串', typeof c.qqbotDataRoot === 'string'],
    ['searchMaxHits 是有限数字', typeof c.searchMaxHits === 'number' && Number.isFinite(c.searchMaxHits)],
    ['searchLineMaxChars 是有限数字', typeof c.searchLineMaxChars === 'number' && Number.isFinite(c.searchLineMaxChars)],
    ['readMaxBytes 是有限数字', typeof c.readMaxBytes === 'number' && Number.isFinite(c.readMaxBytes)],
    ['writeMaxBytesPerEntry 是有限数字', typeof c.writeMaxBytesPerEntry === 'number' && Number.isFinite(c.writeMaxBytesPerEntry)],
    ['writeMaxEntriesPerScope 是有限数字', typeof c.writeMaxEntriesPerScope === 'number' && Number.isFinite(c.writeMaxEntriesPerScope)],
    ['ownerWriteOnly 是布尔', typeof c.ownerWriteOnly === 'boolean'],
    ['ownersFallback 是数组', Array.isArray(c.ownersFallback)],
    ['globalPublicFiles 是非空数组', Array.isArray(c.globalPublicFiles) && c.globalPublicFiles.length > 0],
    ['enableMaintenanceTask 是布尔', typeof c.enableMaintenanceTask === 'boolean'],
    ['maintenanceEveryMs 是有限数字', typeof c.maintenanceEveryMs === 'number' && Number.isFinite(c.maintenanceEveryMs)],
    // ★ 2026-11-09 自动建档配置
    ['autoCardEnabled 是布尔', typeof c.autoCardEnabled === 'boolean'],
    ['autoCardGroupEnabled 是布尔', typeof c.autoCardGroupEnabled === 'boolean'],
    ['autoCardMinMessages 是有限数字', typeof c.autoCardMinMessages === 'number' && Number.isFinite(c.autoCardMinMessages)],
    ['autoCardMaxPerGroup 是有限数字', typeof c.autoCardMaxPerGroup === 'number' && Number.isFinite(c.autoCardMaxPerGroup)],
    ['autoCardIgnoreNames 是非空数组', Array.isArray(c.autoCardIgnoreNames) && c.autoCardIgnoreNames.length > 0],
  ];
  for (const [name, cond] of checks) {
    ok(cond, `[${label}] ${name}`);
  }
}

console.log('config 解析测试\n');

// ══ T1 空对象（插件无配置时的最坏情况）══════════════════════════════════
console.log('T1 空对象输入');
assertShape(resolveConfig({}), '空对象');
ok(resolveConfig({}).memorySubdir === '.qqbot-extensions/data/group-memory', '[空对象] memorySubdir 走默认值');
ok(resolveConfig({}).searchMaxHits === 30, '[空对象] searchMaxHits 走默认值');

// ══ T2 schemastery 真实输出（volatile 全是 {} —— 真机踩到的形态）══════════
console.log('\nT2 schemastery 真实输出');
{
  const validated = Config['~standard'].validate({ enabled: true }).value;
  // 先确认这个前提：volatile 字段确实是 {}
  const volatileIsObject = typeof validated.memorySubdir === 'object';
  ok(volatileIsObject, '[前提] schemastery 的 volatile 字段输出是对象（不是默认值）');
  ok(String(validated.memorySubdir) === '[object Object]', '[前提] 直接 String() 会变成 [object Object]');

  const c = resolveConfig(validated);
  assertShape(c, 'schemastery输出');
  ok(c.memorySubdir === '.qqbot-extensions/data/group-memory', '[schemastery输出] 被正确修复为默认路径');
  ok(!String(c.memorySubdir).includes('[object'), '[schemastery输出] 不含 [object 字样');
}

// ══ T3 完整配置（用户显式配置时应原样生效）════════════════════════════════
console.log('\nT3 完整配置');
{
  const c = resolveConfig({
    enabled: true,
    qqbotDataRoot: '/custom/root',
    memorySubdir: 'custom/path',
    searchMaxHits: 10,
    ownerWriteOnly: false,
    globalPublicFiles: ['a/b.md'],
    maintenanceEveryMs: 3600000,
  });
  ok(c.qqbotDataRoot === '/custom/root', '[完整配置] qqbotDataRoot 原样保留');
  ok(c.memorySubdir === 'custom/path', '[完整配置] memorySubdir 原样保留');
  ok(c.searchMaxHits === 10, '[完整配置] searchMaxHits 原样保留');
  ok(c.ownerWriteOnly === false, '[完整配置] ownerWriteOnly=false 原样保留');
  ok(c.globalPublicFiles[0] === 'a/b.md', '[完整配置] globalPublicFiles 原样保留');
}

// ══ T4 脏数据（非预期类型一律走默认值，不许崩）═════════════════════════════
console.log('\nT4 脏数据容错');
{
  const dirty = resolveConfig({
    memorySubdir: { nested: true },     // 对象
    searchMaxHits: 'abc',               // 非数字
    readMaxBytes: NaN,                  // NaN
    ownerWriteOnly: 'yes',              // 字符串
    globalPublicFiles: 'not-array',     // 非数组
  });
  assertShape(dirty, '脏数据');
  ok(dirty.memorySubdir === '.qqbot-extensions/data/group-memory', '[脏数据] 对象 memorySubdir → 默认值');
  ok(dirty.searchMaxHits === 30, '[脏数据] 非数字 searchMaxHits → 默认值');
  ok(dirty.readMaxBytes === 256 * 1024, '[脏数据] NaN readMaxBytes → 默认值');
  ok(dirty.ownerWriteOnly === true, '[脏数据] 非布尔 ownerWriteOnly → 默认值');
}

// ══ T5 数值边界（防越界配置把系统搞坏）════════════════════════════════════
console.log('\nT5 数值边界');
{
  const lo = resolveConfig({ searchMaxHits: -100, maintenanceEveryMs: 1 });
  ok(lo.searchMaxHits >= 1, '[边界] searchMaxHits 下限被夹住');
  ok(lo.maintenanceEveryMs >= 60000, '[边界] maintenanceEveryMs 下限被夹住');
  const hi = resolveConfig({ searchMaxHits: 99999, readMaxBytes: 999 * 1024 * 1024 });
  ok(hi.searchMaxHits <= 200, '[边界] searchMaxHits 上限被夹住');
  ok(hi.readMaxBytes <= 50 * 1024 * 1024, '[边界] readMaxBytes 上限被夹住');

  // ★ 2026-11-09 自动建档：越界必须夹住，否则一次建几千张卡会拖垮记忆索引
  const ac = resolveConfig({ autoCardMinMessages: 99999, autoCardMaxPerGroup: -5 });
  ok(ac.autoCardMinMessages <= 1000, '[边界] autoCardMinMessages 上限被夹住');
  ok(ac.autoCardMaxPerGroup >= 1, '[边界] autoCardMaxPerGroup 下限被夹住');
}

// ══ T6 自动建档配置（2026-11-09 新增）═════════════════════════════════════
console.log('\nT6 自动建档配置');
{
  // 默认必须开（主人的诉求是「自动」），阈值保守
  const d = resolveConfig({});
  ok(d.autoCardEnabled === true, '默认开启自动建档');
  ok(d.autoCardGroupEnabled === true, '默认包含群卡');
  eq(d.autoCardMinMessages, 5, '默认最低 5 条发言才建卡');
  eq(d.autoCardMaxPerGroup, 30, '默认每群最多 30 张');
  ok(d.autoCardIgnoreNames.includes('Q群管家'), '默认忽略 Q群管家');

  // 显式配置必须生效（防 schemastery volatile 丢值的老坑）
  const e = resolveConfig({
    autoCardEnabled: false,
    autoCardGroupEnabled: false,
    autoCardMinMessages: 10,
    autoCardMaxPerGroup: 50,
    autoCardIgnoreNames: ['机器人'],
  });
  eq(e.autoCardEnabled, false, '★ 显式 enabled=false 生效');
  eq(e.autoCardGroupEnabled, false, '★ 显式 groupEnabled=false 生效');
  eq(e.autoCardMinMessages, 10, '★ 显式 minMessages 生效');
  eq(e.autoCardMaxPerGroup, 50, '★ 显式 maxPerGroup 生效');
  eq(e.autoCardIgnoreNames.length, 1, '★ 显式 ignoreNames 生效');
  ok(e.autoCardIgnoreNames[0] === '机器人', '★ ignoreNames 内容正确');

  // volatile 包装对象必须被 unwrap（否则字符串变 '[object Object]'）
  const wrap = resolveConfig({
    autoCardEnabled: Config({}).autoCardEnabled,
    autoCardMinMessages: Config({}).autoCardMinMessages,
  });
  ok(wrap.autoCardEnabled === true, '★ volatile 包装 → 解包成真实布尔');
  ok(Number.isFinite(wrap.autoCardMinMessages), '★ volatile 包装 → 解包成真实数字');
  ok(!String(wrap.autoCardMinMessages).includes('object'), '★ 不是 [object Object]');
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
if (fail > 0) {
  console.log('失败项：');
  for (const f of failures) console.log('  -', f);
  process.exit(1);
}

// ══ T6 显式配置必须生效（P0-1 真机审查抓到的 bug 回归）═══════════════════
// 🔴 这个用例存在的理由：此前 resolveConfig 只加了「类型守卫」（把 volatile 的 `{}`
//   当缺失 → 走默认值），**默认值救回来了但用户显式配置仍在丢**：
//   实测 Config({searchMaxHits:50}) → 输出仍是 30。
//   修法是先 unwrap（有 .get() 就调用）再守卫。
console.log('\nT6 显式配置生效');
{
  const validated = Config['~standard'].validate({
    enabled: true,
    searchMaxHits: 50,
    memorySubdir: 'custom/x',
    ownerWriteOnly: false,
    writeMaxEntriesPerScope: 100,
    maintenanceEveryMs: 3600000,
  }).value;
  const c = resolveConfig(validated);
  ok(c.searchMaxHits === 50, '[显式配置] searchMaxHits=50 生效', `实际 ${c.searchMaxHits}`);
  ok(c.memorySubdir === 'custom/x', '[显式配置] memorySubdir 生效', `实际 ${c.memorySubdir}`);
  ok(c.ownerWriteOnly === false, '[显式配置] ownerWriteOnly=false 生效');
  ok(c.writeMaxEntriesPerScope === 100, '[显式配置] writeMaxEntriesPerScope=100 生效');
  ok(c.maintenanceEveryMs === 3600000, '[显式配置] maintenanceEveryMs 生效');
}

// ══ T7 unwrapVolatile 本身的行为 ═════════════════════════════════════════
console.log('\nT7 unwrapVolatile');
{
  const { unwrapVolatile } = await import(`file://${join(PLUGIN, 'config.js')}`);
  ok(unwrapVolatile({ get: () => 42 }) === 42, '带 get() 的对象 → 取真实值');
  ok(unwrapVolatile(42) === 42, '普通值 → 原样返回');
  ok(unwrapVolatile({ get: () => { throw new Error('x'); } }) === undefined, 'get() 抛错 → undefined');
  ok(unwrapVolatile(null) === null, 'null → 原样');
}
