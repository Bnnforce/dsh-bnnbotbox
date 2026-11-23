/**
 * R4.0 · 2026-11-03 体检修复的**回归测试**。
 *
 * 一条用例对应《R4.0-修复方案与检测报告.md》里的一个编号（P0-1 / P1-3 ...），
 * 任何一条回归即断言失败。
 *
 * 跑法：
 *   cd ~/.dsh/plugins/dsh-anti-ai-persona
 *   ./node_modules/.bin/tsc -p tsconfig.json      # 先编译 src -> lib
 *   node test-r4/r4-fixes.mjs
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/* 隔离数据根：绝不碰生产目录 */
const root = mkdtempSync(join(process.cwd(), '.r4-fixes-'));
process.env.PERSONA_DATA_ROOT = root;
process.on('exit', () => { try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ } });

let checks = 0;
const ok = (c, m) => { assert.ok(c, m); checks += 1; };
const eq = (a, b, m) => { assert.equal(a, b, m); checks += 1; };
const deep = (a, b, m) => { assert.deepEqual(a, b, m); checks += 1; };
const noThrow = (fn, m) => {
  try { fn(); } catch (e) { assert.fail(m + '：不应抛错，实际抛了 ' + (e instanceof Error ? e.message : String(e))); }
  checks += 1;
};

const atomic = await import('../../lib/shared/atomic.js');
const paths = await import('../../lib/persona/r4/paths.js');
const state = await import('../../lib/persona/r4/state.js');
const time = await import('../../lib/persona/r4/time.js');
const sample = await import('../../lib/persona/r4/sample.js');
const cfgMod = await import('../../lib/persona/r4/config.js');
const heartbeat = await import('../../lib/persona/r4/heartbeat.js');
const { evaluateTick, resolveWaitingMinutes } = heartbeat;
const replyDetect = await import('../../lib/persona/r4/reply-detect.js');
const schedulerMod = await import('../../lib/persona/r4/scheduler.js');
const sulk = await import('../../lib/persona/r4/sulk.js');
const profileStore = await import('../../lib/persona/r4/profile-store.js');
const relStore = await import('../../lib/persona/r4/relationship-store.js');
const profileView = await import('../../lib/persona/r4/profile-view.js');
const botIdentity = await import('../../lib/persona/r4/bot-identity.js');
const r4mod = await import('../../lib/persona/r4/index.js');
const fuse = await import('../../lib/persona/r4/fuse.js');

const UID = 'FADE0003FADE0003FADE0003FADE0003';
/** 北京时间 2026-11-03 20:00 */
const NOW = Date.UTC(2026, 10, 3, 12, 0);
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const cfg = cfgMod.DEFAULT_CONFIG;
// ★ 2026-11-05（心跳人性化·阶段 1）：本文件测的是「迁移 / 兜底 / 脏数据」逻辑，
//   跟被测群的活跃度无关。而 `DEFAULT_CONFIG` 现在默认 `min_quiet_minutes=20`，
//   多数用例的 `lastNonBotMessageAt` 都落在 10 分钟内 → 会先命中新加的
//   「群最近有人说话 → 跳过」，把真正被测的分支整个盖掉（表现为 state 停在 waiting）。
//   这里显式关掉该判定，保持这些用例测的东西不变。
cfg.heartbeat_config = { ...cfg.heartbeat_config, min_quiet_minutes: 0 };
const silent = { info: () => {}, warn: () => {} };

/* ============================================================
 * P0-1  生成失败不得「先写 waiting 再发送」
 * ============================================================ */
{
  const mkHb = (gid, over = {}) => ({
    config: cfg, root,
    listGroups: () => [gid],
    readMessages: () => [],
    evaluate: ({ state: s, now, date }) => ({
      next: { ...s, date, state: 'waiting', waitingUntil: now + 15 * MIN, lastBotMessageAt: now, dailyCount: s.dailyCount + 1 },
      changed: true, shouldSend: true,
    }),
    generate: async () => ({ text: '在忙什么呀' }),
    send: async () => true,
    now: () => NOW,
    ...over,
  });
  const exDeps = { config: cfg, root, listGroups: () => [], readMessages: () => [], extract: async () => ({ accepted: 0 }), now: () => NOW };

  const g1 = 'P0-1-THROW';
  const r1 = await schedulerMod.createScheduler({
    heartbeat: mkHb(g1, { generate: async () => { throw new Error('model down'); } }),
    extraction: exDeps,
  }).tickHeartbeatOnce();
  eq(r1.length, 1, '生成抛错仍返回 1 条报告');
  eq(r1[0].sent, false, '生成抛错 → 不发送');
  ok(!existsSync(paths.heartbeatPath(g1, root)), '生成抛错 → 完全未写心跳状态（不计数、不进 waiting）');

  const g2 = 'P0-1-NULL';
  const r2 = await schedulerMod.createScheduler({
    heartbeat: mkHb(g2, { generate: async () => null }),
    extraction: exDeps,
  }).tickHeartbeatOnce();
  eq(r2[0].sent, false, '生成返回 null → 不发送');
  ok(!existsSync(paths.heartbeatPath(g2, root)), '生成返回 null → 未写心跳状态');

  const g3 = 'P0-1-NOSEND';
  const r3 = await schedulerMod.createScheduler({
    heartbeat: mkHb(g3, { send: undefined }),
    extraction: exDeps,
  }).tickHeartbeatOnce();
  eq(r3[0].sent, false, '无发送能力 → 不发送');
  ok(!existsSync(paths.heartbeatPath(g3, root)), '无发送能力 → 未写心跳状态（不白扣配额）');

  const g4 = 'P0-1-OK';
  const r4 = await schedulerMod.createScheduler({ heartbeat: mkHb(g4), extraction: exDeps }).tickHeartbeatOnce();
  eq(r4[0].sent, true, '正常路径发送成功');
  const hb = JSON.parse(readFileSync(paths.heartbeatPath(g4, root), 'utf8'));
  eq(hb.state, 'waiting', '正常路径落盘 waiting');
  eq(hb.dailyCount, 1, '正常路径 dailyCount=1');
}

/* ============================================================
 * P0-2 / P1-1  @bot 与「引用 bot」必须基于原始 <@...>
 * ============================================================ */
{
  const m2 = sample.toMessage({ s: UID, t: NOW, k: 'text', x: '<@BOTID> 你好呀' });
  ok(m2 !== null, '含 @ 的消息能解析成消息对象');
  deep(m2.mentioned, ['BOTID'], 'mentioned 保留原始 @ 目标');
  eq(m2.text.includes('<@'), false, '清洗后正文不含 <@...>');
  eq(m2.mentionedBot, false, '采样层不知道 bot 是谁 → mentionedBot 默认 false');
  eq(m2.quoteOfSelf, false, 'quoteOfSelf 默认 false');

  const all = sample.toMessage({ s: UID, t: NOW, k: 'text', x: '<@all> 大家好' });
  eq(all.mentionAll, true, '<@all> 识别为 @全体');
  deep(all.mentioned, [], '@all 不进 mentioned 列表');

  const detection = cfg.reply_detection;
  const listA = [{ senderId: UID, text: '你好', at: NOW - 1000, self: false, mentioned: ['BOTID'] }];
  eq(replyDetect.hasSomeoneReplied({ state: { lastBotMessageAt: NOW - 2000 }, messages: listA, replyDetection: detection, botId: 'BOTID', now: NOW }), true, 'A：原文 @bot → 有人回复');
  eq(replyDetect.hasSomeoneReplied({ state: { lastBotMessageAt: NOW - 2000 }, messages: listA, replyDetection: detection, botId: 'OTHER', now: NOW }), false, 'A：@ 的不是 bot → 不算');

  const listB = [{ senderId: UID, text: '哈哈', at: NOW - 1000, self: false, quoteOfSelf: true }];
  eq(replyDetect.hasSomeoneReplied({ state: { lastBotMessageAt: NOW - 2000 }, messages: listB, replyDetection: detection, now: NOW }), true, 'B：引用 bot 消息 → 有人回复');
}

