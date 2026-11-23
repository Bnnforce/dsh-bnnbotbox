import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = mkdtempSync(join(process.cwd(), '.r4-fuse-test-'));
process.env.PERSONA_DATA_ROOT = root;
process.on('exit', () => { try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ } });

const fuse = await import('../../lib/persona/r4/fuse.js');
const paths = await import('../../lib/persona/r4/paths.js');
const atomic = await import('../../lib/shared/atomic.js');
const config = await import('../../lib/persona/r4/config.js');
const dicts = await import('../../lib/persona/r4/dicts.js');
const state = await import('../../lib/persona/r4/state.js');

let checks = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); checks += 1; };
const eq = (a, b, msg) => { assert.equal(a, b, msg); checks += 1; };
const deep = (a, b, msg) => { assert.deepEqual(a, b, msg); checks += 1; };

/* ── 1. sanitize：非法身份必须拒绝 ── */
eq(paths.sanitizeId('FADE0001FADE0001FADE0001FADE0001'), 'FADE0001FADE0001FADE0001FADE0001', 'sanitize 正常群号不变');
eq(paths.sanitizeId('a/../b'), 'a____b', 'sanitize 把路径字符替换为下划线');
eq(paths.sanitizeId(''), null, 'sanitize 空 → null');
eq(paths.sanitizeId('///'), null, 'sanitize 全非法 → null');
eq(paths.sanitizeId('___'), null, 'sanitize 全下划线 → null');
eq(paths.sanitizeId(undefined), null, 'sanitize undefined → null');

/* ── 2. 路径铁律（0.3）── */
eq(paths.heartbeatPath('GID'), join(root, 'state', 'heartbeat', 'GID.json'), 'heartbeat 路径');
eq(paths.relationshipsPath('GID'), join(root, 'state', 'relationships', 'GID.json'), 'relationships 路径');
eq(paths.profileEventsPath('UID'), join(root, 'state', 'profile-events', 'UID.json'), 'profile-events 路径');
eq(paths.extractionStatePath(), join(root, 'state', 'extraction-state.json'), 'extraction-state 路径');
eq(paths.profilesIndexPath(), join(root, 'elysia', 'profiles', 'index.json'), 'profiles/index 路径');
eq(paths.personaConfigPath('elysia'), join(root, 'persona-configs', 'elysia.json'), '配置路径');

/* ── 3. 原子写：写入后可读回、无残留 tmp ── */
ok(atomic.writeJsonAtomic(join(root, 'probe', 'a.json'), { v: 1 }), '原子写返回 true');
deep(atomic.readJsonSafe(join(root, 'probe', 'a.json')), { v: 1 }, '读回一致');
const leftovers = existsSync(join(root, 'probe')) ? readdirSync(join(root, 'probe')).filter((f) => f.includes('.tmp-')) : [];
eq(leftovers.length, 0, '没有 .tmp 残留');
eq(atomic.readJsonSafe(join(root, 'probe', 'missing.json')), undefined, '缺失文件 → undefined（不抛）');
eq(atomic.readTextSafe(join(root, 'probe', 'missing.txt')), '', '缺失文本 → 空串（不抛）');

/* ── 4. 配置：缺失 → 默认 + warning；占位模型 → 禁用后台 ── */
const cfgMissing = config.loadConfig('elysia', root);
deep(cfgMissing.config.heartbeat_config, config.DEFAULT_CONFIG.heartbeat_config, '配置缺失 → 默认心跳配置');
eq(cfgMissing.loaded, false, '配置缺失 loaded=false');
eq(cfgMissing.backgroundEnabled, false, '模型占位 ... → 后台禁用');
ok(cfgMissing.warnings.length > 0, '配置缺失产生 warning');
ok(cfgMissing.warnings.some((w) => w.includes('禁用后台')), 'warning 提到禁用后台');

