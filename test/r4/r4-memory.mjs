#!/usr/bin/env node
/**
 * 双层记忆（永久标签 / 临时事件）× 记忆法则注入 —— 测试（无 IO，纯函数）。
 * 运行：node test-r4/r4-memory.mjs
 *
 * 覆盖主人需求（2026-11-04）：
 *   §1 数据存储层：永久标签永不淘汰；临时事件 7 天后忽略
 *   §2 提取分流：模型 permanent 字段 + category 硬规则
 *   §3 Prompt 注入：记忆法则文案 + 触发开关
 *   §4 触发条件：有旧账才挂法则，没有不挂
 */
import assert from 'node:assert/strict';

const profile = await import('../../lib/persona/r4/profile.js');
const fuse = await import('../../lib/persona/r4/fuse.js');
const inject = await import('../../lib/persona/r4/inject.js');

const {
  applyExtraction,
  pruneEvents,
  buildProfileText,
  recentTempEventsOf,
  countPermanentTags,
  resolvePermanent,
  isForcedPermanentCategory,
} = profile;
const { MEMORY_RULES, FUSE_BUDGET, fuse: fuseFn, charLen } = fuse;
const { buildInjection } = inject;

const DAY = 86_400_000;
const NOW = 1_760_000_000_000;

const WHITELIST = ['互动风格', '常用表情/梗', '话题偏好', '语气特征', '活跃时段'];
const dictBase = {
  sensitiveWords: [],
  synonyms: {},
  negativeWords: [],
  memes: [],
  missing: [],
};

let checks = 0;
function ok(cond, label) {
  assert.ok(cond, label);
  checks += 1;
}
function eq(actual, expected, label) {
  assert.deepEqual(actual, expected, label);
  checks += 1;
}

function extractOne({ userId = 'u1', output, existing = { events: [] }, now = NOW, ...rest }) {
  return applyExtraction({
    userId,
    output,
    existing,
    dictionaries: dictBase,
    privacyWhitelist: WHITELIST,
    now,
    ...rest,
  });
}

/** 造一条永久标签 */
function permanentItem(tag, category = '互动风格') {
  return { tag, category, permanent: true };
}
/** 造一条临时事件 */
function tempItem(tag, category = '话题偏好') {
  return { tag, category, permanent: false };
}

/* ══════════════ 一、resolvePermanent 与 category 硬规则 ══════════════ */

eq(isForcedPermanentCategory('互动风格'), true, '互动风格 → 强制永久');
eq(isForcedPermanentCategory('常用表情/梗'), true, '常用表情/梗 → 强制永久');
eq(isForcedPermanentCategory('语气特征'), true, '语气特征 → 强制永久');
eq(isForcedPermanentCategory('话题偏好'), false, '话题偏好 → 不强制（听模型的）');
eq(isForcedPermanentCategory('活跃时段'), false, '活跃时段 → 不强制（听模型的）');
eq(isForcedPermanentCategory('不存在的类别'), false, '未知 category → 不强制（向后兼容）');

// category 硬规则「高于」模型判断：模型说 false，硬规则仍给 true
eq(resolvePermanent('互动风格', false), true, '硬规则覆盖模型 false → 永久');
eq(resolvePermanent('语气特征', undefined), true, '硬规则覆盖模型缺省 → 永久');
// 非强制类别听模型的
eq(resolvePermanent('话题偏好', true), true, '话题偏好 + 模型 true → 永久');
eq(resolvePermanent('话题偏好', false), false, '话题偏好 + 模型 false → 临时');
// 模型给非布尔值 → 保守按 false
eq(resolvePermanent('话题偏好', 'true'), false, '模型给字符串 "true" → 保守按临时');
eq(resolvePermanent('话题偏好', 1), false, '模型给数字 1 → 保守按临时');
eq(resolvePermanent('话题偏好', undefined), false, '模型漏给 permanent → 保守按临时');

/* ══════════════ 二、applyExtraction 分流 ══════════════ */

