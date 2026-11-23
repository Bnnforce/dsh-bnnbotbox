#!/usr/bin/env node
/**
 * 生活痕迹抽卡测试（2026-11-04）。
 * 运行：node test-r4/r4-life.mjs
 *
 * 覆盖（对应 生活方案.md §1-§3 + 三条主人确认）：
 *   ① 四段时段划分（含跨日的 evening 18:00-02:00）
 *   ② 文件解析：每行一个事件、忽略空行、去重、单条截断
 *   ③ 抽卡：有候选用候选，没有用**该时段独立兜底**（不是一句通用"在发呆"）
 *   ④ 持久化：同日不重抽、跨天重抽、读失败降级
 *   ⑤ 注入：02:00-06:00 装死窗口**不注入**（主人确认）
 *   ⑥ 注入文本逐字含强约束
 *   ⑦ fuse：背景板**参与熔断**且**最先被丢**（主人确认）
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const life = await import('../../lib/persona/r4/life-events.js');
const store = await import('../../lib/persona/r4/life-store.js');
const fuse = await import('../../lib/persona/r4/fuse.js');
const inject = await import('../../lib/persona/r4/inject.js');

const {
  LIFE_SLOTS, slotOfHour, parseEventLines, clampEventText,
  pickLifeEvents, fallbackOf, currentSlotEvent, lifeBackgroundText,
  isStaleMood, EMPTY_DAILY_MOOD,
} = life;
const { ensureDailyMood, readDailyMood, readEventCandidates, dailyMoodPath } = store;
const { FUSE_BUDGET, fuse: fuseFn, charLen } = fuse;
const { buildInjection } = inject;

let checks = 0;
function ok(cond, label) { assert.ok(cond, label); checks += 1; }
function eq(a, b, label) { assert.deepEqual(a, b, label); checks += 1; }

/** 测试用配置（与 DEFAULT_CONFIG 形状一致，但兜底文案改成可区分的值便于断言） */
const CFG = {
  enabled: true,
  events_dir: '',
  max_event_chars: 40,
  fallbacks: {
    late_night: '凌晨兜底',
    morning: '早晨兜底',
    afternoon: '午后兜底',
    evening: '傍晚兜底',
  },
};

/* ══════════ 一、时段划分（半开区间 + 跨日）══════════ */

eq(LIFE_SLOTS.length, 4, '四个时段');
eq(LIFE_SLOTS.map((s) => s.id), ['late_night', 'morning', 'afternoon', 'evening'], '时段顺序与方案一致');

// 半开区间边界逐点验证
eq(slotOfHour(2)?.id, 'late_night', '02:00 归凌晨（含起点）');
eq(slotOfHour(5)?.id, 'late_night', '05:00 归凌晨');
eq(slotOfHour(6)?.id, 'morning', '06:00 归早晨（不含凌晨终点）');
eq(slotOfHour(11)?.id, 'morning', '11:00 归早晨');
eq(slotOfHour(12)?.id, 'afternoon', '12:00 归午后');
eq(slotOfHour(17)?.id, 'afternoon', '17:00 归午后');
eq(slotOfHour(18)?.id, 'evening', '18:00 归傍晚');
eq(slotOfHour(23)?.id, 'evening', '23:00 归傍晚（跨日前半）');
eq(slotOfHour(0)?.id, 'evening', '00:00 归傍晚（跨日后半）');
eq(slotOfHour(1)?.id, 'evening', '01:00 归傍晚（跨日最后）');
eq(slotOfHour(1.9)?.id, 'evening', '01:54（小数小时）归傍晚');

// 非法输入
eq(slotOfHour(-1), undefined, '负数小时 → undefined');
eq(slotOfHour(24), undefined, '24 → undefined');
eq(slotOfHour(NaN), undefined, 'NaN → undefined');

// 24 小时全覆盖（不出现空洞）
{
  let covered = 0;
  for (let h = 0; h < 24; h += 1) if (slotOfHour(h)) covered += 1;
  eq(covered, 24, '四段覆盖全部 24 小时，无空洞');
}