/* ── 5. 配置：非法 sleep 窗口只告警、运行值仍是 02:00/06:00 ── */
const cfgBad = config.mergeConfig({
  time_config: { sleep_start: '03:00', sleep_end: '07:00', wake_probability: 0.9 },
});
eq(cfgBad.config.time_config.sleep_start, '02:00', '非法 sleep_start 回退 02:00');
eq(cfgBad.config.time_config.sleep_end, '06:00', '非法 sleep_end 回退 06:00');
eq(cfgBad.config.time_config.wake_probability, 0.9, 'wake_probability 保留合法值');
ok(cfgBad.warnings.some((w) => w.includes('02:00-06:00')), 'sleep 不一致有 warning');

/* ── 6. 配置：wake_probability 钳制与 NaN 兜底 ── */
eq(config.mergeConfig({ time_config: { wake_probability: 1.7 } }).config.time_config.wake_probability, 1, 'wake_probability 钳到 1');
eq(config.mergeConfig({ time_config: { wake_probability: -0.5 } }).config.time_config.wake_probability, 0, 'wake_probability 钳到 0');
const wpNaN = Number('abc');
eq(config.mergeConfig({ time_config: { wake_probability: wpNaN } }).config.time_config.wake_probability, 0.7, 'NaN → 0.7');

/* ── 7. 配置：useLegacyAffinity 必须被强制 false（0.4）── */
eq(config.mergeConfig({ useLegacyAffinity: true }).config.useLegacyAffinity, false, 'useLegacyAffinity 强制 false');
ok(config.mergeConfig({ useLegacyAffinity: true }).warnings.some((w) => w.includes('useLegacyAffinity')), '有 warning');

/* ── 8. 配置：模型 ID 可用性 ── */
eq(config.modelIdUsable('deepseek-v4-flash'), true, '正常模型 ID 可用');
eq(config.modelIdUsable('...'), false, '"..." 占位不可用');
eq(config.modelIdUsable(''), false, '空不可用');
eq(config.modelIdUsable('…'), false, '省略号不可用');
ok(config.loadConfig('elysia', root).warnings.every((w) => typeof w === 'string'), 'warning 全是字符串');

/* ── 9. 配置：练习 run_daily_at 归一 ── */
eq(config.mergeConfig({ extraction_config: { run_daily_at: '3:00' } }).config.extraction_config.run_daily_at, '03:00', '3:00 → 03:00');
eq(config.mergeConfig({ extraction_config: { run_daily_at: '25:00' } }).config.extraction_config.run_daily_at, '03:00', '越界回退 03:00');

/* ── 10. 字典：缺失 → 空且进 missing；分组对象/别名两种写法都能吃 ── */
mkdirSync(join(root, 'configs'), { recursive: true });
writeFileSync(join(root, 'configs', 'negative_words.json'), JSON.stringify(['吵架', '生病', '难过']));
writeFileSync(join(root, 'configs', 'sensitive_words.json'), JSON.stringify({ 隐私: ['地址', '电话'] }));
writeFileSync(join(root, 'configs', 'synonyms.json'), JSON.stringify({ 喜欢猫图: ['猫图', '猫猫'], 打游戏: '开黑' }));
writeFileSync(join(root, 'configs', 'memes.json'), JSON.stringify({ 梗: ['绝了'] }));

const dict = dicts.loadDictionaries(config.DEFAULT_CONFIG, root);
deep(dict.negativeWords, ['吵架', '生病', '难过'], '字符串数组字典');
deep(dict.sensitiveWords, ['地址', '电话'], '分组对象字典扁平化');
eq(dict.synonyms['猫图'], '喜欢猫图', '同义词 alias→canonical');
eq(dict.synonyms['开黑'], '打游戏', '同义词 字符串写法');
deep(dict.memes, ['绝了'], '梗词典');
eq(dict.missing.length, 0, '四个字典都在 → missing 空');
eq(dicts.hitWord('我生病了', dict.negativeWords), '生病', '命中负面词');