{
  const r = extractOne({
    output: { tags: [permanentItem('怕黑'), tempItem('今晚吃火锅')] },
  });
  eq(r.accepted.length, 2, '两条都被接受');
  eq(r.accepted[0].permanent, true, '永久标签 accepted.permanent=true');
  eq(r.accepted[1].permanent, false, '临时事件 accepted.permanent=false');
  const ev = r.events.events;
  const p = ev.find((e) => e.tag === '怕黑');
  const t = ev.find((e) => e.tag === '今晚吃火锅');
  eq(p.permanent, true, 'events 里永久标签永久标记');
  eq(t.permanent, false, 'events 里临时事件临时标记');
}

// category 硬规则在 applyExtraction 里也生效（模型误标 false 被纠正）
{
  const r = extractOne({ output: { tags: [{ tag: '爱说叠词', category: '语气特征', permanent: false }] } });
  eq(r.accepted[0].permanent, true, '模型把「语气特征」标 false → 代码纠正为永久');
}

// 「只升格不降格」：已永久的不因后续 false 被打回
{
  const first = extractOne({ output: { tags: [permanentItem('怕黑')] } });
  const second = extractOne({
    existing: first.events,
    output: { tags: [{ tag: '怕黑', category: '话题偏好', permanent: false }] },
    now: NOW + DAY,
  });
  const ev = second.events.events.find((e) => e.tag === '怕黑');
  eq(ev.permanent, true, '已永久 → 后续模型误标 false 不降格');
}

/* ══════════════ 三、pruneEvents：永久永不淘汰 ══════════════ */

{
  // 永久标签的时间戳全部超过 7 天
  const events = {
    events: [
      { tag: '怕黑', category: '互动风格', timestamps: [NOW - 30 * DAY], permanent: true },
      { tag: '上周去爬山', category: '话题偏好', timestamps: [NOW - 30 * DAY], permanent: false },
    ],
  };
  const pruned = pruneEvents({ events, now: NOW, retentionDays: 7 });
  eq(pruned.events.length, 1, '临时事件超 7 天被删');
  eq(pruned.events[0].tag, '怕黑', '永久标签 30 天前仍保留');
  eq(pruned.events[0].permanent, true, '保留的永久标记不丢');
}

{
  // 混合：临时的过期被删，永久的即使没时间戳也留
  const events = {
    events: [
      { tag: '怕黑', category: '互动风格', timestamps: [], permanent: true },
      { tag: '临时甲', category: '话题偏好', timestamps: [NOW - 1 * DAY], permanent: false },
    ],
  };
  const pruned = pruneEvents({ events, now: NOW, retentionDays: 7 });
  eq(pruned.events.length, 2, '永久(空时间戳) + 临时(未过期) 都留');
}

// 永久标签上限：超出按最久未提及淘汰
{
  const many = [];
  for (let i = 0; i < 15; i += 1) {
    many.push({ tag: `永久${i}`, category: '互动风格', timestamps: [NOW - i * DAY], permanent: true });
  }
  const pruned = pruneEvents({
    events: { events: many },
    now: NOW,
    retentionDays: 7,
    maxPermanentPerUser: 12,
  });
  eq(pruned.events.filter((e) => e.permanent === true).length, 12, '永久标签超上限裁到 12');
  // 最久未提及的（永久14，NOW-14DAY）应被淘汰，最新的前 12 个保留
  eq(pruned.events.some((e) => e.tag === '永久0'), true, '最新提及的永久0 保留');
  eq(pruned.events.some((e) => e.tag === '永久14'), false, '最久未提及的永久14 被淘汰');
}

/* ══════════════ 四、buildProfileText：永久进正文、临时不进 ══════════════ */

{
  // 永久标签只出现 1 次 → 也进正文（取消 ≥3 门槛）
  const r = buildProfileText({
    events: { events: [{ tag: '怕黑', category: '互动风格', timestamps: [NOW], permanent: true }] },
    now: NOW,
  });
  eq(r.text, '怕黑', '永久标签出现 1 次 → 进正文（取消 ≥3 门槛）');
  eq(r.usedTags, ['怕黑'], 'usedTags 命中');
}

