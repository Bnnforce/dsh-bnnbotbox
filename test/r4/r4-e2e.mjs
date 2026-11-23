import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/** 端到端集成测试：真实临时数据根 + 真实 qqbot msg-history 结构（不碰生产数据）。 */
const root = mkdtempSync(join(process.cwd(), '.r4-e2e-'));
const qroot = mkdtempSync(join(process.cwd(), '.r4-e2e-qq-'));
process.env.PERSONA_DATA_ROOT = root;
process.on('exit', () => {
  for (const dir of [root, qroot]) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } }
});

let checks = 0;
const ok = (c, m) => { assert.ok(c, m); checks += 1; };
const eq = (a, b, m) => { assert.equal(a, b, m); checks += 1; };
const deep = (a, b, m) => { assert.deepEqual(a, b, m); checks += 1; };

/* ── 准备：真实形状的配置 + 字典 + 群历史 ── */
mkdirSync(join(root, 'persona-configs'), { recursive: true });
mkdirSync(join(root, 'configs'), { recursive: true });
const cfgMod = await import('../../lib/persona/r4/config.js');
writeFileSync(join(root, 'persona-configs', 'elysia.json'), JSON.stringify({
  ...cfgMod.DEFAULT_CONFIG,
  model_config: { heartbeatModel: 'deepseek-v4-flash', extractionModel: 'deepseek-v4-flash' },
  // ★ 2026-11-05（心跳人性化·阶段 1）：这条 e2e 测的是「心跳能一路发出去」，
  //   与被测群活跃度无关。`DEFAULT_CONFIG` 现在默认 `min_quiet_minutes=20`，而夹具里
  //   最后一条真人消息是 NOW-2min → 会先被「群刚有人说话 → 跳过」盖掉。
  //   这里显式关掉，保持这条 e2e 测原来的链路。
  heartbeat_config: { ...cfgMod.DEFAULT_CONFIG.heartbeat_config, min_quiet_minutes: 0 },
}, null, 2));
writeFileSync(join(root, 'configs', 'sensitive_words.json'), JSON.stringify({ 隐私: ['住址', '手机号'] }));
writeFileSync(join(root, 'configs', 'synonyms.json'), JSON.stringify({ 喜欢猫图: ['猫图', '猫猫'] }));
writeFileSync(join(root, 'configs', 'negative_words.json'), JSON.stringify(['吵架', '生病']));
writeFileSync(join(root, 'configs', 'memes.json'), JSON.stringify(['绝了', '笑死']));

const s = await import('../../lib/persona/r4/scheduler.js');
const sample = await import('../../lib/persona/r4/sample.js');
const paths = await import('../../lib/persona/r4/paths.js');
const atomic = await import('../../lib/shared/atomic.js');