/* ── 11. 字典：缺失全部 → missing 4 条 + 空数组（降级不抛）── */
rmSync(join(root, 'configs'), { recursive: true, force: true });
const dictEmpty = dicts.loadDictionaries(config.DEFAULT_CONFIG, root);
deep(dictEmpty.negativeWords, [], '缺失 → 空负面词');
deep(dictEmpty.sensitiveWords, [], '缺失 → 空敏感词');
deep(dictEmpty.synonyms, {}, '缺失 → 空同义词');
deep(dictEmpty.memes, [], '缺失 → 空梗');
eq(dictEmpty.missing.length, 4, 'missing 4 条');
eq(dicts.hitWord('随便一句', []), null, '空词表 → 不命中');

/* ── 12. 状态读：缺失 → 空状态（不抛）── */
const hb0 = state.readHeartbeat('GID', root);
deep(hb0, { ...(await import('../../lib/persona/r4/types.js')).EMPTY_HEARTBEAT_STATE }, '缺失心跳状态 → EMPTY');
eq(state.readRelationships('GID', root, { level: 'L2', score: 0 }).constructor.name, 'Object', '缺失 relationships → 对象');
deep(state.readProfileIndex(root), {}, '缺失 index → 空');
deep(state.readProfileEvents('UID', root), { events: [] }, '缺失 events → 空');
deep(state.readExtractionState(root), { lastRunDate: '' }, '缺失提取状态 → lastRunDate 空');

/* ── 13. 状态写读回环（含 schema 字段齐全）── */
const hbWrite = { date: '2026-11-03', dailyCount: 2, lastNonBotMessageAt: 1, lastBotMessageAt: 2, state: 'waiting', cold: true, coldSetAt: 3, waitingUntil: 4, cooldownUntil: 5 };
ok(state.writeHeartbeat('GID', hbWrite, root), '写心跳成功');
const hbBack = state.readHeartbeat('GID', root);
deep(hbBack, hbWrite, '心跳写读一致（9 字段齐全）');

/* ── 14. 状态读：脏数据被清洗（不抛）── */
const dirtyPath = paths.relationshipsPath('DIRTY', root);
mkdirSync(join(root, 'state', 'relationships'), { recursive: true });
writeFileSync(dirtyPath, JSON.stringify({ u1: { level: 'XX', score: 'abc', scoreCooldowns: { meme: 99 } } }));
const relDirty = state.readRelationships('DIRTY', root, { level: 'L2', score: 0 });
eq(relDirty.u1.level, 'L2', '非法 level → 初始等级');
eq(relDirty.u1.score, 0, '非数字 score → 初始分');
eq(relDirty.u1.scoreCooldowns.reply, 0, '缺 reply 冷却 → 0');
eq('meme' in relDirty.u1.scoreCooldowns, false, '**不存在 meme 键**（统一为 reply/mention/bot）');
deep(Object.keys(relDirty.u1.scoreCooldowns).sort(), ['bot', 'mention', 'reply'], '冷却键恰为三个');

