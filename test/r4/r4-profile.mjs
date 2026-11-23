#!/usr/bin/env node
/**
 * 模块三（人物画像·强防幻觉）测试（无 IO，纯函数）。
 * 运行：node test/r4-profile.mjs
 */
import assert from 'node:assert/strict';

const m = await import('../../lib/persona/r4/profile.js');
const {
  normalizeTag,
  validateExtractedTag,
  applyExtraction,
  pruneEvents,
  countRecent,
  buildProfileText,
  canInjectProfile,
  touchColdStart,
  markTagMentioned,
  staleTagsFor,
} = m;

const DAY = 86_400_000;
const HOUR = 3_600_000;
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
function tagCount(tag, category = '话题偏好') {
  return { tag, category };
}
function extractOne({ userId = 'u1', output, existing, dictionaries = dictBase, now = NOW, privacyWhitelist = WHITELIST, ...rest }) {
  return applyExtraction({
    userId,
    output,
    existing,
    dictionaries,
    privacyWhitelist,
    now,
    ...rest,
  });
}

/* ───── 归一化 ───── */
eq(normalizeTag('ＡＢＣ', {}), 'abc', '全角 ＡＢＣ → abc');
eq(normalizeTag(' 喜欢猫图 ', {}), '喜欢猫图', 'trim 两侧空白');
eq(normalizeTag('猫猫', { 猫猫: '喜欢猫图' }), '喜欢猫图', '同义词命中');
eq(normalizeTag('　喜欢猫图　', {}), '喜欢猫图', '全角空格归一化后 trim');
eq(normalizeTag('ABC', { abc: '喜欢猫图' }), '喜欢猫图', '同义词命中（小写键，归一化后精确命中）');
eq(normalizeTag('abc', { ABC: '喜欢猫图' }), '喜欢猫图', '同义词大小写不敏感回退（键为大写、精确查未命中）');
eq(normalizeTag('猫猫', { MEOW: '猫猫' }), '猫猫', '回退未命中时保留归一化原值');
eq(normalizeTag('   ', {}), '', '纯空白 → 空串');
eq(normalizeTag('忽略的别名', { 忽略的别名: '喜欢猫图' }), '喜欢猫图', '精确查优先');
eq(normalizeTag('AbC', {}), 'abc', '英文小写');

/* ───── 校验 ───── */
eq(validateExtractedTag({ tag: '', category: '话题偏好', privacyWhitelist: WHITELIST, sensitiveWords: [] }), { ok: false, reason: '空 tag' }, '空 tag 拒绝');
eq(validateExtractedTag({ tag: '一二三四五六七八九十一二三四五六七八九十一', category: '话题偏好', privacyWhitelist: WHITELIST, sensitiveWords: [] }), { ok: false, reason: '超长' }, '21 字拒绝');
eq(validateExtractedTag({ tag: '喜欢猫图', category: '医疗隐私', privacyWhitelist: WHITELIST, sensitiveWords: [] }), { ok: false, reason: 'category 不在白名单' }, 'category 非白名单拒绝');
eq(validateExtractedTag({ tag: '涉及毒品的内容', category: '话题偏好', privacyWhitelist: WHITELIST, sensitiveWords: ['毒品'] }), { ok: false, reason: '命中敏感词' }, '命中敏感词拒绝');
eq(validateExtractedTag({ tag: '一二三四五六七八九十一二三四五六七八九十一', category: '话题偏好', privacyWhitelist: WHITELIST, sensitiveWords: [] }).ok, false, '20 字整点属超长边界（21 字）');
eq(validateExtractedTag({ tag: '一二三四五六七八九十一二三四五六七八九十', category: '话题偏好', privacyWhitelist: WHITELIST, sensitiveWords: [] }).ok, true, '恰好 20 字通过');
eq(validateExtractedTag({ tag: '喜欢猫图', category: '话题偏好', privacyWhitelist: WHITELIST, sensitiveWords: [] }).ok, true, '合法 tag 通过');

/* ───── 非法整体输出 ─────
 * ★ 2026-11-04：cloneEventsFile 现在会给每条 event 补 `permanent:false`（字段规范化），
 * 所以「events 原样」不能再做对象深度相等，改为断言**业务内容未变**（tag/category/timestamps 逐条一致）。
 */