{
  // 临时事件出现 10 次 → 也不进正文
  const r = buildProfileText({
    events: { events: [{ tag: '今晚吃火锅', category: '话题偏好', timestamps: Array(10).fill(NOW), permanent: false }] },
    now: NOW,
  });
  eq(r.text, '', '临时事件出现 10 次 → 仍不进正文');
  eq(r.usedTags, [], '临时事件不进 usedTags');
}

{
  // 永久标签超过 7 天仍进正文（不受窗口限制）
  const r = buildProfileText({
    events: { events: [{ tag: '怕黑', category: '互动风格', timestamps: [NOW - 30 * DAY], permanent: true }] },
    now: NOW,
  });
  eq(r.text, '怕黑', '永久标签 30 天前 → 仍进正文（不受 7 天窗口限制）');
}

{
  // 混合场景：只取永久
  const r = buildProfileText({
    events: {
      events: [
        { tag: '怕黑', category: '互动风格', timestamps: [NOW], permanent: true },
        { tag: '爱用猫图', category: '常用表情/梗', timestamps: [NOW], permanent: true },
        { tag: '今晚吃火锅', category: '话题偏好', timestamps: [NOW], permanent: false },
      ],
    },
    now: NOW,
  });
  ok(!r.text.includes('今晚吃火锅'), '正文不含临时事件');
  ok(r.text.includes('怕黑'), '正文含永久 怕黑');
  ok(r.text.includes('爱用猫图'), '正文含永久 爱用猫图');
}

// 老数据向后兼容：没有 permanent 字段 → 按临时处理
{
  const r = buildProfileText({
    events: { events: [{ tag: '老数据', category: '话题偏好', timestamps: Array(5).fill(NOW) }] },
    now: NOW,
  });
  eq(r.text, '', '老数据缺 permanent → 按临时，不进正文');
}

/* ══════════════ 五、recentTempEventsOf：琐事摘要 ══════════════ */

{
  const events = {
    events: [
      { tag: '怕黑', category: '互动风格', timestamps: [NOW], permanent: true },
      { tag: '加班', category: '话题偏好', timestamps: [NOW - 1 * DAY], permanent: false },
      { tag: '考试', category: '话题偏好', timestamps: [NOW], permanent: false },
      { tag: '旧事', category: '话题偏好', timestamps: [NOW - 30 * DAY], permanent: false },
    ],
  };
  const tags = recentTempEventsOf({ events, now: NOW, days: 7, limit: 5 });
  eq(tags.includes('怕黑'), false, '永久标签不进琐事摘要');
  eq(tags.includes('旧事'), false, '超 7 天的临时事件不出现');
  eq(tags[0], '考试', '最近提及的排最前');
  ok(tags.includes('加班'), '7 天内临时事件入选');
  eq(tags.length, 2, '共 2 条临时事件');
}

// limit 生效
{
  const events = { events: Array.from({ length: 8 }, (_, i) => ({ tag: `琐事${i}`, category: '话题偏好', timestamps: [NOW - i * 60000], permanent: false })) };
  const tags = recentTempEventsOf({ events, now: NOW, days: 7, limit: 5 });
  eq(tags.length, 5, 'limit=5 生效');
  eq(tags[0], '琐事0', '最新的在首位');
}

// limit=0 → 空
eq(recentTempEventsOf({ events: { events: [{ tag: 'x', category: '话题偏好', timestamps: [NOW], permanent: false }] }, now: NOW, limit: 0 }).length, 0, 'limit=0 → 空数组');

// countPermanentTags
eq(countPermanentTags({ events: [
  { tag: 'a', category: '互动风格', timestamps: [], permanent: true },
  { tag: 'b', category: '话题偏好', timestamps: [], permanent: false },
  { tag: 'c', category: '互动风格', timestamps: [] },
] }), 1, 'countPermanentTags 只数 permanent=true');

