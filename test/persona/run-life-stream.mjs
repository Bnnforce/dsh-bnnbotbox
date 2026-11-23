/**
 * run-life-stream — 碎片生活流单测（判定器 + 状态机）
 *
 * 纪律（`开发规则` 二.3 测试隔离红线）：
 *   在 import 被测模块**之前**把 `PERSONA_DATA_ROOT` 指向临时目录，
 *   **绝不读写生产数据**。末尾校验生产 state 目录 mtime 未变。
 *
 * 运行：node test/run-life-stream.mjs
 */
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync, readFileSync } from 'node:fs';
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
const PROD_STATE = process.env.PERSONA_DATA_ROOT || ((process.env.DSH_HOME || '') + '/data/dsh-anti-ai-persona') + '/state';
let prodMtime = null;
try { prodMtime = statSync(PROD_STATE).mtimeMs; } catch { prodMtime = null; }

const TMP = mkdtempSync(join(tmpdir(), 'lifestream-'));
process.env.PERSONA_DATA_ROOT = join(TMP, 'persona-data');
mkdirSync(join(process.env.PERSONA_DATA_ROOT, 'state'), { recursive: true });

// ══ 加载被测模块 ═════════════════════════════════════════════════════════
const M = await import('file://' + (new URL('../../', import.meta.url).pathname.replace(/\/$/, '')) + '/lib/persona/r4/life-stream.js');
const S = await import('file://' + (new URL('../../', import.meta.url).pathname.replace(/\/$/, '')) + '/lib/persona/r4/life-stream-state.js');

const D = M.LIFE_STREAM_DEFAULTS;
const ROOT = process.env.PERSONA_DATA_ROOT;

console.log('碎片生活流单测\n');

// ══ T1 配置夹取（clampLifeStreamConfig）═══════════════════════════════════
console.log('T1 配置夹取');
{
  const c = M.clampLifeStreamConfig({ dailyMax: 99, minGapMs: 1000, hoursFrom: 30, hoursTo: 0 });
  eq(c.dailyMax, 3, 'dailyMax 超上限被夹到 3');
  eq(c.minGapMs, M.HARD_MIN_GAP_MS, 'minGapMs 低于地板被夹到 30 分钟');
  eq(c.hoursFrom, 23, 'hoursFrom 超 23 被夹');
  eq(c.hoursTo, 1, 'hoursTo 低于 1 被夹');
  const c2 = M.clampLifeStreamConfig({ dailyMax: 0, minGapMs: 1e12 });
  eq(c2.dailyMax, 1, 'dailyMax 低于 1 被抬到 1');
  eq(c2.minGapMs, M.HARD_MAX_GAP_MS, 'minGapMs 超天花板被夹到 12 小时');
  const c3 = M.clampLifeStreamConfig(undefined);
  eq(c3.dailyMax, 3, 'undefined → 默认 3');
  eq(c3.enabled, true, 'undefined → 默认开启');
  // dead >= busy 的强制
  const c4 = M.clampLifeStreamConfig({ busyWindowMs: 10 * 60_000, deadWindowMs: 60_000 });
  ok(c4.deadWindowMs >= c4.busyWindowMs, 'deadWindowMs 被抬到 >= busyWindowMs（防死区）');
}

// ══ T2 时段窗口（严格半开区间）══════════════════════════════════════════
console.log('\nT2 时段窗口');
{
  eq(M.isHourInWindow(8, 8, 24), true, '[8,24) 含 8');
  eq(M.isHourInWindow(23, 8, 24), true, '[8,24) 含 23');
  // ⚠️ 入参 hour=24 会被 clamp 到 23（本模块把 hour 夹到 0..23），
  //    所以这里验的是「越界小时被安全夹取」，而不是「24 不在窗口」。
  eq(M.isHourInWindow(24, 8, 24), true, 'hour=24 被夹到 23 → 仍在 [8,24) 内');
  eq(M.isHourInWindow(7, 8, 24), false, '[8,24) 不含 7');
  eq(M.isHourInWindow(3, 8, 24), false, '深夜 3 点不在窗口');
  eq(M.isHourInWindow(23, 22, 6), true, '跨零 [22,6) 含 23');
  eq(M.isHourInWindow(2, 22, 6), true, '跨零 [22,6) 含 2');
  eq(M.isHourInWindow(12, 22, 6), false, '跨零 [22,6) 不含 12');
  eq(M.isHourInWindow(5, 5, 5), false, '零宽窗口 → 永不开口');
}