/* ── 15. 熔断：不超预算时按图纸顺序拼装 ── */
const fit = fuse.fuse({
  timeState: '[当前时间：2026-11-03 20:00，夜晚。你最兴奋，活跃开玩笑。]',
  others: [{ userId: 'u9', text: '[u9：普通]' }, { userId: 'u1', text: '[u1：普通]' }],
  contest: fuse.CONTEST_HINT,
  relationship: '[当前关系标签：熟悉]',
  overlay: '[错题本摘要] 别太长。',
  profile: '[当前画像] 喜欢猫图',
  highlights: '[高光] 这句绝了',
});
eq(fit.fused, false, '未超预算不熔断');
// used 口径 = 参与熔断的六段字符数之和 + 段间分隔符（`\n\n`）
// **不含高光**，按码点计。（2026-11-03 修复 P2-5：分隔符必须计入预算口径）
const usedSections = [
  '[当前画像] 喜欢猫图',
  '[错题本摘要] 别太长。',
  '[当前关系标签：熟悉]',
  fuse.CONTEST_HINT,
  '[u1：普通]\n[u9：普通]',
  '[当前时间：2026-11-03 20:00，夜晚。你最兴奋，活跃开玩笑。]',
];
const usedExpect = usedSections.reduce((n, s) => n + [...s].length, 0) + (usedSections.length - 1) * 2;
eq(fit.used, usedExpect, 'used = 六段之和 + 段间分隔符（不含高光）');
const order = ['[高光]', '[当前画像]', '[错题本摘要]', '[当前关系标签', '[提示：对低互动对象', '[u1：普通]', '[当前时间'];
let cursor = -1;
for (const needle of order) {
  const at = fit.text.indexOf(needle);
  ok(at > cursor, `注入顺序严格：${needle} 在 ${order.filter((x) => x !== needle).join(' ')} 之后`);
  cursor = at;
}

/* ── 16. 熔断：others 必须按 userId 字典序取前 5 ── */
const many = fuse.sortOtherTags([
  { userId: 'u5', text: '[u5]' }, { userId: 'u1', text: '[u1]' }, { userId: 'u3', text: '[u3]' },
  { userId: 'u9', text: '[u9]' }, { userId: 'u2', text: '[u2]' }, { userId: 'u4', text: '[u4]' },
]);
eq(many.length, 5, '只取前 5');
deep(many.map((m) => m.userId), ['u1', 'u2', 'u3', 'u4', 'u5'], '按字典序取前 5');

/* ── 17. 熔断：从右往左丢（others → contest → relationship → overlay → profile）── */
const filler = (n, tag) => `${tag}${'啊'.repeat(Math.max(0, n - [...tag].length))}`;
// 数据量要足够「逐步丢」四轮：丢掉 others/contest/relationship 之后仍超预算，才轮得到截断 overlay。
const heavy = fuse.fuse({
  profile: filler(500, '[当前画像]'),
  overlay: filler(500, '[错题本摘要]'),
  relationship: filler(80, '[当前关系标签]'),
  contest: fuse.CONTEST_HINT,
  others: [{ userId: 'u1', text: filler(400, '[u1：普通]') }],
  timeState: '[当前时间：2026-11-03 20:00，夜晚。你最兴奋，活跃开玩笑。]',
  highlights: filler(500, '[高光]'),
});
eq(heavy.fused, true, '超预算 → 熔断');
eq(heavy.text.includes('[u1：普通]'), false, '第 1 步：其他在场标签整段丢弃');
eq(heavy.text.includes('[提示：对低互动对象'), false, '第 2 步：争宠提示整段丢弃');
eq(heavy.text.includes('[当前关系标签'), false, '第 3 步：当前关系标签整段丢弃');
eq(heavy.drops.length >= 3, true, '诊断记录至少 3 步丢弃');
eq(heavy.drops[0].includes('其他在场标签'), true, '丢序第 1 = 其他在场标签');
eq(heavy.drops[1].includes('争宠提示'), true, '丢序第 2 = 争宠提示');
eq(heavy.drops[2].includes('当前关系标签'), true, '丢序第 3 = 当前关系标签');
ok(heavy.used <= fuse.FUSE_BUDGET, '熔断后口径 ≤ 1000');
eq(heavy.text.includes('[当前时间'), true, '时间状态永不丢');
eq(heavy.text.includes('[高光]'), true, '高光永不丢（且不计入预算）');
eq(fuse.charLen(fuse.cutChars(filler(500, '[高光]'), 20)), 20, 'cutChars 按码点截断');