/* ══════════════ 六、记忆法则文案 ══════════════ */

ok(MEMORY_RULES.includes('【爱莉希雅的记忆法则（绝对遵守）】'), '记忆法则标题逐字');
ok(MEMORY_RULES.includes('绝不忘记人'), '法则 1 在');
ok(MEMORY_RULES.includes('模糊感'), '法则 2 的「模糊感」在');

/* ── ★ 2026-11-04 最终定稿：删除「张冠李戴」玩法，只留「分清谁说的」 ──
 *
 * 背景：20:12 群里实测「又把人记串了」——主人在 20:02 说「我快没钱了」，
 *       20:12 另一个群友发段位图，她把主人的话安到了那位群友头上。
 *       排查确认那次**不是**「故意张冠李戴」造成的（当时两人临时事件为空、法则未挂载），
 *       是模型看错了说话人归属；但主人最终决定**把这个玩法整个删掉**——
 *       风险明显大于乐趣，且"记得住人"才是这个角色的核心设定。
 */

// ① 「法则 0」保留：这是对真病根的解药
ok(MEMORY_RULES.includes('分清谁说的'), '法则 0「分清谁说的」在（说话人归属优先）');
ok(MEMORY_RULES.includes('A 说过的话安到 B 头上'), '法则 0 明确禁止把 A 的话安到 B 头上');
ok(MEMORY_RULES.includes('不是幽默'), '法则 0 说明这不是幽默（是严重记忆错误）');
ok(MEMORY_RULES.includes('宁可只回应当前这句'), '法则 0 给出保守策略：拿不准就只回当前这句');

// ② ★「张冠李戴」已被彻底删除
ok(!MEMORY_RULES.includes('张冠李戴'), '★「张冠李戴」玩法已彻底删除（不再出现该词）');
ok(!MEMORY_RULES.includes('逗你的啦'), '★「逗你的啦」承认话术已删除');
ok(!MEMORY_RULES.includes('逗他着急'), '★「逗他着急」已删除');
ok(!MEMORY_RULES.includes('20%'), '★「20% 概率」旧文案已删除');
ok(!MEMORY_RULES.includes('无伤大雅的琐事'), '★ 张冠李戴的"琐事"护栏一并删除（玩法没了，护栏也不需要）');

// ③ 新法则 3 改为反向禁令：明确"不许把人安错"
ok(MEMORY_RULES.includes('绝不允许故意把谁的事安到别人头上'), '新法则 3 是「禁止」而非「允许」');
ok(MEMORY_RULES.includes('记忆可以模糊，人不能记错'), '新法则 3 点明口径：记忆可模糊、人不能错');
ok(MEMORY_RULES.includes('这条没有例外'), '新法则 3 声明无例外');

// ④ 长度：删掉一条长规则后变短，开销更小（仍不参与熔断）
ok(charLen(MEMORY_RULES) < 438, '法则比加护栏那版更短（删了张冠李戴）');
ok(charLen(MEMORY_RULES) > 225, '仍比最初版本长（多了「分清谁说的」）');
ok(charLen(MEMORY_RULES) < 320, '法则控制在 320 字符内');

/* ══════════════ 七、fuse：法则不参与熔断 ══════════════ */

{
  // 预算刚好用满数据段 + 法规文本
  const r = fuseFn({
    profile: '怕黑',
    tempEvents: '',
    memoryRules: MEMORY_RULES,
    overlay: '',
    relationship: '',
    contest: '',
    others: [],
    timeState: '',
    highlights: '',
  }, 10); // 极小预算
  // 法则不参与预算 → used 只算 profile(2)
  eq(r.used, 2, '法则不计入 used（不参与熔断）');
  ok(r.text.includes('记忆法则'), '即使预算极小，法则仍在正文里（永不丢）');
  eq(r.fused, false, '法则不触发熔断');
}