// ══ T3 判定器：8 道闸门逐个验证 ══════════════════════════════════════════
console.log('\nT3 判定器闸门');
{
  const base = {
    // ⚠️ 必须用真实量级的时间戳：若 now 太小，now-gap 会变负数，
    //    而 lastAt<=0 表示「从未开口」，会被跳过 → 测试假失败。
    now: 1794000000000, hour: 14, todayCount: 0, lastAt: 0,
    groupIdleMs: 30 * 60_000, material: '在院子里晒太阳', materialUsed: false,
    config: D,
  };

  eq(M.decideLifeStream({ ...base, config: { ...D, enabled: false } }).reason, 'disabled', '① 总开关关闭 → disabled');
  eq(M.decideLifeStream({ ...base, hour: 3 }).reason, 'night', '② 深夜 → night');
  eq(M.decideLifeStream({ ...base, todayCount: 3 }).reason, 'quota', '③ 今天已说 3 次 → quota');
  eq(M.decideLifeStream({ ...base, lastAt: base.now - 30 * 60_000 }).reason, 'gap', '④ 隔 30 分钟 → gap');
  eq(M.decideLifeStream({ ...base, material: '' }).reason, 'no-material', '⑤ 无素材 → no-material');
  eq(M.decideLifeStream({ ...base, material: '   ' }).reason, 'no-material', '⑤ 空白素材 → no-material');
  eq(M.decideLifeStream({ ...base, materialUsed: true }).reason, 'material-used', '⑥ 素材已用 → material-used');
  eq(M.decideLifeStream({ ...base, groupIdleMs: 60_000 }).reason, 'busy', '⑦ 群刚聊天(1分钟) → busy');
  eq(M.decideLifeStream({ ...base, groupIdleMs: 4 * 3600_000 }).reason, 'dead', '⑧ 群死寂4小时 → dead');

  const go = M.decideLifeStream(base);
  eq(go.ok, true, '全部通过 → go');
  eq(go.material, '在院子里晒太阳', 'go 时返回素材');

  // 边界
  eq(M.decideLifeStream({ ...base, lastAt: base.now - 90 * 60_000 }).ok, true, '正好隔 90 分钟 → go（半开下界）');
  eq(M.decideLifeStream({ ...base, lastAt: base.now - 89 * 60_000 }).reason, 'gap', '隔 89 分钟 → gap');
  eq(M.decideLifeStream({ ...base, todayCount: 2 }).ok, true, '已说 2 次 → 还能说第 3 次');
  eq(M.decideLifeStream({ ...base, hour: 8 }).ok, true, '8 点（窗口起点）→ go');
  // ⚠️ 边界是「严格小于才 busy」：正好 5 分钟算「刚过忙线」，可以开口。
  eq(M.decideLifeStream({ ...base, groupIdleMs: 5 * 60_000 }).ok, true, '正好 5 分钟 → 不算 busy（严格小于才算）');
  eq(M.decideLifeStream({ ...base, groupIdleMs: 5 * 60_000 - 1 }).reason, 'busy', '差 1ms 不到 5 分钟 → busy');
  eq(M.decideLifeStream({ ...base, groupIdleMs: 5 * 60_000 + 1 }).ok, true, '5 分钟多 1ms → go');

  // -1 = 读不到 → 跳过活跃度两道闸门
  eq(M.decideLifeStream({ ...base, groupIdleMs: -1 }).ok, true, 'idle=-1（读不到）→ 跳过 busy/dead，仍可 go');
}