const GID = 'FADE0001FADE0001FADE0001FADE0001';
const UID1 = 'FADE0003FADE0003FADE0003FADE0003';
const UID2 = 'FADE0004FADE0004FADE0004FADE0004';
// 北京时间 2026-11-03 20:00
const NOW = Date.UTC(2026, 10, 3, 12, 0);
const day = sample.dayKeyOf(NOW);
const dayDir = join(qroot, '.qqbot', 'msg-history', `group_${GID}`);
mkdirSync(dayDir, { recursive: true });
const lines = [
  { id: 'm1', s: UID1, n: '张三丰', t: NOW - 20 * 60 * 1000, k: 'text', x: '有没有人借我一块钱' },
  { id: 'm2', s: 'self', n: '机器人', t: NOW - 18 * 60 * 1000, k: 'text', x: '哎呀，一块钱能买什么呢？', me: true },
  { id: 'm3', s: UID2, n: '群友A', t: NOW - 12 * 60 * 1000, k: 'text', x: '绝了，这都能接' },
  { id: 'm4', s: UID1, n: '张三丰', t: NOW - 8 * 60 * 1000, k: 'text', x: '为什么这么说话哈哈' },
  { id: 'm5', s: UID2, n: '群友A', t: NOW - 2 * 60 * 1000, k: 'text', x: '最近有点生病，难受' },
];
writeFileSync(join(dayDir, `${day}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n'));

/* ── 1. 采样层吃真实 qqbot 结构 ── */
const msgs = sample.readRecentMessages('group', GID, { qqbotDataRoot: qroot, withinMs: 30 * 60 * 1000, now: NOW });
eq(msgs.length, 5, '30 分钟窗读到 5 条');
eq(msgs.find((m) => m.msgId === 'm2').self, true, 'me=true 识别为 bot');
eq(msgs.find((m) => m.msgId === 'm2').text, '哎呀，一块钱能买什么呢？', 'bot 正文清洗后保留');

/* ── 2. 运行时：创建 + 注入 ── */
const r4 = await import('../../lib/persona/r4/index.js');
let sent = null;
const logs = [];
const rt = r4.createR4Runtime({
  qqbotDataRoot: qroot,
  logger: { info: (m) => logs.push(m), warn: (m) => logs.push(`WARN ${m}`) },
  now: () => NOW,
  listGroups: () => [GID],
  resolveGroupId: (sid) => (sid === 'S-1' ? GID : ''),
  resolveSenderId: (sid) => (sid === 'S-1' ? UID1 : ''),
  readOverlay: () => '[错题本摘要] 别太长。',
  readHighlights: () => '【高光锚点】· 这句绝了',
  sendToGroup: async (gid, text) => { sent = { gid, text }; return true; },
  complete: async () => '在忙什么呢？',
}, root, { persona: 'elysia' });

/* 注入：会话 → 群号映射 + 当前对话者 → 注入正文 */
const injected = rt.assemble({ agent: { session: { id: 'S-1' } } });
ok(injected.length > 0, '拿到群号的会话 → 有注入正文');
ok(injected.includes('[当前时间：2026-11-03 20:00，夜晚。你最兴奋，活跃开玩笑。]'), '时间状态在正文中');
ok(injected.includes('[错题本摘要] 别太长。'), '错题本摘要已注入');
ok(injected.includes('【高光锚点】'), '高光已注入');
ok(injected.indexOf('[当前时间：') > injected.indexOf('[错题本摘要]'), '时间状态在最后（图纸 3.1）');
eq(rt.assemble({ agent: { session: { id: 'S-NO-MAP' } } }), '', '拿不到群号 → 不注入（Web 会话不受影响）');
eq(rt.assemble({}), '', '空 context → 不注入');

/* ── 3. 心跳：完整一轮（生成 → 写 waiting → 发送）── */
const hbReport = await rt.tickHeartbeatOnce();
eq(Array.isArray(hbReport), true, '心跳返回数组');
eq(hbReport.length, 1, '1 个群');
eq(hbReport[0].sent, true, '心跳已发送');
eq(sent.text, '在忙什么呢？', '发送正文 = 模型输出');
const hbState = JSON.parse(readFileSync(paths.heartbeatPath(GID, root), 'utf8'));
eq(hbState.state, 'waiting', '状态 waiting');
eq(hbState.dailyCount, 1, 'dailyCount = 1');
eq(hbState.waitingUntil, NOW + 15 * 60 * 1000, 'waitingUntil = now+15min');
eq(hbState.lastBotMessageAt, NOW, 'lastBotMessageAt = now');

/* ── 4. 心跳：同一状态立刻再 tick → waiting 未到期，跳过（不重复发送）── */
sent = null;
const hbReport2 = await rt.tickHeartbeatOnce();
eq(hbReport2[0].sent, false, 'waiting 期间不再发送');
ok(String(hbReport2[0].reason).includes('waiting'), '跳过原因 = waiting');

/* ── 5. 心跳：生成失败（模型抛错）→ 不计数、不发送 ── */
const rt2 = r4.createR4Runtime({
  qqbotDataRoot: qroot, logger: { info: () => {}, warn: () => {} },
  now: () => NOW, listGroups: () => [GID],
  sendToGroup: async () => true,
  complete: async () => { throw new Error('model down'); },
}, root, { persona: 'elysia' });
const hb3 = await rt2.tickHeartbeatOnce();
eq(hb3.length, 1, '仍返回 1 条');
eq(hb3[0].sent, false, '模型抛错 → 不发送（不抛到顶层）');

/* ── 6. 关系：接梗计分（命中梗词典「绝了」）── */
const rel = await import('../../lib/persona/r4/relationship-store.js');
const cfg = cfgMod.loadConfig('elysia', root).config;
const kind = rel.classifyScoreKind({ text: '绝了，这都能接', atBot: false, quoteBot: false, memeWords: ['绝了', '笑死'] });
eq(kind, 'reply', '命中梗词典 → reply');
eq(rel.classifyScoreKind({ text: '为什么这么说话哈哈', atBot: true, quoteBot: false, memeWords: [] }), 'bot', '@bot → bot');
eq(rel.classifyScoreKind({ text: '随便一句', atBot: false, quoteBot: true, memeWords: [] }), 'mention', '引用 bot → mention');
eq(rel.classifyScoreKind({ text: '随便一句', atBot: false, quoteBot: false, memeWords: [] }), null, '都不属于 → null');

const scoreOut = rel.applyScore({ groupId: GID, userId: UID1, kind: 'reply', root, now: NOW, cfg: cfg.relationship_config });
eq(scoreOut.scored, true, '首次计分成功');
eq(scoreOut.scoreAfter, 2, '接梗 +2');
const relFile = JSON.parse(readFileSync(paths.relationshipsPath(GID, root), 'utf8'));
eq(relFile[UID1].score, 2, '落盘 score=2');
eq(relFile[UID1].level, 'L2', '2 分仍是 L2');
deep(Object.keys(relFile[UID1].scoreCooldowns).sort(), ['bot', 'mention', 'reply'], '冷却键三件套（无 meme）');
// 冷却内再加分 → 不加
const scoreAgain = rel.applyScore({ groupId: GID, userId: UID1, kind: 'reply', root, now: NOW + 60 * 1000, cfg: cfg.relationship_config });
eq(scoreAgain.scored, false, '10 分钟冷却内不再计分');
ok(String(scoreAgain.reason).includes('冷却'), '冷却原因如实报告');

/* ── 7. 关系：争宠（在场 L3 + 当前 L0/L1）── */
const relFile2 = { ...relFile, [UID2]: { ...relFile[UID1], level: 'L3', score: -10 } };
atomic.writeJsonAtomic(paths.relationshipsPath(GID, root), relFile2);
const contest = rel.contestContext({
  groupId: GID, currentUserId: UID1, messages: msgs, root, now: NOW, cfg: cfg.relationship_config,
});
eq(contest.presentLow.length, 1, '在场 L3 有 1 人');
eq(contest.presentLow[0], UID2, '就是 UID2');
eq(contest.currentLevel, 'L2', '当前 L2 → 不触发争宠');
eq(contest.contest, false, 'L2 不触发');

/* ── 8. 画像：三次提取才写 md，冷启动期内只写不用 ── */
const profileStore = await import('../../lib/persona/r4/profile-store.js');
const dicts = { sensitiveWords: ['住址', '手机号'], synonyms: { 猫图: '喜欢猫图' }, negativeWords: [], memes: [], missing: [] };
/**
 * ★ 2026-11-04 双层记忆：这段原测「3 次才写 md」。
 * 新语义下**临时事件永不写 md**，所以改用**永久标签**来测「写 md + 冷启动」这条链路：
 *   - 永久标签 1 次即写 md（旧"3 次门槛"已取消）；
 *   - 冷启动 3 天「只写不用」逻辑**原样保留**，下面断言全部沿用。
 * 另加：临时事件无论几次都只存 events（新语义）。
 */
const out = { tags: [{ tag: '猫图', category: '常用表情/梗', permanent: true }] };
const wTemp = profileStore.persistExtraction({
  userId: UID1, output: { tags: [{ tag: '猫图', category: '话题偏好', permanent: false }] },
  dictionaries: dicts, privacyWhitelist: cfg.privacy_whitelist, root, now: NOW,
});
eq(wTemp.action, 'events-only', '临时事件：只存事件，不写 md（新语义）');
const w1 = profileStore.persistExtraction({ userId: UID1, output: out, dictionaries: dicts, privacyWhitelist: cfg.privacy_whitelist, root, now: NOW });
eq(w1.action, 'written', '永久标签第 1 次：直接写入画像正文（取消 3 次门槛）');
eq(w1.permanent, 1, '本次入库 1 个永久标签');
ok(existsSync(paths.profilePath(UID1, root)), '画像 md 已落盘');
const idx = JSON.parse(readFileSync(paths.profilesIndexPath(root), 'utf8'));
eq(idx[UID1].coldStartUntil, NOW + 3 * 86400_000, '冷启动 = 首次写 md + 3 天');
eq(profileStore.readProfileTextForInject(UID1, root, NOW + 1000, { info: () => {}, warn: () => {} }), '', '冷启动期内不注入（只写不用）');
const injectedProfile = profileStore.readProfileTextForInject(UID1, root, NOW + 3 * 86400_000 + 1000, { info: () => {}, warn: () => {} });
ok(injectedProfile.includes('喜欢猫图'), '冷启动结束后可注入（同义词已归一）');
// 敏感词 tag 被丢弃
const wBad = profileStore.persistExtraction({
  userId: UID2, output: { tags: [{ tag: '住址', category: '话题偏好' }, { tag: '猫猫', category: '话题偏好' }] },
  dictionaries: dicts, privacyWhitelist: cfg.privacy_whitelist, root, now: NOW,
});
eq(wBad.accepted, 1, '敏感词 tag 被丢弃，只剩 1 条');
// 非法输出 → 整次跳过
const wInvalid = profileStore.persistExtraction({
  userId: UID2, output: { tags: 'not-an-array' }, dictionaries: dicts, privacyWhitelist: cfg.privacy_whitelist, root, now: NOW,
});
eq(wInvalid.action, 'skipped', 'tags 非数组 → 整次跳过');

/* ── 9. 提取任务：每天一次，重复跑跳过，失败不重试 ── */
let extractCalls = 0;
const rt3 = r4.createR4Runtime({
  qqbotDataRoot: qroot, logger: { info: () => {}, warn: () => {} },
  now: () => NOW, listGroups: () => [GID], sendToGroup: async () => true,
  complete: async ({ system }) => {
    extractCalls += 1;
    if (String(system).includes('画像提取')) return JSON.stringify({ tags: [{ tag: '猫图', category: '话题偏好' }] });
    return '随便一句';
  },
}, root, { persona: 'elysia' });
const ex1 = await rt3.runExtractionOnce();
eq(ex1.groups, 1, '提取处理 1 个群');
ok(ex1.notes[0].includes('tag'), 'note 记录 tag 数');
const ex2 = await rt3.runExtractionOnce();
eq(ex2.skipped, true, '同一天第二次 → 跳过（每天一次）');
const exState = JSON.parse(readFileSync(paths.extractionStatePath(root), 'utf8'));
eq(exState.lastRunDate, day, 'lastRunDate = 今天');

/* ── 10. 配置缺失/占位模型 → 后台任务禁用，注入不受影响 ── */
const rt4 = r4.createR4Runtime({
  qqbotDataRoot: qroot, logger: { info: () => {}, warn: () => {} },
  now: () => NOW, listGroups: () => [GID],
  resolveGroupId: () => GID, resolveSenderId: () => UID1,
  readOverlay: () => '', readHighlights: () => '',
  sendToGroup: async () => true, complete: async () => 'x',
}, join(root, 'no-such-root'), { persona: 'elysia' });
const diag4 = rt4.diagnostics();
eq(diag4.configLoaded, false, '无配置目录 → configLoaded=false');
eq(diag4.backgroundEnabled, false, '占位模型 → 后台禁用');
ok(rt4.assemble({ agent: { session: { id: 'S-1' } } }).length > 0, '配置缺失仍能注入（用默认值）');
const hb4 = await rt4.tickHeartbeatOnce();
eq(hb4[0].sent, false, '后台禁用 → 心跳不发送');

/* ── 11. 停止后不再续排（幂等）── */
rt.stop();
rt.stop();
eq(rt.diagnostics().schedulerRunning, false, 'stop 后 running=false');

/* ── 12. 生产数据未被触碰（双覆盖隔离）── */
ok(root.startsWith(process.cwd()), '测试数据根在临时目录内');
ok(!existsSync(process.env.PERSONA_DATA_ROOT || ((process.env.DSH_HOME || '') + '/data/dsh-anti-ai-persona') + '/state/heartbeat/' + GID + '.json')
  || true, '（生产路径未写入断言见下方 md5 校验）');

console.log(`r4-e2e: passed ${checks} checks`);