/* ============================================================
 * P1-2  A/B 判定必须限定在 waiting 窗口内（防重复发心跳）
 * ============================================================ */
{
  const detection = cfg.reply_detection;
  const waitStart = NOW - 15 * MIN;
  const outside = [
    { senderId: UID, text: '你好', at: NOW - 25 * MIN, self: false, mentioned: ['BOTID'] },
    { senderId: 'self', text: '在忙什么呢', at: waitStart, self: true },
  ];
  eq(
    replyDetect.hasSomeoneReplied({ state: { lastBotMessageAt: waitStart }, messages: outside, replyDetection: detection, botId: 'BOTID', now: NOW, sinceAt: waitStart }),
    false,
    'P1-2：@ 发生在 waiting 起点之前 → 不算有人回复（旧实现会误判为 true）',
  );
  const inside = [
    { senderId: UID, text: '你好', at: NOW - 5 * MIN, self: false, mentioned: ['BOTID'] },
    { senderId: 'self', text: '在忙什么呢', at: waitStart, self: true },
  ];
  eq(
    replyDetect.hasSomeoneReplied({ state: { lastBotMessageAt: waitStart }, messages: inside, replyDetection: detection, botId: 'BOTID', now: NOW, sinceAt: waitStart }),
    true,
    'P1-2：@ 发生在 waiting 窗口内 → 算有人回复',
  );

  // 注意：lastNonBotMessageAt 必须落在 2h 内，否则会先命中「死群」分支而测不到迁移。
  const fresh = NOW - 10 * MIN;
  const st = { date: '2026-11-03', dailyCount: 1, lastNonBotMessageAt: fresh, lastBotMessageAt: waitStart, state: 'waiting', cold: false, coldSetAt: 0, waitingUntil: NOW, cooldownUntil: 0 };
  const v = heartbeat.evaluateTick({ state: st, now: NOW, date: '2026-11-03', heartbeat: cfg.heartbeat_config, lastNonBotMessageAt: fresh, repliedDuringWait: false });
  eq(v.state.state, 'cooldown', 'waiting 到期无人回复 → cooldown');
  eq(v.state.cold, true, '进入 cooldown 时 cold=true');
}

/* ============================================================
 * P1-3  脏截止时间不得让心跳死锁
 * ============================================================ */
{
  const base = { date: '2026-11-03', dailyCount: 0, lastNonBotMessageAt: NOW - 1000, lastBotMessageAt: NOW, state: 'waiting', cold: false, coldSetAt: 0, waitingUntil: NOW + 100 * DAY, cooldownUntil: 0 };
  const v = heartbeat.evaluateTick({ state: base, now: NOW, date: '2026-11-03', heartbeat: cfg.heartbeat_config, lastNonBotMessageAt: NOW - 1000 });
  eq(v.changed, true, 'P1-3：脏 waitingUntil 被识别为需要修正');
  eq(v.state.state, 'normal', 'P1-3：100 天后的 waitingUntil → 强制回 normal（不再死锁）');
  eq(v.state.waitingUntil, 0, 'P1-3：脏 waitingUntil 已清零');

  const v2 = heartbeat.evaluateTick({ state: { ...base, state: 'cooldown', waitingUntil: 0, cooldownUntil: NOW + 100 * DAY }, now: NOW, date: '2026-11-03', heartbeat: cfg.heartbeat_config, lastNonBotMessageAt: NOW - 1000 });
  eq(v2.state.state, 'normal', 'P1-3：100 天后的 cooldownUntil → 强制回 normal');

  const bad = { date: '2026-11-03', dailyCount: 3, lastNonBotMessageAt: Infinity, lastBotMessageAt: -5, state: 'cooldown', cold: true, coldSetAt: NaN, waitingUntil: 1e20, cooldownUntil: -1e20 };
  atomic.writeJsonAtomic(paths.heartbeatPath('P1-3', root), bad);
  const read = state.readHeartbeat('P1-3', root, silent);
  eq(read.lastNonBotMessageAt, 0, 'Infinity 时间戳 → 0');
  eq(read.lastBotMessageAt, 0, '负数时间戳 → 0');
  eq(read.coldSetAt, 0, 'NaN 时间戳 → 0');
  eq(read.waitingUntil, 0, '超上限时间戳 → 0');
  eq(read.cooldownUntil, 0, '负向超界时间戳 → 0');

  const healthy = { date: '2026-11-03', dailyCount: 0, lastNonBotMessageAt: NOW - 1000, lastBotMessageAt: NOW, state: 'waiting', cold: false, coldSetAt: 0, waitingUntil: NOW + 5 * MIN, cooldownUntil: 0 };
  const v4 = heartbeat.evaluateTick({ state: healthy, now: NOW, date: '2026-11-03', heartbeat: cfg.heartbeat_config, lastNonBotMessageAt: NOW - 1000 });
  eq(v4.shouldSend, false, '正常等待期内（5 分钟）仍然跳过，不被误伤');
  eq(v4.state.state, 'waiting', '正常 waiting 状态保持');
}

/* ============================================================
 * P1-4  时区：非法配置不得抛错，跨天固定 Asia/Shanghai
 * ============================================================ */
{
  eq(time.isValidTimeZone('Asia/Shanghai'), true, 'Asia/Shanghai 合法');
  eq(time.isValidTimeZone('UTC'), true, 'UTC 合法（但运行逻辑会归一）');
  eq(time.isValidTimeZone('Asia/Shanghia'), false, '拼错时区 → 非法');
  eq(time.isValidTimeZone(''), false, '空串 → 非法');
  eq(time.isValidTimeZone(null), false, 'null → 非法');
  eq(time.isValidTimeZone(123), false, '数字 → 非法');
  eq(time.resolveTimeZone('Wan/Chuan'), 'Asia/Shanghai', '非法时区 → 回退 Asia/Shanghai');
  eq(time.resolveTimeZone('   '), 'Asia/Shanghai', '空白 → 回退 Asia/Shanghai');

  const late = Date.UTC(2026, 10, 3, 15, 30);
  eq(sample.dayKeyOf(late), '2026-11-03', '23:30（+8）→ 2026-11-03');
  const midnight = Date.UTC(2026, 10, 3, 16, 30);
  eq(sample.dayKeyOf(midnight), '2026-11-04', '跨天：00:30（+8）→ 2026-11-04（UTC 仍是 11-03）');
  eq(sample.dayKeyOf(midnight, 'UTC'), '2026-11-03', '（对照）按 UTC 算会相差一天');

  noThrow(() => sample.dayKeyOf(midnight, 'Not/AZone'), 'dayKeyOf 非法时区不抛');
  ok(/^\d{4}-\d{2}-\d{2}$/u.test(sample.dayKeyOf(NaN)), '非法时间戳 → 仍返回合法日期串');

  const merged = cfgMod.mergeConfig({ timezone: 'Asia/Shanghia' });
  eq(merged.config.timezone, 'Asia/Shanghai', '配置里的非法时区 → 归一为 Asia/Shanghai');
  ok(merged.warnings.some((w) => w.includes('timezone')), '非法时区产生一条 warning');

  noThrow(() => schedulerMod.isPastDailyRunAt(NOW, '03:00', 'Bad/Zone'), 'isPastDailyRunAt 非法时区不抛');
  noThrow(() => schedulerMod.msUntilNextDailyRun(NOW, '03:00', 'Bad/Zone'), 'msUntilNextDailyRun 非法时区不抛');
  ok(schedulerMod.msUntilNextDailyRun(NOW, '03:00', 'Bad/Zone') > 0, '非法时区兜底仍返回正延迟');
}