/* ══════════ 二、文件解析 ══════════ */

eq(parseEventLines('在整理书架\n出去散步了'), ['在整理书架', '出去散步了'], '每行一个事件');
eq(parseEventLines('  在整理书架  \n\n   \n出去散步了\n'), ['在整理书架', '出去散步了'], '忽略空行与首尾空白');
eq(parseEventLines('重复\n重复\n唯一'), ['重复', '唯一'], '同一行重复 → 去重');
eq(parseEventLines(''), [], '空文件 → 空数组');
eq(parseEventLines('\n\n\n'), [], '全是空行 → 空数组');
eq(parseEventLines('a\r\nb'), ['a', 'b'], 'Windows CRLF 正确处理');

// 单条截断
eq(clampEventText('短句', 40), '短句', '未超限原样');
ok(clampEventText('一'.repeat(60), 40).length <= 40, '超限截断后总长 ≤ 40');
ok(clampEventText('一'.repeat(60), 40).endsWith('…'), '超限补省略号');
eq(clampEventText('任意', 0), '任意', 'maxChars=0 → 不限制');

/* ══════════ 三、抽卡与兜底 ══════════ */

{
  const r = pickLifeEvents({
    date: '2026-11-04',
    now: 1760000000000,
    random: () => 0.5,
    candidates: {},
    config: CFG,
  });
  eq(r.date, '2026-11-04', '抽卡记录日期');
  eq(r.slots.late_night, '凌晨兜底', '无候选 → 凌晨**独立兜底**');
  eq(r.slots.morning, '早晨兜底', '无候选 → 早晨**独立兜底**');
  eq(r.slots.afternoon, '午后兜底', '无候选 → 午后**独立兜底**');
  eq(r.slots.evening, '傍晚兜底', '无候选 → 傍晚**独立兜底**');
  ok(r.slots.late_night !== r.slots.morning, '四段兜底不是同一句（方案要求可区分）');
}

{
  // 有候选 → 用候选（random=0 取第一条，random 接近 1 取最后一条）
  const cands = { morning: ['甲', '乙', '丙'] };
  eq(pickLifeEvents({ date: 'd', now: 1, random: () => 0, candidates: cands, config: CFG }).slots.morning, '甲', 'random=0 → 第一条');
  eq(pickLifeEvents({ date: 'd', now: 1, random: () => 0.99, candidates: cands, config: CFG }).slots.morning, '丙', 'random≈1 → 最后一条');
  eq(pickLifeEvents({ date: 'd', now: 1, random: () => 0.5, candidates: cands, config: CFG }).slots.morning, '乙', 'random=0.5 → 中间');
}

// 异常 random 源（防御性）：返回 1.0 / NaN / 负数都不能崩、不能越界
{
  const cands = { morning: ['甲', '乙'] };
  eq(pickLifeEvents({ date: 'd', now: 1, random: () => 1.0, candidates: cands, config: CFG }).slots.morning, '甲', 'random 返回 1.0 → 回退安全值（不越界）');
  eq(pickLifeEvents({ date: 'd', now: 1, random: () => NaN, candidates: cands, config: CFG }).slots.morning, '甲', 'random 返回 NaN → 回退安全值');
  eq(pickLifeEvents({ date: 'd', now: 1, random: () => -1, candidates: cands, config: CFG }).slots.morning, '甲', 'random 返回负数 → 回退安全值');
}

// 抽卡时也应用截断
{
  const long = '一'.repeat(80);
  const r = pickLifeEvents({ date: 'd', now: 1, random: () => 0, candidates: { morning: [long] }, config: CFG });
  ok(r.slots.morning.length <= 40, '抽卡时对候选做截断（防长句撑爆 prompt）');
}

// fallbackOf：配置缺失的键 → 中性默认
eq(fallbackOf('late_night', CFG), '凌晨兜底', '读配置兜底');
eq(fallbackOf('morning', { ...CFG, fallbacks: {} }), '在发呆', '配置缺该键 → 中性默认（绝不空）');

