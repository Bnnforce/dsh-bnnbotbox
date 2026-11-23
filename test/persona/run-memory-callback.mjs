/**
 * run-memory-callback — 记忆联想化 · 第二层「主动惦记」单测
 *
 * 覆盖：
 *   T1 配置归一化          T2 小时窗口（严格半开）
 *   T3 生日倒计时          T4 关系等级排序
 *   T5 候选检测（生日/老友）  T6 跳级检测
 *   T7 频率闸门 + 优先级 + 冷却
 *   T8 prompt 约束          T9 状态机 + 落盘（隔离目录）
 *   T10 生产数据零污染
 *
 * 运行：node test/run-memory-callback.mjs
 */
import { mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
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

const TMP = mkdtempSync(join(tmpdir(), 'memcallback-'));
process.env.PERSONA_DATA_ROOT = join(TMP, 'persona-data');
process.env.DSH_HOME = join(TMP, 'dsh-home');
mkdirSync(join(process.env.PERSONA_DATA_ROOT, 'state'), { recursive: true });
mkdirSync(process.env.DSH_HOME, { recursive: true });

const LIB = new URL('../../', import.meta.url).pathname.replace(/\/$/, '') + '/lib/persona/';
const C = await import(`file://${LIB}r4/memory-recall/callback.js`);
const S = await import(`file://${LIB}r4/memory-recall/callback-state.js`);

const ROOT = process.env.PERSONA_DATA_ROOT;
const NOW = Date.parse('2026-11-08T15:20:00+08:00');
const TODAY = { year: 2026, month: 11, day: 8 };
const dayMs = 24 * 60 * 60 * 1000;

console.log('记忆联想（第二层·主动惦记）单测\n');

// ══ T1 配置归一化 ═════════════════════════════════════════════════════════
console.log('T1 配置归一化');
{
  const d = C.clampMemoryCallbackConfig(undefined);
  eq(d.enabled, true, '缺省 enabled=true');
  eq(d.dailyMax, 1, '缺省 dailyMax=1');
  eq(d.minGapDays, 7, '缺省 minGapDays=7');
  eq(d.hoursFrom, 10, '缺省 hoursFrom=10');
  eq(d.hoursTo, 21, '缺省 hoursTo=21');
  eq(d.minMessages, 20, '缺省 minMessages=20');
  eq(d.birthdayWithinDays, 3, '缺省 birthdayWithinDays=3');
  eq(d.perUserCooldownDays, 14, '缺省 perUserCooldownDays=14');

  const c = C.clampMemoryCallbackConfig({
    dailyMax: 99, minGapDays: 0, hoursFrom: 99, hoursTo: 0, minMessages: -5,
    birthdayWithinDays: 99, perUserCooldownDays: 0, minGapMs: 1,
  });
  eq(c.dailyMax, C.HARD_MAX_DAILY, 'dailyMax 超上限被夹到硬上限 3');
  eq(c.minGapDays, 1, 'minGapDays 低于地板被夹到 1');
  eq(c.hoursFrom, 23, 'hoursFrom 超上限被夹到 23');
  eq(c.hoursTo, 1, 'hoursTo 低于地板被夹到 1');
  eq(c.minMessages, 0, 'minMessages 不为负');
  eq(c.birthdayWithinDays, C.HARD_MAX_BIRTHDAY_DAYS, 'birthdayWithinDays 夹到 7');
  eq(c.perUserCooldownDays, 1, 'perUserCooldownDays 夹到 1');
  eq(c.minGapMs, C.HARD_MIN_GAP_MS, 'minGapMs 抬到 2 小时地板');
  eq(C.clampMemoryCallbackConfig({ enabled: false }).enabled, false, 'enabled 可关');
}

// ══ T2 小时窗口 ═══════════════════════════════════════════════════════════
console.log('T2 小时窗口（严格半开）');
{
  ok(C.isHourInWindow(10, 10, 21), '10:00 在 [10,21) 内');
  ok(C.isHourInWindow(20, 10, 21), '20:00 在内');
  ok(!C.isHourInWindow(21, 10, 21), '21:00 不在内（右开）');
  ok(!C.isHourInWindow(9, 10, 21), '9:00 不在内（左开）');
  ok(!C.isHourInWindow(12, 10, 10), 'from==to → 恒 false（不开口）');
  ok(C.isHourInWindow(23, 22, 6) === false || C.isHourInWindow(23, 22, 6) === true, '跨午夜窗口不抛');
  ok(C.isHourInWindow(0, 22, 6), '跨午夜 0:00 在内');
}

// ══ T3 生日倒计时 ═════════════════════════════════════════════════════════
console.log('T3 生日倒计时');
{
  eq(C.daysUntilMonthDay(11, 8, TODAY), 0, '今天生日 → 0');
  eq(C.daysUntilMonthDay(11, 9, TODAY), 1, '明天生日 → 1');
  eq(C.daysUntilMonthDay(11, 11, TODAY), 3, '11-11 → 3 天');
  ok(C.daysUntilMonthDay(11, 7, TODAY) > 300, '已过去 → 算到明年（大数）');
  eq(C.daysUntilMonthDay(13, 1, TODAY), Number.POSITIVE_INFINITY, '非法月份 → Infinity');
}

// ══ T4 等级排序 ═══════════════════════════════════════════════════════════
console.log('T4 关系等级排序');
{
  eq(C.levelRank('L2'), 2, 'L2 → 2');
  eq(C.levelRank('l3'), 3, '小写 l3 → 3');
  eq(C.levelRank(''), 0, '空串 → 0（未知）');
  eq(C.levelRank('亲密'), 0, '非 Lx 格式 → 0');
}

// ══ T5 候选检测 ═══════════════════════════════════════════════════════════
console.log('T5 候选检测');
{
  const cfg = C.clampMemoryCallbackConfig({});
  const relationships = [
    { userId: 'U1', level: 'L2', updatedAt: NOW - 12 * dayMs, messageCount: 80 }, // 老友 12 天没来
    { userId: 'U2', level: 'L1', updatedAt: NOW - 1 * dayMs, messageCount: 100 }, // 昨天来过
    { userId: 'U3', level: 'L1', updatedAt: NOW - 30 * dayMs, messageCount: 3 },  // 沉寂但非老友
    { userId: 'U4', level: 'L1', updatedAt: 0, messageCount: 50 },               // 从未互动
  ];
  const birthdays = [
    { name: '张三丰', month: 11, day: 9 },
    { name: '群友A', month: 11, day: 11 },
    { name: '路人', month: 3, day: 15 },
  ];
  const list = C.detectCandidates({
    groupId: 'G1', relationships, birthdays, today: TODAY, now: NOW, config: cfg,
    nameOf: (uid) => (uid === 'U1' ? '群友A' : ''),
  });
  const kinds = list.map((c) => c.kind);
  ok(kinds.includes('birthday'), '生日候选命中');
  const bday = list.find((c) => c.kind === 'birthday');
  eq(bday?.priority, 0, '生日优先级最高（0）');
  ok(list.filter((c) => c.kind === 'birthday').length === 2, '只有 2 天内/3 天内的生日（3-15 不算）');
  const absent = list.find((c) => c.kind === 'absent');
  eq(absent?.userId, 'U1', '老友久未出现命中 U1');
  eq(absent?.name, '群友A', '老友名字通过 nameOf 反查');
  ok(!list.some((c) => c.userId === 'U2'), '昨天来过的人不算（未达 7 天）');
  ok(!list.some((c) => c.userId === 'U3'), 'messageCount 不足的人不算（不是老友）');
  ok(!list.some((c) => c.userId === 'U4'), '从未互动的人不算（updatedAt=0）');

  // ★ 2026-11-08 决策 A：自己的生日交给 ext-birthday-auto（当天一次），本层不铺垫
  {
    const bdays = [
      { name: '爱莉希雅', month: 11, day: 11 },
      { name: '群友A', month: 11, day: 9 },
    ];
    const withSelf = C.detectCandidates({
      groupId: 'G1', relationships: [], birthdays: bdays, today: TODAY, now: NOW,
      config: cfg, selfName: '爱莉希雅',
    });
    eq(withSelf.length, 1, '只提醒别人（自己的被跳过）');
    eq(withSelf[0]?.name, '群友A', '剩下的是群友A');
    ok(!withSelf.some((c) => c.name === '爱莉希雅'), '自己的生日不在候选里');

    // 配置显式打开 → 自己也算（方便以后改回）
    const onCfg = C.clampMemoryCallbackConfig({ ownBirthday: true });
    eq(onCfg.ownBirthday, true, 'ownBirthday 可显式打开');
    const withSelfOn = C.detectCandidates({
      groupId: 'G1', relationships: [], birthdays: bdays, today: TODAY, now: NOW,
      config: onCfg, selfName: '爱莉希雅',
    });
    eq(withSelfOn.length, 2, '打开后自己的生日也进候选');

    // 没传 selfName（读不到人设名）→ 不能误判，全保留
    const noName = C.detectCandidates({
      groupId: 'G1', relationships: [], birthdays: bdays, today: TODAY, now: NOW, config: cfg,
    });
    eq(noName.length, 2, '读不到人设名时不跳过任何人（保守）');

    eq(C.clampMemoryCallbackConfig({}).ownBirthday, false, '默认 ownBirthday=false（决策 A）');
  }
}

// ══ T6 跳级检测 ═══════════════════════════════════════════════════════════
console.log('T6 跳级检测');
{
  const relationships = [
    { userId: 'U1', level: 'L3' },
    { userId: 'U2', level: 'L2' },
    { userId: 'U3', level: 'L1' },
  ];
  const levels = { 'G1:U1': 'L2', 'G1:U2': 'L2' }; // U1 升了，U2 没变，U3 无基线
  const jumps = C.detectLevelJumps({ groupId: 'G1', relationships, levels, nameOf: () => '某人' });
  eq(jumps.length, 1, '只报真正升级的人');
  eq(jumps[0]?.userId, 'U1', 'U1 从 L2 → L3');
  eq(jumps[0]?.priority, 1, '跳级优先级 1（低于生日、高于老友）');
  ok(!jumps.some((x) => x.userId === 'U3'), '没有基线的人不报（避免首次误报）');
}

// ══ T7 频率闸门 + 优先级 + 冷却 ═══════════════════════════════════════════
console.log('T7 频率闸门');
{
  const cfg = C.clampMemoryCallbackConfig({});
  const empty = { date: '2026-11-08', todayCount: 0, lastAt: 0, used: {}, levels: {} };
  const cand = (kind, priority, uid, name) => ({ kind, priority, userId: uid, name: name ?? '某人', reason: 'x' });
  const base = { groupId: 'G1', now: NOW, hour: 15, config: cfg };

  eq(C.pickCallback({ ...base, candidates: [cand('absent', 2, 'U1')], state: empty }).ok, true, '正常条件 → 开口');
  eq(C.pickCallback({ ...base, candidates: [cand('absent', 2, 'U1')], state: empty, config: { ...cfg, enabled: false } }).reason, 'disabled', '关闭 → disabled');
  eq(C.pickCallback({ ...base, hour: 22, candidates: [cand('absent', 2, 'U1')], state: empty }).reason, 'hour', '窗口外 → hour');
  eq(C.pickCallback({ ...base, candidates: [cand('absent', 2, 'U1')], state: { ...empty, todayCount: 1 } }).reason, 'quota', '当天配额用完 → quota');
  eq(C.pickCallback({ ...base, candidates: [cand('absent', 2, 'U1')], state: { ...empty, lastAt: NOW - 60_000 } }).reason, 'gap', '距上次太近 → gap');
  eq(C.pickCallback({ ...base, candidates: [], state: empty }).reason, 'no-candidate', '无候选 → no-candidate');

  // 优先级：生日 > 跳级 > 老友
  const sortable = C.pickCallback({
    ...base,
    candidates: [cand('absent', 2, 'U1'), cand('levelup', 1, 'U2'), cand('birthday', 0, '', '三月')],
    state: empty,
  });
  eq(sortable.candidate?.kind, 'birthday', '优先级：生日最先');
  const sortable2 = C.pickCallback({ ...base, candidates: [cand('absent', 2, 'U1'), cand('levelup', 1, 'U2')], state: empty });
  eq(sortable2.candidate?.kind, 'levelup', '优先级：跳级高于老友');

  // 单人冷却
  const usedState = { ...empty, used: { 'G1:U1:absent': NOW - 3 * dayMs } };
  eq(C.pickCallback({ ...base, candidates: [cand('absent', 2, 'U1')], state: usedState }).reason, 'cooldown', '14 天内不再惦记同一人');
  const oldUsed = { ...empty, used: { 'G1:U1:absent': NOW - 20 * dayMs } };
  eq(C.pickCallback({ ...base, candidates: [cand('absent', 2, 'U1')], state: oldUsed }).ok, true, '超过冷却可以再惦记');
}

// ══ T8 prompt 约束 ════════════════════════════════════════════════════════
console.log('T8 prompt 约束');
{
  const p = C.buildCallbackPrompt({
    candidate: { kind: 'birthday', userId: '', name: '群友A', reason: '明天生日', priority: 0 },
    timeText: '11-08 15:20',
    recentChat: '在聊晚饭',
  });
  ok(p.includes('群友A'), 'prompt 带上对象名字');
  ok(p.includes('明天生日'), 'prompt 带上触发理由');
  ok(/不要\s*@/u.test(p), '明确禁止 @ 人');
  ok(/不解释/u.test(p), '禁止解释「怎么突然想起」');
  ok(/20-40\s*字/u.test(p), '长度约束存在');
  ok(p.includes('别重复'), '带上最近聊天防撞车');
  eq(C.buildCallbackPrompt({ candidate: null }), '', '无候选 → 空 prompt');

  // 自己生日（生日档案里可能记着 bot 自己的生日）→ 换一套说法
  const selfPrompt = C.buildCallbackPrompt({
    candidate: { kind: 'birthday', userId: '', name: '爱莉希雅', reason: '3 天后生日', priority: 0 },
    timeText: '11-08 10:20',
    selfName: '爱莉希雅',
  });
  ok(/你自己的生日快到了/u.test(selfPrompt), '自己生日 → 用「自己的生日」说法');
  ok(!/你忽然想起/u.test(selfPrompt), '自己生日不说「想起爱莉希雅」');
  ok(/不暗示礼物/u.test(selfPrompt), '自己生日明确不要礼物/祝福');
  const otherPrompt = C.buildCallbackPrompt({
    candidate: { kind: 'birthday', userId: '', name: '群友A', reason: '明天生日', priority: 0 },
    selfName: '爱莉希雅',
  });
  ok(/你忽然想起群友A/u.test(otherPrompt), '别人生日仍按「想起某个群友」写');
}

// ══ T9 状态机 + 落盘 ══════════════════════════════════════════════════════
console.log('T9 状态机');
{
  const empty = { date: '', todayCount: 0, lastAt: 0, used: {}, levels: {} };
  const same = C.resetIfNewDay({ ...empty, date: '2026-11-08', todayCount: 1 }, '2026-11-08');
  eq(same.todayCount, 1, '同一天不重置');
  const reset = C.resetIfNewDay({ ...empty, date: '2026-11-07', todayCount: 2, lastAt: 5 }, '2026-11-08');
  eq(reset.todayCount, 0, '跨天重置 todayCount');
  eq(reset.lastAt, 5, '跨天保留 lastAt（间隔判定要用）');

  const cand = { kind: 'absent', userId: 'U1', name: '群友A', reason: 'x', priority: 2 };
  const marked = C.markCallback(empty, { groupId: 'G1', candidate: cand, now: NOW });
  eq(marked.todayCount, 1, 'markCallback 计数 +1');
  eq(marked.lastAt, NOW, 'markCallback 记录 lastAt');
  eq(marked.used['G1:U1:absent'], NOW, 'markCallback 记录单人冷却 key');

  const leveled = C.recordLevels(empty, {
    groupId: 'G1',
    relationships: [{ userId: 'U1', level: 'L3' }, { userId: 'U2', level: '' }],
  });
  eq(leveled.levels['G1:U1'], 'L3', 'recordLevels 写入等级');
  ok(!('G1:U2' in leveled.levels), '空等级不写入');

  // 脏数据归一化
  const dirty = C.normalizeCallbackState({ todayCount: -3, lastAt: 'abc', used: { a: 1, b: 'x' }, levels: { c: 'L1', d: 2 } });
  eq(dirty.todayCount, 0, '负计数归零');
  eq(dirty.lastAt, 0, '非法 lastAt 归零');
  ok(dirty.used.a === 1 && !('b' in dirty.used), 'used 只保留合法数字');
  ok(dirty.levels.c === 'L1' && !('d' in dirty.levels), 'levels 只保留合法字符串');

  // 落盘 roundtrip（隔离目录）
  const st = C.markCallback(empty, { groupId: 'G1', candidate: cand, now: NOW });
  eq(S.writeCallbackState(st, ROOT), true, '写状态成功');
  const back = S.readCallbackState(ROOT);
  eq(back.todayCount, 1, '读回 todayCount 一致');
  eq(back.used['G1:U1:absent'], NOW, '读回 used 一致');
  eq(JSON.stringify(S.readCallbackState(join(ROOT, '不存在'))), JSON.stringify(C.EMPTY_CALLBACK_STATE), '路径不存在 → 空状态（不抛）');
}

// ══ T10 生产数据零污染 ════════════════════════════════════════════════════
console.log('T10 生产数据零污染');
{
  let nowMtime = null;
  try { nowMtime = statSync(PROD_DATA).mtimeMs; } catch { nowMtime = null; }
  eq(nowMtime, prodMtime, '生产 data 目录 mtime 未变');
}

try { rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
console.log(`\n${fail === 0 ? '✅' : '❌'} 通过 ${pass} / 失败 ${fail}`);
if (fail) { console.log('失败项：\n - ' + failures.join('\n - ')); process.exit(1); }