function eventsEquivalent(a, b) {
  if (a.events.length !== b.events.length) return false;
  for (let i = 0; i < a.events.length; i += 1) {
    const x = a.events[i];
    const y = b.events[i];
    if (x.tag !== y.tag) return false;
    if (x.category !== y.category) return false;
    if (JSON.stringify(x.timestamps) !== JSON.stringify(y.timestamps)) return false;
    // permanent 允许被补齐为 false（缺省即 false，语义等价）
    if ((x.permanent === true) !== (y.permanent === true)) return false;
  }
  return true;
}
{
  const existing = { events: [{ tag: '喜欢猫图', category: '话题偏好', timestamps: [NOW] }] };
  const asString = extractOne({ output: { tags: '喜欢猫图' }, existing });
  eq(asString.accepted, [], 'tags 是字符串 → accepted 空');
  ok(eventsEquivalent(asString.events, existing), 'tags 是字符串 → events 业务内容原样');
  eq(asString.rejected, [{ tag: '<整体>', reason: 'tags 不是数组' }], 'tags 是字符串 → 整体 rejected');

  const asUndefined = extractOne({ output: undefined, existing });
  eq(asUndefined.accepted, [], 'output undefined → accepted 空');
  ok(eventsEquivalent(asUndefined.events, existing), 'output undefined → events 业务内容原样');
  eq(asUndefined.rejected.length, 1, 'output undefined → 一条整体 rejected');

  const noTagsKey = extractOne({ output: {}, existing });
  eq(noTagsKey.accepted, [], '无 tags 键 → accepted 空');
  ok(eventsEquivalent(noTagsKey.events, existing), '无 tags 键 → events 业务内容原样');
}

/* ───── 单次 6 条上限 ───── */
{
  const output = {
    tags: ['t1', 't2', 't3', 't4', 't5', 't6'].map((tag) => tagCount(tag)),
  };
  const res = extractOne({ output, existing: { events: [] } });
  eq(res.accepted.length, 5, '6 个合法 tag → accepted 恰好 5');
  eq(res.accepted.map((t) => t.tag), ['t1', 't2', 't3', 't4', 't5'], '按模型输出顺序取前 5');
  eq(res.rejected, [{ tag: 't6', reason: '超出单次 5 条上限' }], '第 6 条进 rejected');
}

/* ───── ★ 2026-11-04 双层记忆改写：永久标签取消 ≥3 门槛，临时事件永不进正文 ─────
 * 旧断言（"同一 tag 三次提取 → 进正文" / "两次 <3 次不出现"）现在只对**临时事件**成立；
 * 永久标签出现 1 次就进正文。这里两组都保留，各自断言新语义。
 */

/* ───── 永久标签：1 次即进正文（取消 ≥3 门槛） ───── */
{
  let events = { events: [] };
  const perm = { tag: '喜欢猫图', category: '常用表情/梗', permanent: true };
  events = extractOne({ output: { tags: [perm] }, existing: events, now: NOW }).events;
  eq(events.events.length, 1, '第一次提取新建一条 event');
  eq(events.events[0].timestamps.length, 1, '第一次 timestamps 长度 1');
  eq(events.events[0].permanent, true, '永久标记已落盘');
  const profile = buildProfileText({ events, now: NOW });
  ok(profile.text.includes('喜欢猫图'), '永久标签 1 次 → 进正文（取消 ≥3 门槛）');
  ok(profile.usedTags.includes('喜欢猫图'), '永久标签 1 次 → usedTags 命中');
}

/* ───── 永久标签多次提取：同一条 event 累加时间戳 ───── */
{
  let events = { events: [] };
  const perm = { tag: '喜欢猫图', category: '常用表情/梗', permanent: true };
  events = extractOne({ output: { tags: [perm] }, existing: events, now: NOW }).events;
  events = extractOne({ output: { tags: [perm] }, existing: events, now: NOW + HOUR }).events;
  events = extractOne({ output: { tags: [perm] }, existing: events, now: NOW + 2 * HOUR }).events;
  eq(events.events.length, 1, '三次提取仍是一条 event');
  eq(events.events[0].timestamps.length, 3, '三次提取 timestamps 长度 3');
  const profile = buildProfileText({ events, now: NOW + 2 * HOUR });
  ok(profile.text.includes('喜欢猫图'), '永久标签 → 出现在正文');
}