/* ══════════ 四、注入取用：装死窗口不注入（主人确认第 1 点）══════════ */

{
  const full = { date: 'd', slots: CFG.fallbacks, generatedAt: 1 };

  // 凌晨段（02:00-06:00）= 装死窗口 → 不注入
  eq(currentSlotEvent(full, 2, CFG), '', '02:00 装死窗口 → 不注入');
  eq(currentSlotEvent(full, 3, CFG), '', '03:00 装死窗口 → 不注入');
  eq(currentSlotEvent(full, 5, CFG), '', '05:00 装死窗口 → 不注入');

  // 其它时段正常注入
  eq(currentSlotEvent(full, 6, CFG), '早晨兜底', '06:00 → 早晨事件');
  eq(currentSlotEvent(full, 13, CFG), '午后兜底', '13:00 → 午后事件');
  eq(currentSlotEvent(full, 20, CFG), '傍晚兜底', '20:00 → 傍晚事件');
  eq(currentSlotEvent(full, 0, CFG), '傍晚兜底', '00:00（跨日）→ 傍晚事件');

  // 关闭开关 → 永不注入
  eq(currentSlotEvent(full, 13, { ...CFG, enabled: false }), '', '配置关闭 → 不注入');

  // 状态缺失 → 空
  eq(currentSlotEvent(undefined, 13, CFG), '', '状态缺失 → 空');
  eq(currentSlotEvent({ ...EMPTY_DAILY_MOOD }, 13, CFG), '', '空状态 → 空');
}

/* ══════════ 五、注入文本逐字（方案 §3）══════════ */

{
  const text = lifeBackgroundText('在整理书架');
  ok(text.startsWith('[你的隐藏背景板：在整理书架]'), '注入抬头逐字含事件');
  ok(text.includes('绝对禁止生硬地主动提起'), '含【禁止主动提起】强约束');
  ok(text.includes('我今天在喝茶'), '含反例（我今天在喝茶）');
  ok(text.includes('只有当群友问到相关话题'), '含触发条件');
  ok(text.includes('原来你那边也下雨啦，我还担心我的花呢～'), '含正向示例逐字');
  eq(lifeBackgroundText(''), '', '空事件 → 空串（不注入）');
  eq(lifeBackgroundText('   '), '', '纯空白 → 空串');
}

/* ══════════ 六、持久化：当天不重抽、跨天重抽、失败降级 ══════════ */

function withTempRoot(fn) {
  const root = mkdtempSync(join(tmpdir(), 'r4-life-'));
  try { return fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

{
  const result = await withTempRoot(async (root) => {
    // 造事件库（注意 events_dir 指向临时目录，测试隔离）
    const dir = join(root, 'events');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'morning.md'), '泡茶\n看书\n\n', 'utf8');
    writeFileSync(join(dir, 'afternoon.md'), '整理书架\n', 'utf8');
    writeFileSync(join(dir, 'evening.md'), '散步\n', 'utf8');
    // late_night.md **故意不建** → 测兜底

    const cfg = { ...CFG, events_dir: dir };
    const a = ensureDailyMood({ root, today: '2026-11-04', now: 1, random: () => 0, config: cfg });
    eq(a.date, '2026-11-04', '首次抽卡写入日期');
    eq(a.slots.late_night, '凌晨兜底', '缺失文件 → 该段兜底');
    ok(['泡茶', '看书'].includes(a.slots.morning), '有候选 → 从文件抽到');

    // 同日再调 → 必须复用（random 换成必然不同的值，验证没重抽）
    const b = ensureDailyMood({ root, today: '2026-11-04', now: 2, random: () => 0.999, config: cfg });
    eq(b.slots.morning, a.slots.morning, '同一天 → 不重抽（重启不丢）');
    eq(b.generatedAt, a.generatedAt, '同一天 → generatedAt 不变');

    // 跨天 → 重抽
    const c = ensureDailyMood({ root, today: '2026-11-05', now: 3, random: () => 0.999, config: cfg });
    eq(c.date, '2026-11-05', '跨天 → 日期更新');
    eq(c.generatedAt, 3, '跨天 → generatedAt 更新');

    // 落盘验证
    const onDisk = readDailyMood(root);
    eq(onDisk.date, '2026-11-05', '状态已落盘（原子写）');
    return true;
  });
  ok(result, '持久化流程跑通');
}