/* ============================================================
 * P1-9 / P1-10  路径安全：sanitize 与目录逃逸
 * ============================================================ */
{
  eq(paths.sanitizeId('abc-123_DEF'), 'abc-123_DEF', '合法 id 原样保留');
  eq(paths.sanitizeId('a/b'), 'a_b', '斜杠 → 下划线');
  eq(paths.sanitizeId('../../etc'), '______etc', '穿越串被净化（无斜杠残留）');
  eq(paths.sanitizeId('!!!'), null, '全非法 → null');
  eq(paths.sanitizeId('   '), null, '空白 → null');
  eq(paths.sanitizeId(undefined), null, 'undefined → null');

  ok(!paths.heartbeatPath('../../evil', root).includes('..'), 'heartbeatPath 不产生穿越路径');
  ok(paths.heartbeatPath('../../evil', root).startsWith(paths.heartbeatDir(root)), 'heartbeatPath 仍在 heartbeat 目录内');
  ok(paths.relationshipsPath('a/b', root).startsWith(paths.relationshipsDir(root)), 'relationshipsPath 被净化后仍在本目录');
  ok(paths.profileEventsPath('../../x', root).startsWith(paths.profileEventsDir(root)), 'profileEventsPath 被净化');
  ok(paths.profilePath('../../x', root).startsWith(paths.profilesDir(root)), 'profilePath 被净化');
  eq(paths.heartbeatPath('!!!', root), '', '非法 groupId → 空串（拒绝写）');
  eq(paths.profilePath('!!!', root), '', '非法 userId → 空串（拒绝写）');

  eq(state.writeHeartbeat('!!!', state.readHeartbeat('GOK', root, silent), root, silent), false, '非法 groupId → 写心跳返回 false');
  eq(state.writeRelationships('!!!', {}, root, silent), false, '非法 groupId → 写关系返回 false');
  eq(state.writeProfileEvents('!!!', { events: [] }, root, silent), false, '非法 userId → 写事件返回 false');

  ok(paths.dictPath('configs/sensitive_words.json', root).startsWith(root), '合法相对路径 → 落在 root 内');
  eq(paths.dictPath('/etc/passwd', root), '', '绝对路径 → 拒绝（空串）');
  eq(paths.dictPath('../../outside.json', root), '', '../ 穿越 → 拒绝（空串）');
  eq(paths.dictPath('configs/../../outside.json', root), '', '中途穿越 → 拒绝');
  eq(atomic.readJsonSafe(paths.dictPath('../../outside.json', root)), undefined, '穿越路径读不到任何东西');
}

/* ============================================================
 * P2-1  原子写：tmp -> fsync -> rename，且不残留 .tmp
 * ============================================================ */
{
  const dir = join(root, 'atomic');
  mkdirSync(dir, { recursive: true });
  const target = join(dir, 'x.json');
  eq(atomic.writeJsonAtomic(target, { a: 1 }), true, '原子写成功返回 true');
  eq(JSON.parse(readFileSync(target, 'utf8')).a, 1, '内容正确落盘');
  deep(readdirSync(dir).filter((f) => f.includes('.tmp')), [], '成功后不留 .tmp 残留');

  const dirAsFile = join(dir, 'sub');
  mkdirSync(dirAsFile, { recursive: true });
  eq(atomic.writeJsonAtomic(dirAsFile, { a: 1 }), false, '写入失败 → 返回 false 不抛');
  deep(readdirSync(dir).filter((f) => f.startsWith('sub.tmp')), [], '写失败后临时文件被清理');

  const cyc = {}; cyc.self = cyc;
  noThrow(() => atomic.writeJsonAtomic(join(dir, 'cyc.json'), cyc), '循环引用不抛');
  eq(atomic.writeJsonAtomic(join(dir, 'cyc.json'), cyc), false, '循环引用 → 返回 false');

  writeFileSync(join(dir, 'broken.json'), '{ not json');
  eq(atomic.readJsonSafe(join(dir, 'broken.json')), undefined, '损坏 JSON → undefined（不抛）');
  writeFileSync(join(dir, 'empty.json'), '   ');
  eq(atomic.readJsonSafe(join(dir, 'empty.json')), undefined, '空白文件 → undefined');
}

/* ============================================================
 * P2-2  读-改-写不得覆盖并发更新
 * ============================================================ */
{
  const gid = 'P2-2';
  atomic.writeJsonAtomic(paths.relationshipsPath(gid, root), { OTHER: { level: 'L1', score: 12, scoreCooldowns: { reply: 0, mention: 0, bot: 0 } } });
  const out = relStore.applyScore({ groupId: gid, userId: 'ME', kind: 'reply', root, now: NOW, cfg: cfg.relationship_config, logger: silent });
  eq(out.scored, true, '计分成功');
  const file = JSON.parse(readFileSync(paths.relationshipsPath(gid, root), 'utf8'));
  eq(file.OTHER.score, 12, '既有用户记录未被覆盖（读-改-写一体）');
  eq(file.OTHER.level, 'L1', '既有用户等级未丢失');
  eq(file.ME.score, 2, '新用户按时计分（接梗 +2）');

  const dicts = { sensitiveWords: [], synonyms: { 猫图: '喜欢猫图' }, negativeWords: [], memes: [], missing: [] };
  // ★ 2026-11-04 双层记忆：本段原用「3 次临时 tag」触发写 md 以产生 index.json。
  //   新语义下临时事件永不写 md，故改用**永久标签**（1 次即写），下游断言全部沿用。
  profileStore.persistExtraction({
    userId: 'U1', output: { tags: [{ tag: '猫图', category: '常用表情/梗', permanent: true }] },
    dictionaries: dicts, privacyWhitelist: cfg.privacy_whitelist, root, now: NOW, logger: silent,
  });
  const idxBefore = JSON.parse(readFileSync(paths.profilesIndexPath(root), 'utf8'));
  ok(idxBefore.U1.coldStartUntil > 0, '画像 index 记录了冷启动时间');
  relStore.markTagMentionsByReply({ userId: 'U1', tags: ['喜欢猫图'], root, now: NOW + DAY, logger: silent });
  const idxAfter = JSON.parse(readFileSync(paths.profilesIndexPath(root), 'utf8'));
  eq(idxAfter.U1.coldStartUntil, idxBefore.U1.coldStartUntil, 'markTagMentions 未覆盖 coldStartUntil');
  // ★ 2026-11-05 R4.3：lastMentionedTags 结构升级为 { at, count }，断言兼容两种形态
  const mentioned = idxAfter.U1.lastMentionedTags['喜欢猫图'];
  const mentionedAt = typeof mentioned === 'object' && mentioned ? Number(mentioned.at) : Number(mentioned);
  ok(mentionedAt > 0, 'markTagMentions 已写入 lastMentionedTags（兼容旧数字 / 新 {at,count}）');
}

