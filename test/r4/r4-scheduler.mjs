import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = mkdtempSync(join(process.cwd(), '.r4-sched-test-'));
process.env.PERSONA_DATA_ROOT = root;
process.on('exit', () => { try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ } });

const s = await import('../../lib/persona/r4/scheduler.js');
const paths = await import('../../lib/persona/r4/paths.js');
const cfgMod = await import('../../lib/persona/r4/config.js');
const timeMod = await import('../../lib/persona/r4/time.js');

let checks = 0;
const ok = (c, m) => { assert.ok(c, m); checks += 1; };
const eq = (a, b, m) => { assert.equal(a, b, m); checks += 1; };

const cfg = { ...cfgMod.DEFAULT_CONFIG, timezone: 'Asia/Shanghai' };

/* ── 1. 心跳间隔：落在 [base-jitter, base+jitter] 且不小于 5 分钟 ── */
const hbCfg = cfg.heartbeat_config;
eq(s.MIN_INTERVAL_MS, 5 * 60 * 1000, '最小间隔常量 = 5 分钟');
const lo = (hbCfg.interval_minutes - hbCfg.jitter_minutes) * 60000;
const hi = (hbCfg.interval_minutes + hbCfg.jitter_minutes) * 60000;
eq(s.nextIntervalMs(hbCfg, () => 0), lo, 'random=0 → 下界');
eq(s.nextIntervalMs(hbCfg, () => 1), hi, 'random=1 → 上界');
eq(s.nextIntervalMs(hbCfg, () => 0.5), 45 * 60000, 'random=0.5 → 中值 45 分钟');
// jitter 大于 base 时不得低于 5 分钟
const wildCfg = { interval_minutes: 2, jitter_minutes: 10 };
eq(s.nextIntervalMs(wildCfg, () => 0), s.MIN_INTERVAL_MS, 'jitter 过大 → 钳到 5 分钟');
// 200 次随机都在合法区间
for (let i = 0; i < 200; i += 1) {
  const ms = s.nextIntervalMs(hbCfg, () => Math.random());
  ok(ms >= s.MIN_INTERVAL_MS && ms >= lo && ms <= hi, `第 ${i} 次随机间隔在 [${lo},${hi}]`);
}
// 坏随机源兜底
eq(s.nextIntervalMs(hbCfg, () => NaN), 45 * 60000, 'NaN 随机 → 取中值');
eq(s.nextIntervalMs(hbCfg, () => { throw new Error('x'); }), 45 * 60000, '抛错随机 → 取中值（不抛）');

/* ── 2. hhmm 解析 ── */
assert.deepEqual(s.hhmmOf('03:00'), { hour: 3, minute: 0 }, '03:00 解析'); checks += 1;
assert.deepEqual(s.hhmmOf('3:05'), { hour: 3, minute: 5 }, '宽松解析 3:05（分钟两位）'); checks += 1;
assert.deepEqual(s.hhmmOf('25:00'), { hour: 23, minute: 0 }, '越界钳到 23:00'); checks += 1;
assert.deepEqual(s.hhmmOf('abc'), { hour: 3, minute: 0 }, '非法 → 默认 03:00'); checks += 1;

/* ── 3. isPastDailyRunAt：北京时间 03:00 之后为 true ── */
const at2140 = Date.UTC(2026, 10, 3, 13, 40); // 北京 21:40
eq(s.isPastDailyRunAt(at2140, '03:00'), true, '21:40 已过 03:00');
const at0230 = Date.UTC(2026, 10, 2, 18, 30); // 北京 02:30（次日）
eq(s.isPastDailyRunAt(at0230, '03:00'), false, '02:30 未过 03:00');
const at0300 = Date.UTC(2026, 10, 2, 19, 0); // 北京 03:00
eq(s.isPastDailyRunAt(at0300, '03:00'), true, '恰好 03:00 算已过（含等号）');

/* ── 4. msUntilNextDailyRun：0 < delta <= 24h ── */
for (const hh of [0, 6, 12, 18, 23]) {
  const ms = s.msUntilNextDailyRun(Date.UTC(2026, 10, 3, hh, 0), '03:00');
  ok(ms > 0 && ms <= 24 * 3600 * 1000, `${hh} 点 → 距下次 03:00 在 (0,24h]`);
}

