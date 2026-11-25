/**
 * run-memory-recall — 记忆联想化 · 第一层「被动联想」单测
 *
 * 覆盖四块：
 *   T1 配置归一化（clamp / 非法值回落）
 *   T2 组装层 buildMemoryRecall（人物卡 / 群卡 / 无服务 / 关闭 / 预算）
 *   T3 宿主适配器 createMemoryRecallHost（三重防御 + 诊断节流 + 缓存复用）
 *   T4 生产数据零污染校验
 *
 * 纪律（`开发规则` 二.3）：全程 `PERSONA_DATA_ROOT` / `DSH_HOME` 指向临时目录。
 *
 * 运行：node test/run-memory-recall.mjs
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let pass = 0, fail = 0;
const failures = [];
function ok(cond, label, detail) {
  if (cond) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; failures.push(label); console.log(`  ❌ ${label}${detail ? ' — ' + detail : ''}`); }
}
function eq(a, b, label) { ok(a === b, `${label}（实际=${JSON.stringify(a)} 期望=${JSON.stringify(b)}）`); }

// ══ 测试隔离：必须在 import 之前 ══════════════════════════════════════════
const PROD_DATA = process.env.PERSONA_DATA_ROOT || ((process.env.DSH_HOME || '') + '/data/dsh-anti-ai-persona');
let prodMtime = null;
try { prodMtime = statSync(PROD_DATA).mtimeMs; } catch { prodMtime = null; }

const TMP = mkdtempSync(join(tmpdir(), 'memrecall-'));
process.env.PERSONA_DATA_ROOT = join(TMP, 'persona-data');
process.env.DSH_HOME = join(TMP, 'dsh-home');
mkdirSync(join(process.env.PERSONA_DATA_ROOT, 'state'), { recursive: true });
mkdirSync(process.env.DSH_HOME, { recursive: true });

const LIB = new URL('../../', import.meta.url).pathname.replace(/\/$/, '') + '/lib/persona/';
const F = await import(`file://${LIB}r4/memory-recall/format.js`);
const R = await import(`file://${LIB}r4/memory-recall/index.js`);
const H = await import(`file://${LIB}memory-recall-host.js`);

console.log('记忆联想（第一层）单测\n');

// ══ 假记忆服务（严格照 dsh-qq-memory 的 list/read 契约）════════════════════
/**
 * @param {Record<string,string>} files 相对路径 → 正文
 * @param {{throwOnList?:boolean, throwOnRead?:boolean}} opts
 */
function fakeService(files, opts = {}) {
  return {
    list(scope, relDir) {
      if (opts.throwOnList) throw new Error('boom-list');
      const prefix = relDir ? `${relDir.replace(/\/+$/, '')}/` : '';
      const out = Object.keys(files).filter((f) => f.startsWith(prefix));
      return { ok: true, files: out };
    },
    read(scope, relPath) {
      if (opts.throwOnRead) throw new Error('boom-read');
      const text = files[relPath];
      return text === undefined ? { ok: false } : { ok: true, text };
    },
  };
}

/** 人物卡：Current 段里带 openid（与真实存储同构）。 */
function personCard(name, openid, note) {
  return [
    '# 人物档案',
    '',
    '## Current',
    '',
    `- 群成员：${name}`,
    `- openid：${openid}`,
    `- 备注：${note}`,
  ].join('\n');
}

// 一份与生产同构的存储（人物 1 人 + 群卡 1 篇 + 1 条最近事件 + 1 条老事件 + 生日子目录）
const NOW = Date.parse('2026-11-08T12:00:00+08:00');
const dayMs = 24 * 60 * 60 * 1000;
const iso = (t) => new Date(t).toISOString().slice(0, 10);
const STORE = {
  'entities/people/群友A.md': personCard('群友A', '1A2B3C4D5E1A2B3C4D5E1A2B3C4D5E1A', '会直接调侃 bot（如「傻了吧」）'),
  'entities/groups/示例群.md': ['# 群档案', '', '## Current', '', '- 群：示例群（群号 123456）', '- 群主/主人：群友D', '- 群 openid：ABC'].join('\n'),
  [`events/${iso(NOW - dayMs)}-一起看了烟花.md`]: '# 一起看了烟花\n\n## Current\n\n- 2026-11-07：群里一起看了烟花，气氛很好\n',
  [`events/${iso(NOW - 30 * dayMs)}-老早的事.md`]: '# 老早的事\n\n## Current\n\n- 很久以前\n',
  'events/birthdays/01-01-某人.md': '# 生日\n\n## Current\n\n- 1 月 1 日\n',
  'relationships/1A2B.json': '{}',
};
const svc = fakeService(STORE);
const UID = '1a2b3c4d5e1a2b3c4d5e1a2b3c4d5e1a';
const SCOPE = { type: 'group', id: '123456' };