/* ============================================================
 * P1-7 / P1-8  小脾气前缀与「装死被吵醒」文案（不再只是死代码）
 * ============================================================ */
{
  ok(sulk.SULK_PREFIX.includes('哼'), '小脾气文案存在');
  const coldNormal = { date: '2026-11-03', dailyCount: 1, lastNonBotMessageAt: NOW, lastBotMessageAt: NOW, state: 'normal', cold: true, coldSetAt: NOW - 1000, waitingUntil: 0, cooldownUntil: 0 };
  eq(sulk.shouldInjectSulk(coldNormal, NOW), true, 'cold=true 且 state=normal → 应注入');
  eq(sulk.shouldInjectSulk({ ...coldNormal, state: 'cooldown' }, NOW), false, 'cooldown 未到期 → 不注入');
  eq(sulk.shouldInjectSulk({ ...coldNormal, cold: false }, NOW), false, 'cold=false → 不注入');
  eq(sulk.withSulkPrefix('在忙什么呀').startsWith(sulk.SULK_PREFIX), true, '前缀已拼上');
  eq(sulk.withSulkPrefix('哼，才没有'), '哼，才没有', '已以「哼」开头 → 不重复加');
  const cleared = sulk.clearCold(coldNormal);
  eq(cleared.cold, false, 'clearCold 后 cold=false');
  eq(cleared.coldSetAt, 0, 'clearCold 后 coldSetAt 清零');
  eq(sulk.shouldInjectSulk({ ...coldNormal, coldSetAt: NOW - 25 * HOUR }, NOW), false, 'cold 超 24h → 兜底清掉，不注入');

  const rt = r4mod.createR4Runtime({
    qqbotDataRoot: join(root, 'qq'),
    logger: silent,
    now: () => NOW,
    listGroups: () => ['SULK'],
    sendToGroup: async () => true,
    complete: async () => '在忙什么呀',
  }, root, { persona: 'elysia' });
  atomic.writeJsonAtomic(paths.heartbeatPath('SULK', root), coldNormal);
  const dec = rt.decorateOutgoing({ groupId: 'SULK', text: '在忙什么呀' });
  eq(dec.injected, true, 'P1-7：decorateOutgoing 真的注入前缀（不再是死代码）');
  ok(dec.text.includes('哼'), 'P1-7：返回正文含小脾气前缀');
  const after = JSON.parse(readFileSync(paths.heartbeatPath('SULK', root), 'utf8'));
  eq(after.cold, false, 'P1-7：注入后 cold 已清除并落盘');
  eq(rt.decorateOutgoing({ groupId: 'SULK', text: '再聊一句' }).injected, false, '第二次不再注入（幂等）');
  rt.stop();

  eq(time.sleepWokeText(), '[状态：熟睡被吵醒，语气朦胧]', '图纸模块一文案逐字一致');
  const rt2 = r4mod.createR4Runtime({
    qqbotDataRoot: join(root, 'qq2'),
    logger: silent,
    now: () => Date.UTC(2026, 10, 3, 19, 30),
    listGroups: () => ['WOKE'],
    random: () => 0.01,
    resolveGroupId: () => 'WOKE',
    resolveSenderId: () => UID,
    sendToGroup: async () => true,
    complete: async () => '嗯...',
  }, root, { persona: 'elysia' });
  const verdict = rt2.onMessage({ groupId: 'WOKE', userId: UID, text: '在吗在吗' });
  eq(verdict.allow, true, 'P1-8：装死窗内被吵醒 → 放行');
  eq(verdict.wokeText, time.sleepWokeText(), 'P1-8：返回 wokeText');
  const injected = rt2.assemble({ agent: { session: { id: 'S' } } });
  ok(injected.includes('熟睡被吵醒'), 'P1-8：注入正文真的带上「熟睡被吵醒」文案');
  rt2.stop();
}

/* ============================================================
 * P1-11  bot-identity 不再硬编码日期
 * ============================================================ */
{
  const qroot = join(root, 'qq-id');
  const gid2 = 'IDGROUP';
  const dir = join(qroot, '.qqbot', 'msg-history', 'group_' + gid2);
  mkdirSync(dir, { recursive: true });
  const today = sample.dayKeyOf(Date.now());
  const lines = [];
  for (let i = 0; i < 12; i += 1) {
    lines.push(JSON.stringify({ s: UID, n: '路人', t: Date.now() - 1000, k: 'text', x: '<@BOTSELF123456789> 你好' }));
  }
  writeFileSync(join(dir, today + '.jsonl'), lines.join('\n'));
  eq(botIdentity.inferBotOpenidFromHistory(qroot, 3, silent), 'BOTSELF123456789', 'P1-11：按「今天」文件名推断成功（不再硬编码日期）');
  noThrow(() => botIdentity.readBotSelfOpenid(join(root, 'nope'), silent), 'readBotSelfOpenid 缺文件不抛');
  eq(botIdentity.readBotSelfOpenid(join(root, 'nope'), silent), '', '缺文件 → 空串');
}

/* ============================================================
 * P2-3  心跳间隔只有一份实现（scheduler 复用 heartbeat）
 * ============================================================ */
{
  const hbCfg = cfg.heartbeat_config;
  const lo = (hbCfg.interval_minutes - hbCfg.jitter_minutes) * MIN;
  const hi = (hbCfg.interval_minutes + hbCfg.jitter_minutes) * MIN;
  eq(schedulerMod.nextIntervalMs(hbCfg, () => 0), lo, 'random=0 → 下界');
  eq(schedulerMod.nextIntervalMs(hbCfg, () => 1), hi, 'random=1 → 上界');
  eq(schedulerMod.nextIntervalMs(hbCfg, () => 0.5), 45 * MIN, 'random=0.5 → 中值');
  for (const r of [0, 0.1, 0.37, 0.5, 0.9, 1]) {
    eq(schedulerMod.nextIntervalMs(hbCfg, () => r), heartbeat.nextIntervalMs(hbCfg, () => r), 'P2-3：r=' + r + ' 两份实现逐点一致');
  }
  eq(schedulerMod.nextIntervalMs({ interval_minutes: 2, jitter_minutes: 10 }, () => 0), schedulerMod.MIN_INTERVAL_MS, 'jitter 过大 → 钳到 5 分钟');
}

/* ============================================================
 * 附加：装死窗口边界严格 02:00-06:00
 * ============================================================ */
{
  eq(time.isSleepWindow(1), false, '01:00 不在装死窗');
  eq(time.isSleepWindow(2), true, '02:00 在装死窗（含起点）');
  eq(time.isSleepWindow(5), true, '05:00 在装死窗');
  eq(time.isSleepWindow(6), false, '06:00 不在装死窗（不含终点）');
  eq(time.isSleepWindow(23), false, '23:00 不在装死窗（属深夜文案）');

  const night23 = time.zonedTime(Date.UTC(2026, 10, 3, 15, 0));
  const night00 = time.zonedTime(Date.UTC(2026, 10, 3, 16, 0));
  ok(time.timeBlockText(night23).includes('深夜'), '23:00 → 深夜');
  ok(time.timeBlockText(night00).includes('深夜'), '00:00 → 深夜');
  eq(time.timeBlockText(night00).includes(':00'), true, '时段时间串分钟恒为 00');
  eq(time.timeBlockText(time.zonedTime(Date.UTC(2026, 10, 3, 19, 0))), '', '03:00 装死窗 → 不注入时段文案');
}

/* ============================================================
 * 附加：waiting 期间绝不重复发送 + 重入锁
 * ============================================================ */
{
  let sendCount = 0;
  const mkDeps = (gid, onSend) => ({
    heartbeat: {
      config: cfg, root,
      listGroups: () => [gid],
      readMessages: () => [],
      evaluate: ({ now, date }) => {
        const s = state.readHeartbeat(gid, root, silent);
        const v = heartbeat.evaluateTick({ state: s, now, date, heartbeat: cfg.heartbeat_config, lastNonBotMessageAt: now - 1000 });
        return { next: v.state, changed: v.changed, shouldSend: v.shouldSend, skipReason: v.skipReason };
      },
      generate: async () => ({ text: '在吗' }),
      send: async () => { onSend(); return true; },
      now: () => NOW,
    },
    extraction: { config: cfg, root, listGroups: () => [], readMessages: () => [], extract: async () => ({ accepted: 0 }), now: () => NOW },
  });

  const sched = schedulerMod.createScheduler(mkDeps('DUP', () => { sendCount += 1; }));
  await sched.tickHeartbeatOnce();
  eq(sendCount, 1, '第一轮发送 1 条');
  for (let i = 0; i < 5; i += 1) await sched.tickHeartbeatOnce();
  eq(sendCount, 1, 'waiting 期内连续 5 轮 tick → 不重复发送（共 1 条）');
  const hb = JSON.parse(readFileSync(paths.heartbeatPath('DUP', root), 'utf8'));
  eq(hb.state, 'waiting', '状态保持 waiting');
  eq(hb.dailyCount, 1, 'dailyCount 仍是 1');

  let concurrent = 0;
  const sched2 = schedulerMod.createScheduler(mkDeps('DUP2', () => { concurrent += 1; }));
  await Promise.all([sched2.tickHeartbeatOnce(), sched2.tickHeartbeatOnce(), sched2.tickHeartbeatOnce()]);
  eq(concurrent, 1, '并发 3 次 tick → 只有 1 条被发送（重入锁生效）');
}