// 配置关闭 → 完全不抽（返回空状态，不写盘）
{
  await withTempRoot(async (root) => {
    const r = ensureDailyMood({ root, today: '2026-11-04', now: 1, random: () => 0, config: { ...CFG, enabled: false } });
    eq(r.date, '', '关闭 → 空状态');
    eq(r.slots, {}, '关闭 → 无 slots');
  });
}

// events_dir 为空 → 全部兜底，不崩
{
  await withTempRoot(async (root) => {
    const r = ensureDailyMood({ root, today: '2026-11-04', now: 1, random: () => 0, config: { ...CFG, events_dir: '' } });
    eq(r.slots.morning, '早晨兜底', 'events_dir 空 → 兜底');
  });
}

// 目录不存在 → 全部兜底，不崩
{
  await withTempRoot(async (root) => {
    const r = ensureDailyMood({ root, today: '2026-11-04', now: 1, random: () => 0, config: { ...CFG, events_dir: join(root, '不存在的目录') } });
    eq(r.slots.morning, '早晨兜底', '目录不存在 → 兜底，不抛');
  });
}

// readEventCandidates：文件不存在/为空 → 空数组
{
  const dir = mkdtempSync(join(tmpdir(), 'r4-life-ev-'));
  try {
    eq(readEventCandidates(dir, 'nope.md'), [], '文件不存在 → 空数组');
    writeFileSync(join(dir, 'empty.md'), '', 'utf8');
    eq(readEventCandidates(dir, 'empty.md'), [], '空文件 → 空数组');
    writeFileSync(join(dir, 'ok.md'), 'a\nb\n', 'utf8');
    eq(readEventCandidates(dir, 'ok.md'), ['a', 'b'], '正常文件 → 解析');
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// isStaleMood
eq(isStaleMood(undefined, 'd'), true, '无状态 → 需要重抽');
eq(isStaleMood({ ...EMPTY_DAILY_MOOD }, 'd'), true, '空日期 → 需要重抽');
eq(isStaleMood({ date: 'old', slots: CFG.fallbacks, generatedAt: 1 }, 'd'), true, '日期不同 → 需要重抽');
eq(isStaleMood({ date: 'd', slots: CFG.fallbacks, generatedAt: 1 }, 'd'), false, '同日且完整 → 不需要重抽');
eq(isStaleMood({ date: 'd', slots: {}, generatedAt: 1 }, 'd'), true, '同日但 slots 缺失（损坏）→ 需要重抽');

// 状态文件损坏 → 读失败降级为空状态（不抛）
{
  await withTempRoot(async (root) => {
    const p = dailyMoodPath(root);
    mkdirSync(join(root, 'state'), { recursive: true });
    writeFileSync(p, '{坏JSON', 'utf8');
    const r = readDailyMood(root);
    eq(r.date, '', '损坏 JSON → 降级为空状态');
  });
}

/* ══════════ 七、fuse：背景板参与熔断 + 最先被丢（主人确认第 2 点）══════════ */

/** 一段真实形状的背景板文本（用于 fuse 测试） */
const BG = lifeBackgroundText('在整理书架');

{
  // 预算充足 → 不丢，且计入 used
  const r = fuseFn({
    profile: '', lifeBackground: BG, tempEvents: '', memoryRules: '', overlay: '',
    relationship: '', contest: '', others: [], timeState: '', highlights: '',
  }, FUSE_BUDGET);
  eq(r.text.includes('隐藏背景板'), true, '预算充足 → 背景板在输出里');
  eq(r.used, charLen(BG), '背景板计入 used（参与熔断）');
  eq(r.fused, false, '预算充足不熔断');
}

{
  // 预算精确可控 → 验证「背景板是第一个被丢的」：
  //   BG 约 119 字 + 其他标签约 9 字 + 时间状态约 9 字。
  //   预算给「刚好够装下 others + timeState、但装不下 BG」的值，
  //   这样丢了 BG 就立即回到预算内 → drops 只有 1 项，others 保留。
  const othersText = '其他标签AAAA';
  const timeText = '时间状态BBBB';
  const budgetWithoutBg = charLen(othersText) + charLen('\n\n') + charLen(timeText);
  const r = fuseFn({
    profile: '',
    lifeBackground: BG,
    tempEvents: '',
    memoryRules: '',
    overlay: '',
    relationship: '',
    contest: '',
    others: [{ userId: 'u1', text: othersText }],
    timeState: timeText,
    highlights: '',
  }, budgetWithoutBg);
  eq(r.fused, true, '超预算 → 熔断');
  eq(r.drops.length, 1, '★ 只丢一段就回到预算内（证明它是最先被丢的那个）');
  eq(r.drops[0], '生活背景板', '★ 背景板是**第一个**被丢的（主人确认）');
  eq(r.text.includes('隐藏背景板'), false, '背景板已从输出移除');
  ok(r.text.includes('其他标签'), '其他在场标签这次保留了（证明背景板先于它被丢）');
  ok(r.text.includes('时间状态'), '时间状态永不丢');
}

{
  // 只有背景板一个段、且超预算 → 丢了之后为空
  const r = fuseFn({
    profile: '', lifeBackground: BG, tempEvents: '', memoryRules: '', overlay: '',
    relationship: '', contest: '', others: [], timeState: '', highlights: '',
  }, 5);
  eq(r.fused, true, '单段超预算 → 熔断');
  eq(r.text, '', '丢了背景板后无其它内容');
  eq(r.used, 0, '丢完后 used=0');
}

/* ══════════ 八、注入层接线 ══════════ */

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
    getLifeBackground: () => '',
    ...over,
  };
}