/* ── 5. 心跳 tick：正常发送 → 状态写 waiting + dailyCount+1 ── */
let sentTo = null;
const deps = {
  heartbeat: {
    config: cfg, root,
    listGroups: () => ['GID1'],
    readMessages: () => [
      { senderId: 'u1', text: '在吗', at: Date.UTC(2026, 10, 3, 12, 0) - 60000, self: false },
    ],
    evaluate: ({ state, now, date }) => {
      // 模拟模块二：normal + 未跳过 → shouldSend
      const next = { ...state, date, state: 'waiting', waitingUntil: now + 15 * 60000, lastBotMessageAt: now, dailyCount: state.dailyCount + 1 };
      return { next, changed: true, shouldSend: true };
    },
    generate: async () => ({ text: '在忙什么呀', tag: '冷场救援' }),
    send: async (groupId, text) => { sentTo = { groupId, text }; return true; },
    now: () => Date.UTC(2026, 10, 3, 12, 0),
  },
  extraction: {
    config: cfg, root,
    listGroups: () => [],
    readMessages: () => [],
    extract: async () => ({ accepted: 0 }),
    now: () => Date.UTC(2026, 10, 3, 12, 0),
  },
};
const sched = s.createScheduler(deps);
const reports = await sched.tickHeartbeatOnce();
eq(reports.length, 1, '单群 tick 1 条报告');
eq(reports[0].sent, true, '发送成功');
eq(reports[0].dailyCount, 1, 'dailyCount = 1');
eq(sentTo.text, '在忙什么呀', '发送正文正确');
const hbFile = paths.heartbeatPath('GID1', root);
ok(existsSync(hbFile), '心跳状态文件已落盘');
const hbState = JSON.parse(readFileSync(hbFile, 'utf8'));
eq(hbState.state, 'waiting', '落盘状态 waiting');
eq(hbState.waitingUntil > 0, true, 'waitingUntil 已写');
eq(hbState.dailyCount, 1, '落盘 dailyCount 1');

/* ── 6. 心跳：生成空返回 → 跳过、**不计数、不写 waiting**（2026-11-03 修复 P0-1）── */
// 关键：这里必须提供 send（否则会先命中「无发送能力」分支，测不到生成失败路径）。
const depsEmpty = {
  ...deps,
  heartbeat: { ...deps.heartbeat, generate: async () => null, send: async () => true },
};
const reportsEmpty = await s.createScheduler(depsEmpty).tickHeartbeatOnce();
eq(reportsEmpty[0].sent, false, '空返回不发送');
eq(reportsEmpty[0].reason.includes('生成失败'), true, '跳过原因标为生成失败');
// 修复后：生成失败**不写状态** → 不能扣日配额、不能进入 waiting。
const hbEmpty = JSON.parse(readFileSync(paths.heartbeatPath('GID1', root), 'utf8'));
eq(hbEmpty.dailyCount, 1, 'dailyCount 仍是上一轮的 1（本次未再 +1）');
eq(hbEmpty.state, 'waiting', '状态保持上一轮的 waiting（本次未改写）');
ok(true, '空返回路径不抛');

/* ── 6b. 心跳：生成抛错 → 同样不计费、不进 waiting（P0-1 的关键用例）── */
const depsGenThrow = {
  ...deps,
  heartbeat: {
    ...deps.heartbeat,
    listGroups: () => ['GID_GEN_THROW'],
    generate: async () => { throw new Error('model down'); },
    send: async () => true,
  },
};
const reportsGenThrow = await s.createScheduler(depsGenThrow).tickHeartbeatOnce();
eq(reportsGenThrow[0].sent, false, '生成抛错 → 不发送');
const hbGenThrowPath = paths.heartbeatPath('GID_GEN_THROW', root);
ok(!existsSync(hbGenThrowPath), '生成抛错 → 完全没有写心跳状态文件（不计数、不进 waiting）');

/* ── 7. 心跳：发送失败 → 回滚（state=normal, waitingUntil=0, dailyCount 减回）── */
const depsFail = {
  ...deps,
  heartbeat: { ...deps.heartbeat, listGroups: () => ['GID2'], send: async () => false },
};
const reportsFail = await s.createScheduler(depsFail).tickHeartbeatOnce();
eq(reportsFail[0].sent, false, '发送失败');
eq(reportsFail[0].reason.includes('回滚'), true, '标为已回滚');
const hb2 = JSON.parse(readFileSync(paths.heartbeatPath('GID2', root), 'utf8'));
eq(hb2.state, 'normal', '回滚状态 normal');
eq(hb2.waitingUntil, 0, '回滚 waitingUntil=0');
eq(hb2.dailyCount, 0, '回滚 dailyCount 减回 0（不为负）');

/* ── 8. 心跳：无发送能力 → 不发送（不崩）── */
const reportsNoSend = await s.createScheduler(depsEmpty).tickHeartbeatOnce();
eq(reportsNoSend[0].sent, false, '无 send 能力 → 不发送');

/* ── 9. 心跳：evaluate 抛错 → 该群跳过，其它群继续（隔离）── */
const depsThrow = {
  ...deps,
  heartbeat: {
    ...deps.heartbeat,
    listGroups: () => ['GID3', 'GID4'],
    evaluate: ({ groupId, state, now, date }) => {
      if (groupId === 'GID3') throw new Error('boom');
      return { next: { ...state, date, state: 'waiting', waitingUntil: now + 900000, lastBotMessageAt: now, dailyCount: state.dailyCount + 1 }, changed: true, shouldSend: true };
    },
  },
};
const reportsThrow = await s.createScheduler(depsThrow).tickHeartbeatOnce();
eq(reportsThrow.length, 1, 'GID3 抛错被吞，只剩 GID4 报告');
eq(reportsThrow[0].groupId, 'GID4', 'GID4 正常处理');