/* ============================================================
 * 附加：熔断预算计入段间分隔符
 * ============================================================ */
{
  const a = fuse.fuse({ profile: 'a'.repeat(400), overlay: 'b'.repeat(400), relationship: '', contest: '', others: [], timeState: '[时间]' });
  const rawSum = fuse.charLen(a.text.replace(/\n\n/g, ''));
  eq(a.used, rawSum + 2 * 2, 'P2-5：used = 正文码点数 + 段间分隔符（2 段边界 * 2 字符）');
  ok(a.used <= fuse.FUSE_BUDGET, 'used 与 FUSE_BUDGET 同口径');
}


/* ============================================================
 * 根因（2026-11-03 追加）：qqbotDataRoot 配错 → R4 群列表为空 → 全链路空转
 *
 * 这是本轮最关键的发现：配置默认值 `~/.dsh-qqbot` 在本机不存在，
 * 而真实数据根在 `qqbot-settings` 的 dataRoot 里。
 * 宿主现在会自动解析真实根（src/index.ts 的 resolvedQqbotRoot）。
 * 这里做**行为级**断言：错误根 → 0 群；真实根 → 有群（证明解析必须做）。
 * ============================================================ */
{
  const os = await import('node:os');
  const badRoot = os.homedir() + '/.dsh-qqbot-NOT-EXIST';
  eq(sample.listHistorySessions(badRoot, silent).length, 0, '不存在的根 → 0 个会话（这就是旧实现的空转状态）');

  // 构造一个「像真实数据根」的目录（isolated），证明解析后能看到群
  const qroot2 = join(root, 'qq-real');
  mkdirSync(join(qroot2, '.qqbot', 'msg-history', 'group_REALGROUP'), { recursive: true });
  writeFileSync(join(qroot2, '.qqbot', 'msg-history', 'group_REALGROUP', '2026-11-03.jsonl'),
    JSON.stringify({ s: UID, n: 'x', t: NOW, k: 'text', x: 'hi' }));
  const sessions = sample.listHistorySessions(qroot2, silent);
  eq(sessions.length, 1, '正确的根 → 能看到 1 个群（证明「解析真实根」这一步是必要的）');
  eq(sessions[0].scope, 'group', '会话类型正确');
  eq(sessions[0].peerId, 'REALGROUP', '群号正确');

  // R4 用错误根 → diagnostics.groups 必须是 0（复现旧 bug 的症状）
  const rtBad = r4mod.createR4Runtime({
    qqbotDataRoot: badRoot, logger: silent, listGroups: () => [], sendToGroup: async () => true, complete: async () => 'x',
  }, join(root, 'bad-root-data'), { persona: 'elysia' });
  eq(rtBad.diagnostics().groups, 0, '错误根 + 空 listGroups → 群数 0（旧 bug 的可见症状）');
  rtBad.stop();

  // R4 用正确根 → 群数 > 0
  const rtGood = r4mod.createR4Runtime({
    qqbotDataRoot: qroot2, logger: silent,
    listGroups: () => ['REALGROUP'], sendToGroup: async () => true, complete: async () => 'x',
  }, join(root, 'good-root-data'), { persona: 'elysia' });
  eq(rtGood.diagnostics().groups, 1, '正确根 → 群数 1（修复目标）');
  rtGood.stop();
}


/* ============================================================
 * 2026-11-04 追加：r4SenderOf 必须按扩展包真实键 `group:<peerId>` 查
 *
 * 根因：扩展包 inbound/zz-current-sender.mjs 写入的 Map 键是
 * `${scope}:${peerId}`（如 group:FADE0002…），**不是 sessionId**。
 * 11-03 那版改成「按 sessionId 精确匹配」→ 永远查不到 → uid 为空 →
 * handleIncomingMessage 整条被跳过 → lastNonBotMessageAt 恒 0、关系从不计分。
 * ============================================================ */
{
  const KEY = Symbol.for('qqbot.current-sender');
  const GID_A = 'FADE0001FADE0001FADE0001FADE0001';
  const GID_B = 'FADE0011FADE0011FADE0011FADE0011';
  const UID_A = 'FADE0021FADE0021FADE0021FADE0021';
  const UID_B = 'FADE0004FADE0004FADE0004FADE0004';

  // 复刻修复后的查找逻辑（与 src/index.ts r4SenderOf 行为一致）
  const senderOf = (sid, gid, store) => {
    // 与生产代码一致：过期记录一律不采用（扩展包 TTL 15 分钟）
    const isFresh = (e) => {
      const ts = Number(e?.ts ?? 0);
      if (!ts) return true;
      return Date.now() - ts <= 15 * 60 * 1000;
    };
    const senderIn = (e) => {
      if (!e) return '';
      if (typeof e === 'string') return e;
      if (typeof e === 'object' && e.senderId && isFresh(e)) return String(e.senderId);
      return '';
    };
    if (gid) { const hit = senderIn(store.get(`group:${gid}`)); if (hit) return hit; }
    if (sid) { const hit = senderIn(store.get(sid)); if (hit) return hit; }
    const now = Date.now();
    let best = '', bestTs = -1;
    for (const [key, entry] of store) {
      if (!entry || typeof entry !== 'object') continue;
      const ts = Number(entry.ts ?? 0);
      if (ts > 0 && now - ts > 15 * 60 * 1000) continue;
      const peer = String(entry.peerId ?? '');
      const peerMatch = Boolean(gid) && (peer === gid || String(key) === `group:${gid}`);
      const sidMatch = Boolean(sid) && String(entry.sessionId ?? entry.sid ?? '') === sid;
      if (!peerMatch && !sidMatch) continue;
      const c = String(entry.senderId ?? '');
      if (c && ts >= bestTs) { best = c; bestTs = ts; }
    }
    return best;
  };

  const store = new Map();
  store.set(`group:${GID_A}`, { scope: 'group', peerId: GID_A, senderId: UID_A, ts: Date.now() });

  eq(senderOf('some-session', GID_A, store), UID_A, 'R4 用 group:<peerId> 能查到发送者（修复目标）');
  eq(senderOf('some-session', '', store), '', '仅按 sessionId 查不到（复现旧 bug 的症状）');

  // 多群隔离：不能把别的群的人算到自己头上
  store.set(`group:${GID_B}`, { scope: 'group', peerId: GID_B, senderId: UID_B, ts: Date.now() });
  eq(senderOf('', GID_A, store), UID_A, '多群并存时 A 群仍返回 A 群的人（不串号）');
  eq(senderOf('', GID_B, store), UID_B, '多群并存时 B 群返回 B 群的人');

  // 过期记录不采用（扩展包 TTL 15 分钟）
  const stale = new Map();
  stale.set(`group:${GID_A}`, { peerId: GID_A, senderId: UID_A, ts: Date.now() - 20 * 60 * 1000 });
  eq(senderOf('', GID_A, stale), '', '超 15 分钟的过期记录不被采用');
}