// ══ T4 Prompt 构造 ════════════════════════════════════════════════════════
console.log('\nT4 Prompt 构造');
{
  const p = M.buildLifeStreamPrompt({ material: '在院子里晒太阳', slotLabel: '下午', recentChat: 'A: 你好' });
  ok(p.includes('在院子里晒太阳'), 'prompt 含素材');
  ok(p.includes('下午'), 'prompt 含时段中文名');
  ok(p.includes('要主动提起') || p.includes('本轮要主动提起'), 'prompt 明确要求主动提起');
  ok(p.includes('不要先评论群'), 'prompt 禁止评论群状态');
  ok(p.includes('不要求回应'), 'prompt 禁止求回应');
  ok(p.includes('不要报备式打卡'), 'prompt 禁止打卡报备');
  ok(p.includes('不超过 25 字'), 'prompt 含长度约束');
  eq(M.buildLifeStreamPrompt({ material: '', slotLabel: '', recentChat: '' }), '', '空素材 → 空 prompt');

  const p2 = M.buildLifeStreamPrompt({ material: '在看书', slotLabel: '晚上', recentChat: '' });
  ok(p2.includes('（群里这会儿没人说话）'), '无群聊时有兜底文案');
}

// ══ T5 输出清洗（本地强校验）═════════════════════════════════════════════
console.log('\nT5 输出清洗');
{
  eq(M.sanitizeLifeStreamOutput('[生活流] 茶凉了一半'), '茶凉了一半', '剥掉 [生活流] 前缀');
  eq(M.sanitizeLifeStreamOutput('【主动冒泡】茶凉了一半'), '茶凉了一半', '剥掉【主动冒泡】前缀');
  eq(M.sanitizeLifeStreamOutput('（这条是主动冒泡）茶凉了一半'), '茶凉了一半', '剥掉圆括号元信息');
  eq(M.sanitizeLifeStreamOutput('"茶凉了一半"'), '茶凉了一半', '剥掉引号包裹');
  eq(M.sanitizeLifeStreamOutput('「茶凉了一半」'), '茶凉了一半', '剥掉书名号包裹');
  eq(M.sanitizeLifeStreamOutput('消息：茶凉了一半'), '茶凉了一半', '剥掉「消息：」前缀');
  eq(M.sanitizeLifeStreamOutput('  茶凉了一半  '), '茶凉了一半', '去首尾空白');
  eq(M.sanitizeLifeStreamOutput(''), '', '空输入 → 空串');
  eq(M.sanitizeLifeStreamOutput(null), '', 'null → 空串');
  eq(M.sanitizeLifeStreamOutput('茶 凉 了'), '茶 凉 了', '不误删正常内容里的空格');
}

// ══ T6 状态层：读写与降级 ════════════════════════════════════════════════
console.log('\nT6 状态层');
{
  const s0 = S.readLifeStreamState(ROOT);
  eq(s0.todayCount, 0, '文件缺失 → 默认 count=0');
  eq(Array.isArray(s0.usedMaterials), true, '文件缺失 → usedMaterials 是数组');
  eq(s0.lastAt, 0, '文件缺失 → lastAt=0');

  const today = '2026-11-07';
  const st = S.markSpeaked({ ...S.EMPTY_LIFE_STREAM, date: today }, 100, '在晒太阳');
  eq(st.todayCount, 1, 'markSpeaked → count+1');
  eq(st.lastAt, 100, 'markSpeaked → lastAt 更新');
  ok(st.usedMaterials.includes('在晒太阳'), 'markSpeaked → 素材入 used');

  const st2 = S.markSpeaked(st, 200, '在看书');
  eq(st2.todayCount, 2, '再标一次 → count=2');
  eq(st2.usedMaterials.length, 2, '两条素材都在');

  // 同一素材重复标记不重复入数组
  const st3 = S.markSpeaked(st2, 300, '在看书');
  eq(st3.usedMaterials.length, 2, '同一素材不重复入数组（先去重再追加）');

  // 写盘 + 读回
  ok(S.writeLifeStreamState(st3, ROOT), '写状态成功');
  const back = S.readLifeStreamState(ROOT);
  // st(1次) → st2(2次) → st3(3次)，所以写盘的是 3
  eq(back.todayCount, 3, '读回 count 一致（3 次）');
  eq(back.usedMaterials.length, 2, '读回素材一致');

  // 跨天重置
  const next = S.resetIfNewDay(back, '2026-11-08');
  eq(next.todayCount, 0, '跨天 → count 归零');
  eq(next.lastAt, 0, '跨天 → lastAt 归零');
  eq(next.usedMaterials.length, 2, '跨天 → usedMaterials 保留（防素材重复）');
  eq(next.date, '2026-11-08', '跨天 → date 更新');

  // 同一天 → 原样
  const same = S.resetIfNewDay(back, '2026-11-07');
  eq(same.todayCount, back.todayCount, '同一天 → 不重置');

  // 损坏文件
  writeFileSync(S.lifeStreamPath(ROOT), '{坏掉的JSON', 'utf8');
  const broken = S.readLifeStreamState(ROOT);
  eq(broken.todayCount, 0, '损坏文件 → 降级为默认，不抛');
}