/* ── 10. 心跳：listGroups 抛错 → 空报告不抛 ── */
const reportsList = await s.createScheduler({ ...deps, heartbeat: { ...deps.heartbeat, listGroups: () => { throw new Error('x'); } } }).tickHeartbeatOnce();
eq(reportsList.length, 0, '列群失败 → 空报告');

/* ── 11. 提取：今天已跑过 → 跳过 ── */
const nowMs = Date.UTC(2026, 10, 3, 12, 0); // 北京 20:00
const day = '2026-11-03';
await import('../../lib/shared/atomic.js').then((A) => A.writeJsonAtomic(paths.extractionStatePath(root), { lastRunDate: day }));
const depsEx1 = {
  heartbeat: deps.heartbeat,
  extraction: { ...deps.extraction, now: () => nowMs, listGroups: () => ['GID1'], extract: async () => ({ accepted: 1 }) },
};
const ex1 = await s.createScheduler(depsEx1).runExtractionOnce();
eq(ex1.skipped, true, '今天已跑过 → 跳过');
eq(ex1.groups, 0, '跳过时 groups=0');

/* ── 12. 提取：今天未跑 → 处理全部群，写 lastRunDate=今天 ── */
new (await import('../../lib/shared/atomic.js')).writeJsonAtomic(paths.extractionStatePath(root), { lastRunDate: '2026-11-02' });
const depsEx2 = {
  heartbeat: deps.heartbeat,
  extraction: {
    ...deps.extraction, now: () => nowMs,
    listGroups: () => ['GID1', 'GID2'],
    readMessages: (gid) => (gid === 'GID1' ? [{ senderId: 'u1', text: '你好', at: nowMs - 1000, self: false }] : []),
    extract: async () => ({ accepted: 2 }),
  },
};
const ex2 = await s.createScheduler(depsEx2).runExtractionOnce();
eq(ex2.skipped, false, '今天未跑 → 不跳过');
eq(ex2.groups, 2, '处理 2 个群');
eq(ex2.notes.length, 2, '2 条 note');
eq(ex2.notes[1].includes('无语料'), true, 'GID2 无语料');
const stAfter = JSON.parse(readFileSync(paths.extractionStatePath(root), 'utf8'));
eq(stAfter.lastRunDate, '2026-11-03', 'lastRunDate 写为今天');

/* ── 13. 提取：单群抛错 → 其它群继续 + 仍然写今天（不重试）── */
new (await import('../../lib/shared/atomic.js')).writeJsonAtomic(paths.extractionStatePath(root), { lastRunDate: '2026-11-01' });
const depsEx3 = {
  heartbeat: deps.heartbeat,
  extraction: {
    ...deps.extraction, now: () => nowMs,
    listGroups: () => ['BAD', 'OK'],
    readMessages: () => [{ senderId: 'u1', text: '你好', at: nowMs, self: false }],
    extract: async ({ groupId }) => { if (groupId === 'BAD') throw new Error('boom'); return { accepted: 3 }; },
  },
};
const ex3 = await s.createScheduler(depsEx3).runExtractionOnce();
eq(ex3.groups, 2, '两个群都尝试');
eq(ex3.notes.some((n) => n.includes('BAD') && n.includes('失败')), true, 'BAD 标记失败');
eq(ex3.notes.some((n) => n.includes('OK') && n.includes('3 tag')), true, 'OK 正常处理');
const st3 = JSON.parse(readFileSync(paths.extractionStatePath(root), 'utf8'));
eq(st3.lastRunDate, '2026-11-03', '失败也写今天（次日再跑，不重试）');
eq(ex3.failed, false, '单群失败不算整体 failed');

/* ── 14. 调度器：stop 幂等、start 后 stop 不再续排 ── */
const sched14 = s.createScheduler(deps);
eq(sched14.running, false, '未 start 时 running=false');
sched14.start();
eq(sched14.running, true, 'start 后 running=true');
sched14.stop();
eq(sched14.running, false, 'stop 后 running=false');
sched14.stop();
eq(sched14.running, false, 'stop 幂等');
sched14.start();
eq(sched14.running, false, 'stop 后不可再 start');

/* ── 15. 模块一联动：时间状态文案能被调度器正确按 Asia/Shanghai 取日 ── */
const zt = timeMod.zonedTime(nowMs, cfg.timezone);
eq(zt.date, '2026-11-03', 'zonedTime 日期与调度器 date 一致');
eq(timeMod.isSleepWindow(3), true, '03:00 在装死窗（心跳应跳过）');

console.log(`r4-scheduler: passed ${checks} checks`);