{
  const out = buildInjection({
    groupId: 'g', userId: 'u', persona: 'elysia',
    levels: { L0: '高信任', L1: '熟悉', L2: '普通', L3: '低互动' },
    sources: sourcesOf(),
  });
  eq(out.present.lifeBackground, false, '无回调值 → 背景板不注入');
}

{
  const out = buildInjection({
    groupId: 'g', userId: 'u', persona: 'elysia',
    levels: { L0: '高信任', L1: '熟悉', L2: '普通', L3: '低互动' },
    sources: sourcesOf({ getLifeBackground: () => BG }),
  });
  eq(out.present.lifeBackground, true, '有值 → 背景板注入');
  ok(out.text.includes('隐藏背景板'), '输出含背景板');
}

// 回调抛错 → 安全降级，不崩
{
  const out = buildInjection({
    groupId: 'g', userId: 'u', persona: 'elysia',
    levels: { L0: '高信任', L1: '熟悉', L2: '普通', L3: '低互动' },
    sources: sourcesOf({ getLifeBackground: () => { throw new Error('boom'); } }),
  });
  eq(out.present.lifeBackground, false, '回调抛错 → 不注入、不崩');
  eq(typeof out.text, 'string', '仍返回字符串');
}

// 老调用方（没有 getLifeBackground）→ 不崩
{
  const { getLifeBackground, ...rest } = sourcesOf();
  const out = buildInjection({
    groupId: 'g', userId: 'u', persona: 'elysia',
    levels: { L0: '高信任', L1: '熟悉', L2: '普通', L3: '低互动' },
    sources: rest,
  });
  eq(out.present.lifeBackground, false, '无该回调 → 不注入（向后兼容）');
}

console.log(`r4-life: passed ${checks} checks`);