/* ───── 临时事件：两次提取 → 不进正文 ───── */
{
  let events = { events: [] };
  const temp = { tag: '喜欢猫图', category: '话题偏好', permanent: false };
  events = extractOne({ output: { tags: [temp] }, existing: events, now: NOW }).events;
  events = extractOne({ output: { tags: [temp] }, existing: events, now: NOW + HOUR }).events;
  eq(events.events[0].timestamps.length, 2, '两次提取 timestamps 长度 2');
  const profile = buildProfileText({ events, now: NOW + HOUR });
  ok(!profile.text.includes('喜欢猫图'), '临时事件 2 次 → 仍不进正文');
  eq(profile.usedTags, [], '临时事件 usedTags 为空');
}

/* ───── 临时事件即使 10 次也不进正文 ───── */
{
  let events = { events: [] };
  const temp = { tag: '今晚加班', category: '话题偏好', permanent: false };
  for (let i = 0; i < 10; i += 1) {
    events = extractOne({ output: { tags: [temp] }, existing: events, now: NOW + i * HOUR }).events;
  }
  eq(events.events[0].timestamps.length, 10, '10 次提取 timestamps 长度 10');
  const profile = buildProfileText({ events, now: NOW + 10 * HOUR });
  ok(!profile.text.includes('今晚加班'), '临时事件 10 次 → 仍不进正文（与次数无关）');
}

/* ───── 同一次提取同一 tag 只 push 一次 ───── */
{
  const res = extractOne({
    output: { tags: [tagCount('喜欢猫图'), tagCount('喜欢猫图')] },
    existing: { events: [] },
  });
  eq(res.events.events.length, 1, '同 tag 复用一条记录');
  eq(res.events.events[0].timestamps.length, 1, '同一次提取只 push 一次');
}

/* ───── 7 天清理（不入画像正文的旧计数） ───── */
{
  const events = { events: [{ tag: '喜欢猫图', category: '话题偏好', timestamps: [NOW - 8 * DAY, NOW - 6 * DAY, NOW] }] };
  const pruned = pruneEvents({ events, now: NOW });
  eq(pruned.events.length, 1, '7 天清理后仍保留该 tag');
  eq(pruned.events[0].timestamps.length, 2, '7 天清理：3 个时间戳过滤后长度 2');
  eq(countRecent([NOW - 8 * DAY, NOW - 6 * DAY, NOW], NOW), 2, 'countRecent 只剩 2 次');
  eq(countRecent([NOW - 7 * DAY], NOW), 1, '7 天整点算内（<=）');
  eq(countRecent([NOW - 7 * DAY - 1], NOW), 0, '超出 7 天 1ms 算外');
  eq(countRecent([NOW, NOW, NOW], NOW), 3, 'countRecent 计数正常');
  // 过滤后空 timestamps → 整条删除
  const empty = pruneEvents({ events: { events: [{ tag: '旧tag', category: '话题偏好', timestamps: [NOW - 8 * DAY] }] }, now: NOW });
  eq(empty.events.length, 0, '过滤后空 timestamps 的 tag 整条删除');
  // 不原地修改入参
  const input = { events: [{ tag: '旧tag', category: '话题偏好', timestamps: [NOW - 8 * DAY, NOW] }] };
  const before = JSON.stringify(input);
  const after = pruneEvents({ events: input, now: NOW });
  eq(JSON.stringify(input), before, 'pruneEvents 不原地修改入参');
  eq(after.events[0].timestamps.length, 1, 'pruneEvents 返回清理后的副本');
}