// ══ T1 配置归一化 ═════════════════════════════════════════════════════════
console.log('T1 配置归一化');
{
  const d = H.normalizeMemoryRecallConfig(undefined);
  eq(d.enabled, true, '缺省 enabled=true');
  eq(d.budgetChars, 280, '缺省 budgetChars=280（正文222+骨架58）');
  eq(d.personChars, 100, '缺省 personChars=100');
  eq(d.groupChars, 50, '缺省 groupChars=50');
  eq(d.eventsChars, 70, '缺省 eventsChars=70');
  eq(d.recentDays, 3, '缺省 recentDays=3');
  eq(d.maxEvents, 2, '缺省 maxEvents=2');

  // ★ 2026-11-08 自检锁定：**总预算必须 ≥ 骨架 + 分项之和**。
  //   踩坑：曾把默认 220 当「含骨架的硬上限」，正文只剩 162，
  //   而分项是 人物100+群50+事件70=220 → 事件段永远装不下（设计矛盾）。
  //   现在默认 280 = 正文 222 + 骨架 58 → 分项能装下，且总长不超外层兜底。
  {
    const F = await import(`file://${LIB}r4/memory-recall/format.js`);
    const need = d.personChars + d.groupChars + d.eventsChars;
    ok(d.budgetChars >= F.RECALL_SKELETON_CHARS + need,
      `总预算 ${d.budgetChars} ≥ 骨架 ${F.RECALL_SKELETON_CHARS} + 分项 ${need}（否则事件段永远挤不进）`);
    eq(d.budgetChars, F.RECALL_SKELETON_CHARS + need + 2, '总预算 = 骨架 + 分项 + 余量2（不多占 token）');
  }

  const c = H.normalizeMemoryRecallConfig({
    budgetChars: 9999, personChars: 1, groupChars: 5000, eventsChars: NaN,
    recentDays: 0, maxEvents: 99, maxPersonFiles: 0, cacheTtlMs: 1,
  });
  eq(c.budgetChars, 700, 'budgetChars 超上限被夹到 700');
  eq(c.personChars, 20, 'personChars 低于地板被夹到 20');
  eq(c.groupChars, 200, 'groupChars 超上限被夹到 200');
  eq(c.eventsChars, 70, 'eventsChars=NaN 回落默认 70');
  eq(c.recentDays, 1, 'recentDays 低于地板被夹到 1');
  eq(c.maxEvents, 10, 'maxEvents 超上限被夹到 10');
  eq(c.maxPersonFiles, 1, 'maxPersonFiles 低于地板被夹到 1');
  eq(c.cacheTtlMs, 10000, 'cacheTtlMs 低于地板被夹到 10s');
  eq(H.normalizeMemoryRecallConfig({ enabled: false }).enabled, false, 'enabled 可关');
}