/* ============================================================
 * 2026-11-04 追加：心跳发送通道（ext-outbound）的 sender/target 契约
 *
 * 根因：QQBot 的 sendViaOutboundChannel 要求 sender 与 target 同时存在：
 *   const sender = opts.sender ?? lastCtx?.sender ?? null;
 *   if (!sender || !target) return false;
 * 只传 target 时 sender 只能从 lastCtx（最近一次出站）里"借"——
 * 重启后若群里一条消息都没发生过就触发心跳 → lastCtx=null → 必然失败。
 * 现在显式从 ob.last() 取 sender，并做同群/跨群的 target 选择。
 * ============================================================ */
{
  const KEY = Symbol.for('im-qqbot.outbound');
  const G = 'FADE0001FADE0001FADE0001FADE0001';
  const G2 = 'FADE0011FADE0011FADE0011FADE0011';

  /** 复刻 src/index.ts sendToGroupViaBridge 的 outbound 分支 */
  const sendViaOutbound = async (body, groupId, api) => {
    if (!api || typeof api.send !== 'function') return { ok: false, via: '' };
    let lastCtx = null;
    try { lastCtx = typeof api.last === 'function' ? api.last() : null; } catch { lastCtx = null; }
    const lastTarget = lastCtx?.target && typeof lastCtx.target === 'object' ? lastCtx.target : null;
    const sameGroup = lastTarget
      && String(lastTarget.scope ?? '') === 'group'
      && String(lastTarget.targetId ?? lastTarget.peerId ?? '') === String(groupId);
    const myTarget = sameGroup ? { ...lastTarget } : { scope: 'group', targetId: groupId };
    const sender = lastCtx?.sender && typeof lastCtx.sender === 'object' ? lastCtx.sender : null;
    const attempts = [];
    if (sender) attempts.push({ label: 'sender+target', opts: { target: myTarget, sender } });
    attempts.push({ label: 'target-only', opts: { target: myTarget } });
    for (const a of attempts) {
      const sent = await api.send(body, a.opts);
      if (sent !== false) return { ok: true, via: a.label };
    }
    return { ok: false, via: '' };
  };

  // ① 有出站记录：显式带 sender，且同群复用真实 target
  const seen = [];
  const fakeSender = { sendText: async () => true };
  const api = {
    send: async (t, o) => { seen.push(o); return !!(o?.sender && o?.target); },
    last: () => ({ target: { scope: 'group', targetId: G, msgId: 'm1' }, sender: fakeSender }),
  };
  const r1 = await sendViaOutbound('hi', G, api);
  ok(r1.ok && r1.via === 'sender+target', '心跳发送：有 lastCtx 时第一次尝试即成功');
  eq(seen[0]?.sender, fakeSender, '心跳发送：**显式**传入了 sender（不再依赖隐式回落）');
  eq(seen[0]?.target?.targetId, G, '心跳发送：同群复用真实 target');
  eq(seen[0]?.target?.msgId, 'm1', '心跳发送：同群保留 msgId（走被动发送，不耗主动配额）');

  // ② 跨群：不复用别群 target，避免发错会话
  const seen2 = [];
  const api2 = {
    send: async (t, o) => { seen2.push(o); return !!(o?.sender && o?.target); },
    last: () => ({ target: { scope: 'group', targetId: G2, msgId: 'm9' }, sender: fakeSender }),
  };
  const r2 = await sendViaOutbound('hi', G, api2);
  ok(r2.ok, '心跳发送：跨群也能发（sender 是账号级）');
  eq(seen2[0]?.target?.targetId, G, '心跳发送：跨群时按目标群重新构造 target');
  eq(seen2[0]?.target?.msgId, undefined, '心跳发送：不携带别群 msgId（防发错会话）');
  eq(seen2[0]?.sender, fakeSender, '心跳发送：跨群仍带 sender');

  // ③ 重启后无出站记录（旧实现会静默失败的场景）：至少要尝试且如实失败
  const seen3 = [];
  const api3 = {
    send: async (t, o) => { seen3.push(o); return !!(o?.sender && o?.target); },
    last: () => null,
  };
  const r3 = await sendViaOutbound('hi', G, api3);
  eq(r3.ok, false, '心跳发送：无 lastCtx 且无 sender → 如实返回失败（不谎报成功）');
  ok(seen3.length >= 1, '心跳发送：失败前确实尝试过');
  eq(seen3[0]?.target?.targetId, G, '心跳发送：无 lastCtx 时仍按群构造 target');

  // ④ outbound API 缺失 → 不抛、返回失败
  const r4 = await sendViaOutbound('hi', G, undefined);
  eq(r4.ok, false, '心跳发送：outbound API 缺失 → 返回失败不抛');
}



/* ============================================================
 * 2026-11-04 追加：waiting 窗口可配置（heartbeat_config.waiting_minutes）
 *
 * 背景：inteval_minutes 可配但 waiting 窗口曾硬编码 15 分钟 →
 *   把 interval 调成 5 分钟完全不生效（每轮仍要等满 15 分钟 waiting 才推进）。
 * 现在 waiting 取配置，**不配时仍回落 15**（保证与原行为一致）。
 * ============================================================ */
{
  const base = { date:'2026-11-04', dailyCount:0, lastNonBotMessageAt:NOW-1000, lastBotMessageAt:0,
                 state:'normal', cold:false, coldSetAt:0, waitingUntil:0, cooldownUntil:0 };

  // ① 不配 waiting_minutes → 仍为 15 分钟（原行为不变）
  eq(resolveWaitingMinutes(cfg.heartbeat_config), 15, '未配置 waiting_minutes → 回落 15 分钟（图纸默认）');
  const v0 = evaluateTick({ state:base, now:NOW, date:'2026-11-04', heartbeat:cfg.heartbeat_config, lastNonBotMessageAt:NOW-1000 });
  eq(v0.state.waitingUntil, NOW + 15 * MIN, '未配置 → waitingUntil = now+15min');

  // ② 配 waiting_minutes=1 → 生效
  const hbFast = { ...cfg.heartbeat_config, waiting_minutes: 1 };
  eq(resolveWaitingMinutes(hbFast), 1, '配置 waiting_minutes=1 → 解析为 1');
  const v1 = evaluateTick({ state:base, now:NOW, date:'2026-11-04', heartbeat:hbFast, lastNonBotMessageAt:NOW-1000 });
  eq(v1.state.waitingUntil, NOW + 1 * MIN, '配置 1 分钟 → waitingUntil = now+1min');

  // ③ 非法值回落
  eq(resolveWaitingMinutes({ waiting_minutes: 0 }), 15, 'waiting_minutes=0（非法）→ 回落 15');
  eq(resolveWaitingMinutes({ waiting_minutes: -5 }), 15, '负数 → 回落 15');
  eq(resolveWaitingMinutes({ waiting_minutes: 'abc' }), 15, '非数字 → 回落 15');
  eq(resolveWaitingMinutes(undefined), 15, 'undefined → 回落 15');
  eq(resolveWaitingMinutes({ waiting_minutes: 2.7 }), 3, '小数 → 四舍五入到 3');

  // ④ 配置合并能保留 waiting_minutes
  const merged = cfgMod.mergeConfig({ heartbeat_config: { waiting_minutes: 2 } });
  eq(merged.config.heartbeat_config.waiting_minutes, 2, 'mergeConfig 保留 waiting_minutes');
  const merged2 = cfgMod.mergeConfig({});
  eq(merged2.config.heartbeat_config.waiting_minutes, undefined, '未配时 mergeConfig 不写入该字段（保持 undefined）');
}