/* ── 18. 熔断：时间状态绝不被丢弃（即使只剩它也超预算）── */
const onlyTime = fuse.fuse({
  profile: '', overlay: '', relationship: '', contest: '', others: [],
  timeState: '[当前时间：2026-11-03 20:00，夜晚。你最兴奋，活跃开玩笑。]',
});
eq(onlyTime.text, '[当前时间：2026-11-03 20:00，夜晚。你最兴奋，活跃开玩笑。]', '只剩时间状态时原样输出');
eq(onlyTime.fused, false, '不超预算不熔断');

/* ── 19. 安全标点截断：落在标点之后，不截半个词 ── */
eq(fuse.cutAtSafePunct('第一句。第二句。第三句。', 5), '第一句。', '截到安全标点');
eq(fuse.cutAtSafePunct('没有标点的长句', 3), '没有标', '无标点按字符截');
eq(fuse.cutAtSafePunct('任意文本', 0), '', 'max=0 → 空（图纸允许截到空）');

/* ── 20. 熔断：截断当前画像到安全标点（第 5 步）── */
// 1400 字 + 时间状态 38 → 必超预算，且前面无 others/contest/relationship/overlay 可丢 → 只能截画像
const profileCut = fuse.fuse({
  profile: `[当前画像]${'啊'.repeat(1400)}。后面还有很多字。`,
  overlay: '', relationship: '', contest: '', others: [],
  timeState: '[当前时间：2026-11-03 20:00，夜晚。你最兴奋，活跃开玩笑。]',
});
eq(profileCut.fused, true, '画像超长 → 熔断');
eq(profileCut.text.includes('[当前画像]'), true, '画像被保留（截断后仍有开头）');
ok(profileCut.used <= fuse.FUSE_BUDGET, '截断后 ≤ 1000');
eq(profileCut.text.includes('[当前时间'), true, '时间状态仍在（永不丢）');
eq(profileCut.drops.length, 1, '只发生 1 步（截画像）');
eq(profileCut.drops[0].includes('当前画像'), true, '诊断首条 = 当前画像截断');

/* ── 21. 1000 字符边界：恰好 1000 不熔断、1001 熔断（**含段间分隔符 2 字符**）── */
const TIME_STATE = '[当前时间：2026-11-03 20:00，夜晚。你最兴奋，活跃开玩笑。]';
const ctxLen = fuse.charLen(TIME_STATE);
const SEP_LEN = 2; // 两段之间的 `\n\n`
const exact = fuse.fuse({
  profile: filler(fuse.FUSE_BUDGET - ctxLen - SEP_LEN, '[当前画像]'),
  overlay: '', relationship: '', contest: '', others: [],
  timeState: TIME_STATE,
});
eq(exact.used, fuse.FUSE_BUDGET, '恰好 1000（含分隔符）');
eq(exact.fused, false, '恰好 1000 不熔断');
const over = fuse.fuse({
  profile: filler(fuse.FUSE_BUDGET - ctxLen - SEP_LEN + 1, '[当前画像]'),
  overlay: '', relationship: '', contest: '', others: [],
  timeState: '[当前时间：2026-11-03 20:00，夜晚。你最兴奋，活跃开玩笑。]',
});
eq(over.fused, true, '1001 → 熔断');
ok(over.used <= fuse.FUSE_BUDGET, '熔断后回到预算内');
eq(over.text.includes('[当前时间'), true, '熔断不会丢时间状态');

/* ── 22. 采样层：非 text 类型不读（不读图片），注入块被剥离 ── */
const sample = await import('../../lib/persona/r4/sample.js');
eq(sample.cleanMessageText('★主人 <@4B73331> 你好 【输出纪律】只输出正文'), '你好', '清洗主人标记/@/注入块');
eq(sample.toMessage({ s: 'u1', t: 1, k: 'image', x: '一张图' }), null, '图片消息不读（3.1 不读视觉内容）');
eq(sample.toMessage({ s: 'u1', t: 1, k: 'text', x: '【心情·只读】正文' }), null, '只剩注入块 → null');
const selfMsg = sample.toMessage({ s: 'self', t: 1, k: 'text', x: '我是机器人', me: true });
eq(selfMsg.self, true, 'me=true → self');
eq(selfMsg.text, '我是机器人', '正文保留');