// ══ T7 usedMaterials 上限 ════════════════════════════════════════════════
console.log('\nT7 usedMaterials 上限');
{
  let st = { ...S.EMPTY_LIFE_STREAM, date: '2026-11-07' };
  for (let i = 0; i < 40; i += 1) st = S.markSpeaked(st, 1000 + i, `素材${i}`);
  ok(st.usedMaterials.length <= S.MAX_USED_MATERIALS, `超过上限被截断（实际 ${st.usedMaterials.length}）`);
  ok(st.usedMaterials.includes('素材39'), '最新素材保留');
  ok(!st.usedMaterials.includes('素材0'), '最老素材被丢弃');
}

// ══ T8 isMaterialUsed ════════════════════════════════════════════════════
console.log('\nT8 isMaterialUsed');
{
  const st = { ...S.EMPTY_LIFE_STREAM, usedMaterials: ['A', 'B'] };
  eq(S.isMaterialUsed(st, 'A'), true, '已用 → true');
  eq(S.isMaterialUsed(st, 'C'), false, '未用 → false');
  eq(S.isMaterialUsed(st, ''), false, '空串 → false');
}

// ══ T8b 历史素材归一化（2026-11-07 实测 bug 回归）═══════════════════════
// 🔴 病因：早期写入的 usedMaterials 带 markdown 前缀（「- xxx」），
//   后来加了素材清洗（剥掉「- 」），两者对不上 → isMaterialUsed 恒 false → 去重失效。
//   修法：normalizeState 里统一剥前缀（读写两侧都归一化）。
console.log('\nT8b 历史素材归一化');
{
  const dirty = {
    date: '2026-11-07', todayCount: 1, lastAt: 100,
    usedMaterials: ['- 正在想，如果在乐土放烟花', '* 另一条', '+ 第三条', '正常素材'],
  };
  writeFileSync(S.lifeStreamPath(ROOT), JSON.stringify(dirty), 'utf8');
  const st = S.readLifeStreamState(ROOT);
  const clean = '正在想，如果在乐土放烟花';
  eq(S.isMaterialUsed(st, clean), true, '带前缀的历史记录被归一化后可正确去重');
  ok(!st.usedMaterials.some((x) => x.startsWith('- ')), '读回后不再带「- 」前缀');
  ok(st.usedMaterials.includes('正常素材'), '正常素材原样保留');
}

// ══ T9 生产数据零污染 ════════════════════════════════════════════════════
console.log('\nT9 生产数据零污染');
{
  let polluted = false;
  if (prodMtime !== null) {
    try { if (statSync(PROD_STATE).mtimeMs !== prodMtime) polluted = true; } catch { polluted = true; }
  }
  ok(!polluted, '生产 state 目录 mtime 未变');
  ok(!readFileSync(S.lifeStreamPath(ROOT), 'utf8').includes('生产'), '测试用的是临时目录');
}

// ── 收尾 ─────────────────────────────────────────────────────────────────
try { rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }

console.log(`\n通过 ${pass} / 失败 ${fail}`);
if (fail > 0) {
  console.log('失败项：');
  for (const f of failures) console.log('  -', f);
  process.exit(1);
}