/* ───── 每条最多 50 tag，按最近提及时间淘汰 ───── */
{
  const events = {
    events: Array.from({ length: 60 }, (_v, i) => ({
      tag: `tag-${String(i).padStart(2, '0')}`,
      category: '话题偏好',
      timestamps: [NOW - i * HOUR],
    })),
  };
  const pruned = pruneEvents({ events, now: NOW });
  eq(pruned.events.length, 50, '60 个 tag → 保留 50');
  const kept = new Set(pruned.events.map((e) => e.tag));
  const expectedKept = Array.from({ length: 50 }, (_v, i) => `tag-${String(i).padStart(2, '0')}`);
  eq([...kept].sort(), [...expectedKept].sort(), '留下的都是最近提及时间最新的 50 个');
  ok(!kept.has('tag-59'), '最久未提及的 tag-59 被淘汰');
  eq(JSON.stringify(events).length > 0, true, '入参存在（占位）');
  ok(Array.isArray(events.events) && events.events.length === 60, '50 tag 上限不原地修改入参');
}

/* ───── 80 字上限（tag 边界截断） ───── */
{
  // 5 个 tag，每个恰好 6 个汉字，频次分别为 5/4/3/3/3。
  const six = ['喜欢猫猫图片', '追番动画日常', '深夜听歌入睡', '赛博朋克吐槽', '周末爬山散步'];
  const counts = [5, 4, 3, 3, 3];
  const events = {
    events: six.map((tag, i) => ({
      tag,
      category: '话题偏好', permanent: true,
      timestamps: Array.from({ length: counts[i] }, (_v, k) => NOW - i * HOUR - k * 10_000),
    })),
  };
  for (const tag of six) eq([...tag].length, 6, `tag 恰为 6 个汉字：${tag}`);

  const profile = buildProfileText({ events, now: NOW });
  ok([...profile.text].length <= 80, '5 个 6 字 tag 累加后 ≤80 字');
  eq([...profile.text].length, 34, '全量可容纳：5×6 + 4 个顿号 = 34 字');
  eq(profile.usedTags.length, 5, '全部 5 条 tag 均写入');
  for (const used of profile.usedTags) {
    ok(profile.text.includes(used), `usedTag 完整出现在正文中：${used}`);
  }

  // 真正触发 80 字上限：14 个 6 字 tag（14×6+13 = 97 > 80），必须在 tag 边界停止。
  const many = Array.from({ length: 14 }, (_v, i) => `六字标签${String(i).padStart(2, '0')}`);
  const bigEvents = {
    events: many.map((tag, i) => ({
      tag,
      category: '话题偏好', permanent: true,
      timestamps: [NOW - i, NOW - i - 1, NOW - i - 2],
    })),
  };
  const capped = buildProfileText({ events: bigEvents, now: NOW });
  ok([...capped.text].length <= 80, '14 个 6 字 tag → 正文 ≤80 字（触发截断）');
  ok(capped.usedTags.length < 14, '超 80 字后必须停止累加');
  eq([...capped.text].length, capped.usedTags.length * 6 + Math.max(0, capped.usedTags.length - 1), '正文长度 = tag 总数 + 顿号，未截断任何 tag');
  for (const used of capped.usedTags) {
    ok(capped.text.includes(used), `capped usedTag 完整：${used}`);
  }
  ok(!capped.text.includes(many[capped.usedTags.length]), '被停止的下一条 tag 未进入正文');

  // 边界：maxChars 恰好容下两条整 tag（6+1+6=13）后停止，不截断半个 tag。
  const tight = buildProfileText({ events, now: NOW, maxChars: 13 });
  eq(tight.text, '喜欢猫猫图片、追番动画日常', '13 字恰好容纳两条 6 字 tag + 顿号');
  eq([...tight.text].length, 13, '严格 13 字');
  eq(tight.usedTags.length, 2, '刚好两条 tag');
  for (const used of tight.usedTags) ok(tight.text.includes(used), `tight usedTag 完整：${used}`);

  // 剩余字数不足以容纳整条 tag → 停止，不截断。
  const one = buildProfileText({ events, now: NOW, maxChars: 12 });
  eq(one.text, '喜欢猫猫图片', '12 字容不下第二条 6 字 tag + 顿号 → 只写一条');
  eq(one.usedTags, ['喜欢猫猫图片'], '只写一条时 usedTags 同步');
  const zero = buildProfileText({ events, now: NOW, maxChars: 5 });
  eq(zero.text, '', '容不下整条 6 字 tag → 空正文（不截断半个词）');
  eq(zero.usedTags, [], '容不下整条 tag → usedTags 空');
}