/* ── 23. 采样层：真实目录读最近消息 + 时间窗过滤 ── */
const qroot = join(root, 'qqbot');
mkdirSync(join(qroot, '.qqbot', 'msg-history', 'group_GID'), { recursive: true });
const nowMs = Date.UTC(2026, 10, 3, 12, 0); // 北京时间 20:00
const day = sample.dayKeyOf(nowMs);
const lines = [
  { id: 'm1', s: 'u1', n: '甲', t: nowMs - 25 * 60 * 1000, k: 'text', x: '刚才说的' },
  { id: 'm2', s: 'u2', n: '乙', t: nowMs - 5 * 60 * 1000, k: 'text', x: '最新一句' },
  { id: 'm3', s: 'self', n: '机器人', t: nowMs - 3 * 60 * 1000, k: 'text', x: '我回了一句', me: true },
  { id: 'm4', s: 'u3', n: '丙', t: nowMs - 50 * 60 * 1000, k: 'text', x: '超窗老旧' },
  { id: 'm5', s: 'u1', n: '甲', t: nowMs - 10 * 60 * 1000, k: 'image', x: '图片' },
];
writeFileSync(join(qroot, '.qqbot', 'msg-history', 'group_GID', `${day}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n'));

const recent = sample.readRecentMessages('group', 'GID', { qqbotDataRoot: qroot, withinMs: 30 * 60 * 1000, now: nowMs });
eq(recent.length, 3, '30 分钟窗内恰 3 条（超窗 + 图片被过滤）');
deep(recent.map((m) => m.msgId), ['m1', 'm2', 'm3'], '按时间正序');
eq(recent[1].text, '最新一句', '正文正确');
eq(sample.lastSelfMessageAt(recent), nowMs - 3 * 60 * 1000, 'bot 最后一条时间');
eq(sample.readRecentMessages('group', '../../etc', { qqbotDataRoot: qroot, now: nowMs }).length, 0, '非法 peerId → 空（路径逃逸被拒）');
eq(sample.readRecentMessages('group', 'NOPE', { qqbotDataRoot: qroot, now: nowMs }).length, 0, '无历史目录 → 空（不抛）');
deep(sample.listHistorySessions(qroot), [{ scope: 'group', peerId: 'GID' }], '列出有历史的会话');

/* ── 24. 采样：跨 0 点窗口（读两个日期文件）── */
const now2 = Date.UTC(2026, 10, 3, 16, 20); // 北京时间 00:20（次日）
const dayPrev = sample.dayKeyOf(now2 - 40 * 60 * 1000);
const dayCur = sample.dayKeyOf(now2);
mkdirSync(join(qroot, '.qqbot', 'msg-history', 'group_X'), { recursive: true });
writeFileSync(join(qroot, '.qqbot', 'msg-history', 'group_X', `${dayPrev}.jsonl`), JSON.stringify({ id: 'p1', s: 'u1', t: now2 - 35 * 60 * 1000, k: 'text', x: '跨点前' }));
writeFileSync(join(qroot, '.qqbot', 'msg-history', 'group_X', `${dayCur}.jsonl`), JSON.stringify({ id: 'c1', s: 'u2', t: now2 - 4 * 60 * 1000, k: 'text', x: '跨点后' }));
const cross = sample.readRecentMessages('group', 'X', { qqbotDataRoot: qroot, withinMs: 40 * 60 * 1000, now: now2, maxFiles: 2 });
eq(cross.length, 2, '跨 0 点 40 分钟窗读到 2 条');
eq(cross[0].msgId, 'p1', '跨点前那条在前');

console.log(`r4-fuse: passed ${checks} checks`);