// ══ T2 组装层 buildMemoryRecall ═══════════════════════════════════════════
console.log('T2 组装层 buildMemoryRecall');
{
  const cfg = H.normalizeMemoryRecallConfig({});
  const r = R.buildMemoryRecall({ service: svc, scope: SCOPE, userId: UID, now: NOW, config: cfg });
  ok(r.text.length > 0, '有数据 → 产出非空文本');
  ok(r.text.includes('群友A'), '人物卡命中（含昵称）');
  ok(r.text.includes('示例群'), '群卡命中');
  ok(!/openid/i.test(r.text), '注入正文不含 openid 字样（已清洗）');
  ok(!r.text.includes('1A2B3C4D5E1A2B3C4D5E1A2B3C4D5E1A'), '注入正文不含裸 openid');
  ok(!r.text.includes('ABC'), '群卡里的「群 openid：ABC」已被清洗');
  ok(!r.text.includes('老早的事'), '30 天前的事件不算「最近」（recentDays=3）');
  ok(!r.text.includes('01-01'), 'birthdays 子目录不当作普通事件');

  // ★ 2026-11-08 回归：events/ 的**单层子目录**里也可能有真实群事件（实测 events/group/）
  //   早先的过滤器把「有斜杠就丢」当规则，把真实事件全漏了 → 最近事件段永远空。
  {
    const store2 = {
      'entities/groups/x.md': ['# 群档案', '', '## Current', '', '- 群：测试群'].join('\n'),
      [`events/group/群事件-2026-11-07.md`]: '# 群事件\n\n## Current\n\n- 2026-11-07：一起去露营了\n',
      [`events/birthdays/01-01-某人.md`]: '# 生日\n\n## Current\n\n- 生日：每年 1 月 1 日\n',
      [`events/2026/05/deep/x-2026-11-06.md`]: '# 深层\n\n## Current\n\n- 不该被读到\n',
    };
    const svc2 = fakeService(store2);
    const r2 = R.buildMemoryRecall({ service: svc2, scope: SCOPE, userId: '', now: NOW, config: cfg });
    ok(r2.text.includes('一起去露营'), 'events/ 单层子目录里的真实群事件能被读到');
    ok(r2.present.events >= 1, 'present.events ≥ 1');
    ok(!r2.text.includes('不该被读到'), '两层以上子目录不读');
    ok(!r2.text.includes('生日：每年'), 'birthdays 仍被排除');
    ok(!/## Current|# 群事件/u.test(r2.text), 'markdown 结构标记已清洗');
  }
  ok(r.present.person === true, 'present.person=true');
  ok(r.present.group === true, 'present.group=true');
  ok(r.used <= cfg.budgetChars, `实际字符 ${r.used} ≤ 预算 ${cfg.budgetChars}`);

  // 陌生人：只有群卡
  const stranger = R.buildMemoryRecall({ service: svc, scope: SCOPE, userId: 'ffffffffffffffffffffffffffffffff', now: NOW, config: cfg });
  ok(stranger.present.person === false, '陌生人 present.person=false');
  ok(stranger.present.group === true, '陌生人仍有群卡');
  ok(!stranger.text.includes('群友A'), '陌生人不会看到别人的档案');

  // 无服务 / 关闭 / 空数据
  const noSvc = R.buildMemoryRecall({ service: undefined, scope: SCOPE, userId: UID, now: NOW, config: cfg });
  eq(noSvc.text, '', '无服务 → 空串（不抛）');
  const off = R.buildMemoryRecall({ service: svc, scope: SCOPE, userId: UID, now: NOW, config: { ...cfg, enabled: false } });
  eq(off.text, '', 'enabled=false → 空串');
  const empty = R.buildMemoryRecall({ service: fakeService({}), scope: SCOPE, userId: UID, now: NOW, config: cfg });
  eq(empty.text, '', '存储为空 → 空串');

  // 服务内部抛错 → 降级不抛
  let threw = false;
  try {
    const bad = R.buildMemoryRecall({ service: fakeService(STORE, { throwOnList: true }), scope: SCOPE, userId: UID, now: NOW, config: cfg });
    eq(bad.text, '', 'list 抛错 → 空串且不向外抛');
  } catch { threw = true; }
  eq(threw, false, 'list 抛错不向上抛');

  // 小预算：整段丢弃而不是切半句
  const tight = R.buildMemoryRecall({
    service: svc, scope: SCOPE, userId: UID, now: NOW,
    config: { ...cfg, budgetChars: 40, personChars: 40, groupChars: 40, eventsChars: 40 },
  });
  eq(tight.text, '', '预算 40 连固定骨架(58字)都放不下 → 不注入（而不是超预算硬塞）');
  const tight2 = R.buildMemoryRecall({
    service: svc, scope: SCOPE, userId: UID, now: NOW,
    config: { ...cfg, budgetChars: 120, personChars: 40, groupChars: 40, eventsChars: 40 },
  });
  ok(tight2.text === '' || tight2.used <= 120, `预算 120 → 实际 ${tight2.used} ≤ 120（含骨架的硬上限）`);

  // 缓存：同一 (scope,userId) 连查两次，第二次必须命中缓存（list 调用次数不增）
  const idx = new (await import(`file://${LIB}r4/memory-recall/person-card.js`)).PersonCardIndex({ cacheTtlMs: 300000, perItemChars: 100, maxFiles: 50 });
  let peopleListCalls = 0;
  const counting = {
    list(scope, rel) {
      if (String(rel ?? '') === 'entities/people') peopleListCalls++;
      return svc.list(scope, rel);
    },
    read(scope, rel) { return svc.read(scope, rel); },
  };
  R.buildMemoryRecall({ service: counting, scope: SCOPE, userId: UID, now: NOW, config: cfg, personIndex: idx });
  eq(peopleListCalls, 1, '首次查人物卡会列一次 entities/people');
  R.buildMemoryRecall({ service: counting, scope: SCOPE, userId: UID, now: NOW, config: cfg, personIndex: idx });
  eq(peopleListCalls, 1, '第二次命中人物卡缓存（不再列目录）');
}

// ══ T3 宿主适配器 createMemoryRecallHost ══════════════════════════════════
console.log('T3 宿主适配器（三重防御）');
{
  const diagDir = join(TMP, 'host-diag');
  let service = svc;
  const host = H.createMemoryRecallHost({
    getService: () => service,
    // ★ 2026-11-25：R6.2 起默认走语义召回（需 lastUserText 作查询词，没有则返回空）。
    //   本用例断言的是**经典召回路径**（人物卡摘要），所以显式关掉语义分支。
    config: H.normalizeMemoryRecallConfig({ memoryRecallSemantic: false }),
    now: () => NOW,
    diagDir,
  });
  const text = host.recall('123456', UID);
  ok(text.includes('群友A'), '正常路径能拿到人物卡');
  ok(existsSync(join(diagDir, 'memory-recall.log')), '诊断文件已落盘');
  const log1 = readFileSync(join(diagDir, 'memory-recall.log'), 'utf8').trim().split('\n').length;
  host.recall('123456', UID); // 同结果 + 未超时 → 节流，不新增行
  const log2 = readFileSync(join(diagDir, 'memory-recall.log'), 'utf8').trim().split('\n').length;
  eq(log2, log1, '相同结果重复调用被节流（诊断行数不增）');

  // ① getService 抛错
  const throwing = H.createMemoryRecallHost({
    getService: () => { throw new Error('ctx.get boom'); },
    config: H.normalizeMemoryRecallConfig({}), now: () => NOW, diagDir,
  });
  let t1 = false;
  try { eq(throwing.recall('123456', UID), '', 'getService 抛错 → 空串'); } catch { t1 = true; }
  eq(t1, false, 'getService 抛错不向外抛');

  // ② 服务存在但接口不全（版本不匹配）
  const badShape = H.createMemoryRecallHost({
    getService: () => ({ foo: 1 }),
    config: H.normalizeMemoryRecallConfig({}), now: () => NOW, diagDir,
  });
  eq(badShape.recall('123456', UID), '', '服务结构不符 → 空串');
  // ③ 服务为 undefined（插件未装）
  const none = H.createMemoryRecallHost({
    getService: () => undefined,
    config: H.normalizeMemoryRecallConfig({}), now: () => NOW, diagDir,
  });
  eq(none.recall('123456', UID), '', '服务缺席 → 空串');

  // ④ 关闭 / 空群号
  const offHost = H.createMemoryRecallHost({
    getService: () => svc,
    config: H.normalizeMemoryRecallConfig({ enabled: false }), now: () => NOW, diagDir,
  });
  eq(offHost.recall('123456', UID), '', 'enabled=false → 空串');
  eq(host.recall('', UID), '', '空群号 → 空串');

  // ⑤ 服务内部 read 抛错 → 仍不抛（群卡/事件降级）
  //   ⚠️ 必须用**新建 host**：旧 host 的人物卡缓存已命中，走缓存不会触发 read（这正是缓存的意义）。
  const thrHost = H.createMemoryRecallHost({
    getService: () => fakeService(STORE, { throwOnRead: true }),
    config: H.normalizeMemoryRecallConfig({}), now: () => NOW, diagDir,
  });
  let t2 = false;
  try { eq(thrHost.recall('123456', UID), '', 'read 全抛错 → 空串'); } catch { t2 = true; }
  eq(t2, false, 'read 抛错不向外抛');

  // ⑥ diagnostics 计数可观测
  const diag = host.diagnostics();
  eq(diag.enabled, true, 'diagnostics.enabled');
  eq(diag.budgetChars, 280, 'diagnostics.budgetChars');
  ok(diag.calls >= 3, `diagnostics.calls 已累计（${diag.calls}）`);
  ok(diag.injected >= 1, 'diagnostics.injected ≥ 1');
}

// ══ T4 生产数据零污染 ════════════════════════════════════════════════════
console.log('T4 生产数据零污染');
{
  let nowMtime = null;
  try { nowMtime = statSync(PROD_DATA).mtimeMs; } catch { nowMtime = null; }
  eq(nowMtime, prodMtime, '生产 data 目录 mtime 未变（未污染）');
  ok(!existsSync(join(PROD_DATA, 'memory-recall.log')) || prodMtime !== null, '未在生产目录写诊断（走 DSH_HOME 覆盖）');
}

// ══ 收尾 ═════════════════════════════════════════════════════════════════
try { rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
console.log(`\n${fail === 0 ? '✅' : '❌'} 通过 ${pass} / 失败 ${fail}`);
if (fail) { console.log('失败项：\n - ' + failures.join('\n - ')); process.exit(1); }