{
  // 琐事参与熔断，且是最先被丢的
  const r = fuseFn({
    profile: '怕黑',
    tempEvents: '[最近聊过的琐事]\n加班、考试',
    memoryRules: MEMORY_RULES,
    overlay: '',
    relationship: '',
    contest: '',
    others: [],
    timeState: '',
    highlights: '',
  }, 5);
  eq(r.fused, true, '超预算 → 熔断');
  eq(r.drops.includes('最近琐事'), true, '琐事是最先被丢的段');
  ok(r.text.includes('怕黑'), '画像保留');
  ok(r.text.includes('记忆法则'), '法则保留（永不丢）');
}

// tempEvents 计入预算
{
  const r = fuseFn({
    profile: '', tempEvents: '琐事摘要', memoryRules: '', overlay: '', relationship: '', contest: '',
    others: [], timeState: '', highlights: '',
  }, 1000);
  ok(r.used > 0, 'tempEvents 计入 used');
  eq(r.used, charLen('琐事摘要'), 'tempEvents 计入 used 的字符数');
  eq(r.text, '琐事摘要', 'tempEvents 出现在输出');
}

/* ══════════════ 八、注入层：触发开关 ══════════════ */

function sourcesOf(over = {}) {
  return {
    getProfile: () => '',
    getOverlay: () => '',
    getRelationshipTag: () => '',
    getContestHint: () => '',
    getOtherTags: () => [],
    getHighlights: () => '',
    getTimeState: () => '',
    getTempEvents: () => '',
    ...over,
  };
}

{
  // 没有任何琐事 → 不挂法则（省 token）
  const out = buildInjection({
    groupId: 'g1', userId: 'u1', persona: 'elysia',
    levels: { L0: '高信任', L1: '熟悉', L2: '普通', L3: '低互动' },
    sources: sourcesOf(),
  });
  eq(out.present.memoryRules, false, '无琐事 → 记忆法则不注入');
  eq(out.text.includes('记忆法则'), false, '输出里没有法则');
}

{
  // 有琐事 → 挂法则
  const out = buildInjection({
    groupId: 'g1', userId: 'u1', persona: 'elysia',
    levels: { L0: '高信任', L1: '熟悉', L2: '普通', L3: '低互动' },
    sources: sourcesOf({
      getTempEvents: () => '[最近聊过的琐事]\n加班、考试',
      getProfile: () => '[当前画像]\n怕黑',
    }),
  });
  eq(out.present.memoryRules, true, '有琐事 → 记忆法则注入');
  ok(out.text.includes('记忆法则'), '法则出现在输出');
  ok(out.text.includes('加班'), '琐事摘要出现在输出');
  ok(out.text.includes('怕黑'), '画像出现在输出');
  // 顺序：法则在画像之前
  ok(out.text.indexOf('记忆法则') < out.text.indexOf('怕黑'), '法则在画像之前（规则先于数据）');
}

// safe() 兜底：getTempEvents 抛错 → 不挂法则、不崩
{
  const out = buildInjection({
    groupId: 'g1', userId: 'u1', persona: 'elysia',
    levels: { L0: '高信任', L1: '熟悉', L2: '普通', L3: '低互动' },
    sources: sourcesOf({ getTempEvents: () => { throw new Error('boom'); } }),
  });
  eq(out.present.memoryRules, false, 'getTempEvents 抛错 → 法则不注入（安全降级）');
  eq(typeof out.text, 'string', '不崩，仍返回字符串');
}

// 没有 getTempEvents 回调（老调用方）→ 不挂法则，不崩
{
  const { getTempEvents, ...rest } = sourcesOf();
  const out = buildInjection({
    groupId: 'g1', userId: 'u1', persona: 'elysia',
    levels: { L0: '高信任', L1: '熟悉', L2: '普通', L3: '低互动' },
    sources: rest,
  });
  eq(out.present.memoryRules, false, '无 getTempEvents 回调 → 不挂法则（向后兼容）');
}

console.log(`r4-memory: passed ${checks} checks`);