/* ───── 空事件 ───── */
{
  eq(buildProfileText({ events: { events: [] }, now: NOW }), { text: '', usedTags: [] }, '空事件 → 空正文');
}

/* ───── 冷启动 ───── */
{
  const first = touchColdStart({ index: {}, userId: 'u1', now: NOW });
  eq(first.u1.coldStartUntil, NOW + 3 * DAY, '首次 touchColdStart 设 now+3 天');
  eq(first.u1.lastMentionedTags, {}, '首次 touchColdStart 初始化空 lastMentionedTags');
  ok(!canInjectProfile(first.u1, NOW), '冷启动当天不注入');
  ok(!canInjectProfile(first.u1, NOW + 2 * DAY), '冷启动 2 天内不注入');
  ok(!canInjectProfile(first.u1, NOW + 3 * DAY - 1), '冷启动差 1ms 不注入');
  ok(canInjectProfile(first.u1, NOW + 3 * DAY), '3 天整点允许注入（coldStartUntil > now 才 false）');
  ok(canInjectProfile(first.u1, NOW + 5 * DAY), '3 天后允许注入');
  ok(!canInjectProfile(undefined, NOW), '条目缺失 → 不注入');

  const second = touchColdStart({ index: { u1: { lastMentionedTags: { tag: NOW }, coldStartUntil: NOW - 100 } }, userId: 'u1', now: NOW });
  ok(second.u1.coldStartUntil > 0, '已有 coldStartUntil 不被覆盖');
  eq(second.u1.coldStartUntil, NOW - 100, '已有 coldStartUntil 保留原值');
  eq(second.u1.lastMentionedTags, { tag: NOW }, '保留已有 lastMentionedTags');

  const zeroEntry = touchColdStart({ index: { u1: { lastMentionedTags: {}, coldStartUntil: 0 } }, userId: 'u1', now: NOW });
  eq(zeroEntry.u1.coldStartUntil, NOW + 3 * DAY, 'coldStartUntil = 0 视为首次，重新设置');

  // 深拷贝：不改入参
  const inputIndex = { u1: { lastMentionedTags: { a: 1 }, coldStartUntil: 5 } };
  const snapshot = JSON.stringify(inputIndex);
  touchColdStart({ index: inputIndex, userId: 'u1', now: NOW });
  touchColdStart({ index: inputIndex, userId: 'u2', now: NOW });
  eq(JSON.stringify(inputIndex), snapshot, 'touchColdStart 不原地修改入参');
}

/* ───── markTagMentioned / staleTagsFor ───── */
{
  const fresh = markTagMentioned({ index: {}, userId: 'u1', tag: '喜欢猫图', now: NOW });
  // ★ 2026-11-05 R4.3：结构升级为 { at, count }（F2 需要提及次数）
  eq(fresh.u1, { lastMentionedTags: { 喜欢猫图: { at: NOW, count: 1 } }, coldStartUntil: 0 }, 'userId 不存在时新建并写入 lastMentionedTags（新结构 {at,count}）');

  const updated = markTagMentioned({
    index: { u1: { lastMentionedTags: { 喜欢猫图: NOW - HOUR }, coldStartUntil: 9 } },
    userId: 'u1',
    tag: '喜欢猫图',
    now: NOW,
  });
  eq(updated.u1.lastMentionedTags['喜欢猫图'].at, NOW, 'markTagMentioned 更新为 now');
  eq(updated.u1.lastMentionedTags['喜欢猫图'].count, 2, '旧裸数字按 1 次累加 → count=2');
  eq(updated.u1.coldStartUntil, 9, 'markTagMentioned 不动 coldStartUntil');

  const inputIndex = { u1: { lastMentionedTags: { a: 1 }, coldStartUntil: 2 } };
  const snapshot = JSON.stringify(inputIndex);
  markTagMentioned({ index: inputIndex, userId: 'u1', tag: 'a', now: NOW });
  eq(JSON.stringify(inputIndex), snapshot, 'markTagMentioned 不原地修改入参');

  const entry = { lastMentionedTags: { 喜欢猫图: NOW - 2 * DAY, 追番日常: NOW - 3 * DAY }, coldStartUntil: 0 };
  eq(
    staleTagsFor({ entry, now: NOW, tags: ['从未追问', '喜欢猫图', '追番日常'] }),
    ['从未追问', '追番日常'],
    '缺失算 stale；2 天不算；3 天算',
  );
  eq(staleTagsFor({ entry: undefined, now: NOW, tags: ['a', 'b'] }), ['a', 'b'], 'entry 缺失 → 全部 stale');
  eq(staleTagsFor({ entry, now: NOW, tags: [] }), [], '空 tags → 空结果');
  eq(staleTagsFor({ entry: { lastMentionedTags: { c: NOW - 3 * DAY + 1 }, coldStartUntil: 0 }, now: NOW, tags: ['c'] }), [], '差 1ms 未满 3 天 → 不 stale');
}