/* ============================================================
 * 2026-11-04 追加：双入站分离 —— 全量群台账（R4 专用）优先于 msg-history
 *
 * 背景：QQBot 的 msg-history 只记「走到 handleInbound 的消息」，
 *   而 debounce 会把「没 @她/没叫名字」的群消息攒窗不派发
 *   （gateway/debounce.js:364）→ 这些消息永不入台账
 *   → R4 死群判定读到空 → 误判死群 → 跳过心跳（实测 6 群里 5 个从不发）。
 *
 * 方案：扩展包 inbound/r4-full-history.mjs 挂在 debounce **之前**的 onInbound 扩展点，
 *   把所有群消息写进 {PERSONA_DATA_ROOT}/state/r4-group-history/<gid>/<date>.jsonl；
 *   R4 sample.ts 优先读它，缺失时回落 msg-history（旧行为不变）。
 * ============================================================ */
{
  const tmp = mkdtempSync(join(process.cwd(), '.dual-reg-'));
  const DATA = join(tmp, 'persona');
  const QQ = join(tmp, 'qq');
  const GID = 'FADE0001FADE0001FADE0001FADE0001';
  const now = Date.now();
  const day = sample.dayKeyOf(now);

  try {
    // ① 只有 msg-history → 旧行为
    const qdir = join(QQ, '.qqbot', 'msg-history', 'group_' + GID);
    mkdirSync(qdir, { recursive: true });
    writeFileSync(join(qdir, day + '.jsonl'),
      JSON.stringify({ s: UID, n: '甲', t: now - 60000, k: 'text', x: '@她 你好' }) + '\n');
    const r1 = sample.readRecentMessages('group', GID, { qqbotDataRoot: QQ, root: DATA, now, withinMs: 30 * 60 * 1000 });
    eq(r1.length, 1, '双台账：仅有 msg-history 时回落旧行为（1 条）');

    // ② 全量台账含「没 @」的闲聊 → 优先读它
    const fdir = join(DATA, 'state', 'r4-group-history', GID);
    mkdirSync(fdir, { recursive: true });
    const rows = [
      { t: now - 120000, s: 'U1', n: '甲', x: '哈哈哈', k: 'text', me: false, v: 1 },
      { t: now - 90000, s: 'U2', n: '乙', x: '今天吃啥', k: 'text', me: false, v: 1 },
      { t: now - 60000, s: UID, n: '甲', x: '@她 你好', k: 'text', me: false, v: 1 },
    ].map((o) => JSON.stringify(o)).join('\n') + '\n';
    writeFileSync(join(fdir, day + '.jsonl'), rows);
    const r2 = sample.readRecentMessages('group', GID, { qqbotDataRoot: QQ, root: DATA, now, withinMs: 30 * 60 * 1000 });
    eq(r2.length, 3, '双台账：全量台账优先，读到 3 条');
    ok(r2.some((m) => m.text === '哈哈哈'), '双台账：能读到没 @ 她的群闲聊（本方案的核心目标）');
    ok(r2.every((m, i) => i === 0 || m.at >= r2[i - 1].at), '双台账：返回正序');

    // ③ 不传 root → 回落旧行为（保证向后兼容）
    const r3 = sample.readRecentMessages('group', GID, { qqbotDataRoot: QQ, now, withinMs: 30 * 60 * 1000 });
    eq(r3.length, 1, '双台账：不传 root 时只读 msg-history（向后兼容）');

    // ④ 全量台账存在但窗口内为空 → 返回空（说明已接管，不再回看旧台账）
    writeFileSync(join(fdir, day + '.jsonl'),
      JSON.stringify({ t: now - 3600000, s: 'U', x: '很久以前', k: 'text', me: false, v: 1 }) + '\n');
    const r4 = sample.readRecentMessages('group', GID, { qqbotDataRoot: QQ, root: DATA, now, withinMs: 30 * 60 * 1000 });
    eq(r4.length, 0, '双台账：全量台账在但窗口空 → 返回空（不回看旧台账）');

    // ⑤ 私聊不走全量台账
    const r5 = sample.readRecentMessages('c2c', UID, { qqbotDataRoot: QQ, root: DATA, now, withinMs: 30 * 60 * 1000 });
    eq(r5.length, 0, '双台账：c2c 不使用全量台账（避免私聊混入）');
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}



/* ============================================================
 * 2026-11-04 追加：心跳白名单（heartbeat_config.enabled_groups）
 *
 * 动机：QQ 主动消息权限是按「群 × 用户」开关的（官方错误码 40034105 = 主动消息无权限）。
 *   未开权限的群每轮心跳都会「调模型 → 发送被拒 → 回滚」，模型成本白花且退不回来。
 *   白名单让名单外的群**在调模型之前就跳过**。
 *
 * 语义：不配/空数组 = 全部群参与（向后兼容）；非空 = 只有名单内参与。
 * ============================================================ */
{
  const tmp = mkdtempSync(join(process.cwd(), '.wl-reg-'));
  const CAT = 'FADE0001FADE0001FADE0001FADE0001';
  const OTHER = 'FADE0011FADE0011FADE0011FADE0011';
  try {
    const cfgWl = cfgMod.mergeConfig({}).config;
    cfgWl.heartbeat_config.enabled_groups = [CAT];

    const genCalls = [];
    const mkDeps = (cfg) => ({
      heartbeat: {
        config: cfg, root: tmp,
        listGroups: () => [CAT, OTHER],
        readMessages: () => [],
        evaluate: ({ state, now, date }) => ({
          next: { ...state, date, state: 'waiting', waitingUntil: now + 15 * 60000, lastBotMessageAt: now, dailyCount: state.dailyCount + 1 },
          changed: true, shouldSend: true,
        }),
        generate: async ({ groupId }) => { genCalls.push(groupId); return { text: '测试' }; },
        send: async () => true,
        now: () => Date.now(),
      },
      extraction: { config: cfg, root: tmp, listGroups: () => [], readMessages: () => [], extract: async () => ({ accepted: 0 }), now: () => Date.now() },
    });

    // ① 配了白名单 → 名单外群不调模型
    genCalls.length = 0;
    const r1 = await schedulerMod.createScheduler(mkDeps(cfgWl)).tickHeartbeatOnce();
    const other = r1.find((x) => x.groupId === OTHER);
    ok(other?.skipped === true, '心跳白名单：名单外群被跳过');
    ok(String(other?.reason).includes('白名单'), '心跳白名单：跳过原因明确标注');
    ok(!genCalls.includes(OTHER), '心跳白名单：**名单外群没有调用模型**（核心目标）');
    ok(genCalls.includes(CAT), '心跳白名单：名单内群正常调用模型');
    eq(genCalls.length, 1, '心跳白名单：模型调用次数 = 1（不是 2）');

    // ② 不配白名单 → 全部群参与（向后兼容）
    const cfgNo = cfgMod.mergeConfig({}).config;
    delete cfgNo.heartbeat_config.enabled_groups;
    genCalls.length = 0;
    const r2 = await schedulerMod.createScheduler(mkDeps(cfgNo)).tickHeartbeatOnce();
    eq(r2.length, 2, '心跳白名单：未配置时两个群都处理（向后兼容）');
    eq(genCalls.length, 2, '心跳白名单：未配置时两个群都调模型（旧行为）');

    // ③ 配置合并：空数组不写入字段（= 全部群）
    const mergedEmpty = cfgMod.mergeConfig({ heartbeat_config: { enabled_groups: [] } });
    eq(mergedEmpty.config.heartbeat_config.enabled_groups, undefined,
      '心跳白名单：空数组不写入字段（等价于全部群）');
    // ④ 配置合并：过滤空白项
    const mergedMixed = cfgMod.mergeConfig({ heartbeat_config: { enabled_groups: [CAT, '  ', ''] } });
    deep(mergedMixed.config.heartbeat_config.enabled_groups, [CAT],
      '心跳白名单：过滤空白项，只保留有效群号');
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}


/* ============================================================
 * ★ 2026-11-05 P1 修复：C 条件改用 `state.lastBotMessageAt`
 *
 * 生产症状：扩展包写入全量台账后，`readRecentMessages` 直接返回台账
 * （台账只有入站 `me:false`，**没有 bot 自己的消息**）⇒ `indexOfLastSelf` 恒 -1
 * ⇒ 旧实现 `if (idxLast < 0) return false` 让 C 条件恒 false ⇒
 * 普通接话（"哈哈""真的吗"）永远不算「有人回复」⇒ waiting 到期一律 cooldown+cold。
 * ============================================================ */
{
  const detection = cfg.reply_detection;
  const botAt = NOW - 5 * MIN;
  // 注意：这里**故意没有任何 self 消息**（复刻全量台账的真实形态）。
  const ledger = [
    { senderId: UID, text: '有人吗', at: botAt - 2 * MIN, self: false },
    { senderId: UID, text: '哈哈', at: botAt + 2 * MIN, self: false },
  ];
  eq(replyDetect.indexOfLastSelf(ledger), -1, 'P1-C：前提成立 —— 台账里没有 bot 自己的消息');
  eq(
    replyDetect.hasSomeoneReplied({ state: { lastBotMessageAt: botAt }, messages: ledger, replyDetection: detection, botId: 'BOTID', now: NOW }),
    true,
    'P1-C：messages 里没有 self，靠 state.lastBotMessageAt 也能判定「有人回复」（核心修复）',
  );
  eq(
    replyDetect.hasSomeoneReplied({ state: { lastBotMessageAt: botAt }, messages: ledger, replyDetection: detection, botId: 'BOTID', now: NOW, sinceAt: botAt }),
    true,
    'P1-C：显式 sinceAt 存在时仍然用 state.lastBotMessageAt 定位首条非 bot 消息',
  );
  // 基准之前的老消息不能被当成「首条非 bot 消息」（只判 bot 之后的那条）
  const withOld = [
    { senderId: UID, text: '为什么', at: botAt - 10 * MIN, self: false },
    { senderId: UID, text: '真的吗', at: botAt + MIN, self: false },
  ];
  eq(
    replyDetect.hasSomeoneReplied({ state: { lastBotMessageAt: botAt }, messages: withOld, replyDetection: detection, botId: 'BOTID', now: NOW }),
    true,
    'P1-C：跳过 bot 说话之前的老消息，只判之后的首条',
  );
  // 窗口仍然按 reply_detection.window_minutes 生效（不能因为改基准就放宽）
  eq(
    replyDetect.hasSomeoneReplied({ state: { lastBotMessageAt: botAt }, messages: [
      { senderId: UID, text: '真的吗', at: botAt + 11 * MIN, self: false },
    ], replyDetection: detection, botId: 'BOTID', now: NOW }),
    false,
    'P1-C：超出 window_minutes → 仍不算（窗口语义不变）',
  );
  // 首条不命中时，后面的关键词消息也不算（图纸：只判一次）
  eq(
    replyDetect.hasSomeoneReplied({ state: { lastBotMessageAt: botAt }, messages: [
      { senderId: UID, text: '我去吃饭了', at: botAt + MIN, self: false },
      { senderId: UID, text: '为什么', at: botAt + 2 * MIN, self: false },
    ], replyDetection: detection, botId: 'BOTID', now: NOW }),
    false,
    'P1-C：首条不命中 → 后面的消息也不算（只判首条）',
  );
  // 完全没有「bot 上次说话时间」→ 保守 false（不误判）
  eq(
    replyDetect.hasSomeoneReplied({ state: { lastBotMessageAt: 0 }, messages: ledger, replyDetection: detection, botId: 'BOTID', now: NOW }),
    false,
    'P1-C：state 与 messages 都没有 bot 说话时间 → 保守判 false',
  );
}

/* ============================================================
 * ★ 2026-11-05 P0 修复：F2「记忆表达分级」写入链 + 简化降权
 *
 *  ① 纯函数 `demoteRecentlyMentionedTags`：最近 14 天提过的 tag 移到末尾；
 *  ② 端到端：assemble 注入画像后，`profiles/index.json` 的 `lastMentionedTags`
 *     真的被写入（此前全仓库零调用，9 个用户全为空）。
 * ============================================================ */
{
  // ① 降权纯函数
  const demoted = profileView.demoteRecentlyMentionedTags({
    text: '爱猫、怕冷、常熬夜',
    lastMentionedTags: { 爱猫: { at: NOW - DAY, count: 2 }, 常熬夜: NOW - 20 * DAY },
    now: NOW,
  });
  eq(demoted.text, '怕冷、常熬夜、爱猫', 'F2：14 天内提过的 tag 移到末尾');
  deep(demoted.demoted, ['爱猫'], 'F2：只有最近提过的那个被降权');
  deep(demoted.tags, ['怕冷', '常熬夜', '爱猫'], 'F2：tags 按最终顺序返回（供写回）');
  eq(
    profileView.demoteRecentlyMentionedTags({
      text: '爱猫、怕冷',
      lastMentionedTags: { 爱猫: { at: NOW - DAY }, 怕冷: { at: NOW - 2 * DAY } },
      now: NOW,
    }).text,
    '爱猫、怕冷',
    'F2：全部都是最近提过的 → 顺序不变（不丢记忆）',
  );
  eq(
    profileView.demoteRecentlyMentionedTags({ text: '爱猫、怕冷', lastMentionedTags: undefined, now: NOW }).text,
    '爱猫、怕冷',
    'F2：没有提及数据 → 原样返回',
  );

  // ② 端到端写链
  const f2root = mkdtempSync(join(process.cwd(), '.f2-'));
  try {
    const GID = 'F2GROUP';
    mkdirSync(join(f2root, 'persona-configs'), { recursive: true });
    writeFileSync(join(f2root, 'persona-configs', 'elysia.json'), JSON.stringify({ features_config: { memory_tier: true } }));
    mkdirSync(join(f2root, 'elysia', 'profiles'), { recursive: true });
    writeFileSync(paths.profilePath(UID, f2root), '爱猫、怕冷\n');
    atomic.writeJsonAtomic(paths.profilesIndexPath(f2root), {
      [UID]: { lastMentionedTags: {}, coldStartUntil: 0 },
    });

    const rt = r4mod.createR4Runtime({
      qqbotDataRoot: join(f2root, 'qq'),
      logger: silent,
      now: () => NOW,
      listGroups: () => [GID],
      resolveGroupId: () => GID,
      resolveSenderId: () => UID,
      readOverlay: () => '',
      readHighlights: () => '',
    }, f2root, { persona: 'elysia' });

    const injected = rt.assemble({ agent: { session: { id: 'S' } } });
    ok(injected.includes('[当前画像]') && injected.includes('爱猫'), 'F2：画像段正常注入（前提成立）');
    const idx1 = JSON.parse(readFileSync(paths.profilesIndexPath(f2root), 'utf8'));
    const stat1 = idx1[UID].lastMentionedTags['爱猫'];
    const at1 = typeof stat1 === 'object' ? Number(stat1.at) : Number(stat1);
    eq(at1, NOW, 'F2：assemble 后 lastMentionedTags 真的写入（P0 写链打通，零模型调用）');
    eq(
      Object.keys(idx1[UID].lastMentionedTags).sort().join(','),
      ['怕冷', '爱猫'].sort().join(','),
      'F2：本轮注入的 tag 全部记录到 lastMentionedTags',
    );
    eq(idx1[UID].coldStartUntil, 0, 'F2：写提及不覆盖 coldStartUntil');

    // 同一 tag 再提一次 → count 累加（证明读-改-写不丢更新）
    rt.assemble({ agent: { session: { id: 'S' } } });
    const idx2 = JSON.parse(readFileSync(paths.profilesIndexPath(f2root), 'utf8'));
    eq(idx2[UID].lastMentionedTags['爱猫'].count, 2, 'F2：再次注入 → count 累加到 2');
    rt.stop();
  } finally {
    try { rmSync(f2root, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

console.log('r4-fixes: passed ' + checks + ' checks');