/* ───── 校验顺序：非法 tag 不占用 5 条名额 ───── */
{
  const dictionaries = { ...dictBase, sensitiveWords: ['毒品'], synonyms: {} };
  const res = extractOne({
    output: {
      tags: [
        { tag: '敏感内容毒品', category: '话题偏好' },
        tagCount('t1'), tagCount('t2'), tagCount('t3'), tagCount('t4'), tagCount('t5'),
      ],
    },
    existing: { events: [] },
    dictionaries,
  });
  eq(res.accepted.length, 5, '被拒的非法 tag 不占 5 条名额');
  eq(res.rejected.map((r) => r.reason), ['命中敏感词'], '只有非法那条进 rejected');
  eq(res.rejected[0].tag, '敏感内容毒品', 'rejected 记录归一化后 tag');
}

/* ───── 同义词在入库侧生效 ───── */
{
  const dictionaries = { ...dictBase, synonyms: { 猫猫: '喜欢猫图' } };
  const res = extractOne({
    output: { tags: [{ tag: '猫猫', category: '话题偏好' }] },
    existing: { events: [] },
    dictionaries,
  });
  eq(res.events.events[0].tag, '喜欢猫图', '入库 tag 走同义词归一化');
  eq(res.accepted[0].tag, '喜欢猫图', 'accepted 记录归一化后 tag');
}

/* ───── 非白名单 category 丢弃 ───── */
{
  const res = extractOne({
    output: { tags: [{ tag: '喜欢猫图', category: '医疗隐私' }] },
    existing: { events: [] },
  });
  eq(res.accepted, [], '非白名单 category 不进 accepted');
  eq(res.rejected, [{ tag: '喜欢猫图', reason: 'category 不在白名单' }], '非白名单 category 进 rejected');
  eq(res.events.events, [], '非白名单 category 不落 event');
}

/* ───── 不可变性：applyExtraction / buildProfileText 不改入参 ───── */
{
  const existing = { events: [{ tag: '旧tag', category: '话题偏好', timestamps: [NOW - 8 * DAY, NOW] }] };
  const snapshot = JSON.stringify(existing);
  const res = extractOne({ output: { tags: [tagCount('新tag')] }, existing });
  eq(JSON.stringify(existing), snapshot, 'applyExtraction 不原地修改 existing');
  ok(res.events.events.length >= 1, 'applyExtraction 返回新对象');

  const eventsForText = { events: [{ tag: '喜欢猫图', category: '话题偏好', timestamps: [NOW, NOW - HOUR, NOW - 2 * HOUR] }] };
  const textSnapshot = JSON.stringify(eventsForText);
  buildProfileText({ events: eventsForText, now: NOW });
  eq(JSON.stringify(eventsForText), textSnapshot, 'buildProfileText 不原地修改 events');
}

/* ───── 非法输出的返回值与集成方判据一致 ───── */
{
  const rejected = extractOne({ output: { tags: '不是数组' }, existing: { events: [] } }).rejected;
  eq(rejected.some((r) => r.reason === 'tags 不是数组'), true, "拒因字符串精确为 'tags 不是数组'（profile-store 以此为跳过判据）");
}

console.log(`r4-profile: passed ${checks} checks`);
