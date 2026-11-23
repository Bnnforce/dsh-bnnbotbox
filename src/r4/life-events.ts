/**
 * R4.0 模块新增（2026-11-04）：分时段「生活痕迹」抽卡 —— 纯函数层。
 *
 * 来源方案（生活方案.md）：
 *   ① 按四个时段从外部文本库随机抽一条隐藏事件；
 *   ② 抽卡结果落盘 `state/daily-mood.json`，每天只抽一次、重启不丢；
 *   ③ 每次组装 Prompt 时按当前时段注入 `[你的隐藏背景板：xxx]` + 强约束；
 *   ④ **绝不允许**生硬主动提起，只在语境合适时自然流露。
 *
 * 时段定义（方案指定，逐字）：
 *   late_night 02:00-06:00 / morning 06:00-12:00 / afternoon 12:00-18:00 / evening 18:00-02:00。
 *
 * ★ 重要设计决策（2026-11-04 与主人确认）：
 *   - **02:00-06:00 是既有装死窗口**（`time.isSleepWindow`），机器人整体静默 →
 *     此时段**照抽、照存**（状态完整，保证"每天都有生活"），但**不注入**。
 *   - 本模块与既有六段 `timeBlockText` **并存且互不干扰**：那个讲"现在几点、精神状态"，
 *     本模块讲"你今天发生了什么"。两者语义不同。
 *
 * 纪律（开发规则 §4/§5/§6）：
 *   - 本文件**纯函数**：不做 IO、不用 Date.now()、无随机源副作用（random 入参）；
 *   - 所有数值/文案/路径来自配置，**无魔法数字**；
 *   - 永不抛错（全部出口 try-catch 或纯计算）。
 */

import type { LifeEventsConfig } from './types.js';

/** 时段 id（与配置 `fallbacks` 的键一致）。 */
export type LifeSlotId = 'late_night' | 'morning' | 'afternoon' | 'evening';

/** 单个时段的定义（起止小时为**半开区间** `[start, end)`，end 小于 start 表示跨日）。 */
export interface LifeSlotDef {
  id: LifeSlotId;
  /** 对应的文件名。 */
  file: string;
  startHour: number;
  endHour: number;
  /** 人类可读的中文名（用于日志，不注入 prompt）。 */
  label: string;
}

/**
 * 四段定义（方案逐字；起止小时来自方案，不是魔法数字 —— 属于协议常量）。
 *
 * ⚠️ 若要调整时段，改这里**同时**改方案文档，否则两者会漂移。
 */
export const LIFE_SLOTS: readonly LifeSlotDef[] = [
  { id: 'late_night', file: 'late_night.md', startHour: 2, endHour: 6, label: '凌晨' },
  { id: 'morning', file: 'morning.md', startHour: 6, endHour: 12, label: '早晨' },
  { id: 'afternoon', file: 'afternoon.md', startHour: 12, endHour: 18, label: '午后' },
  { id: 'evening', file: 'evening.md', startHour: 18, endHour: 2, label: '傍晚' },
];

/**
 * `state/daily-mood.json` 形状。
 *
 * 与方案 §2「带上日期和具体的时段」对应：
 *   - `date`：抽卡那天的 `YYYY-MM-DD`（Asia/Shanghai），用于「每天只抽一次」判据；
 *   - `slots`：四个时段各一条已抽中的事件（抽一次四个全定，避免多次抽取导致同一时段前后不一致）。
 */
export interface DailyMoodState {
  date: string;
  slots: Partial<Record<LifeSlotId, string>>;
  /** 抽卡时间戳（诊断用）。 */
  generatedAt: number;
  /**
   * 最近几天的生活痕迹（跨天延续，2026-11-16 新增）。
   *
   * ═══════════════════════════════════════════════════════════════════════
   * 为什么加：原来是「每天重新抽 4 条，互不相关」——今天追萤火虫，明天泡茶，
   *   后天又说追蝴蝶，读起来像随机台词，不像一个人过日子。
   *   真人今天追萤火虫，明天会想「那只夜蝶还在不在」。
   *
   * 做法：保留最近 RECENT_KEEP_DAYS 天的条目（含日期），抽新卡时顺手带 1 条旧的
   *   作为「延续」。**纯本地数据，不增加任何 LLM 调用**。
   *
   * 容量：最多 RECENT_KEEP_DAYS × 4 条（默认 3×4=12），写入时自动裁剪。
   * ═══════════════════════════════════════════════════════════════════════
   */
  recent?: Array<{ date: string; text: string; slot: string }>;
}

/** recent 保留天数（含今天）。 */
export const RECENT_KEEP_DAYS = 3;
/** recent 最大条数（安全上限，防历史脏数据撑爆）。 */
export const RECENT_MAX_ITEMS = RECENT_KEEP_DAYS * 4 + 4;

/** 空状态（读盘失败时兜底）。 */
export const EMPTY_DAILY_MOOD: DailyMoodState = { date: '', slots: {}, generatedAt: 0, recent: [] };

/** 字符数（按码点，与项目其它模块同口径）。 */
function charLength(text: string): number {
  return [...String(text ?? '')].length;
}

/**
 * 某个小时落在哪个时段（**半开区间**，跨日段正确处理）。
 * 不命中任何时段（理论上不会：四段已覆盖 24 小时）→ undefined。
 */
export function slotOfHour(hour: number): LifeSlotDef | undefined {
  const h = Number(hour);
  if (!Number.isFinite(h) || h < 0 || h >= 24) return undefined;
  for (const slot of LIFE_SLOTS) {
    if (slot.startHour < slot.endHour) {
      if (h >= slot.startHour && h < slot.endHour) return slot;
      continue;
    }
    // 跨日段（evening 18:00-02:00）：h >= 18 或 h < 2
    if (h >= slot.startHour || h < slot.endHour) return slot;
  }
  return undefined;
}

/**
 * 把文件正文解析成候选事件列表。
 *
 * 方案 §1「每行一个事件，忽略空行」。另外做了三件净化（防垃圾污染，审查标准 §2）：
 *   ① 去行首尾空白；② 丢弃空行；③ **去重**（同一句写两遍不占两次抽取概率）。
 *
 * @returns 去重后的事件数组（可能为空 = 该文件没有可用内容 → 调用方用兜底）。
 */
export function parseEventLines(raw: string): string[] {
  const text = String(raw ?? '');
  if (!text) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of text.split(/\r?\n/u)) {
    const event = line.trim();
    if (!event) continue;
    if (seen.has(event)) continue;
    seen.add(event);
    out.push(event);
  }
  return out;
}

/**
 * 按 `maxChars` 截断单条事件（超出补省略号）。用于防「有人写一整段长文」撑爆 prompt。
 * `maxChars <= 0` → 原样返回（视为不限制）。
 */
export function clampEventText(event: string, maxChars: number): string {
  const text = String(event ?? '').trim();
  const limit = Number(maxChars);
  if (!Number.isFinite(limit) || limit <= 0) return text;
  if (charLength(text) <= limit) return text;
  // 留 1 个字符给省略号，保证总长不超 limit
  const cut = [...text].slice(0, Math.max(0, limit - 1)).join('');
  return `${cut}…`;
}

/** 抽卡所需的纯输入（IO 由 life-store 准备好后传进来）。 */
export interface PickLifeEventsInput {
  /** 抽卡日期 `YYYY-MM-DD`。 */
  date: string;
  /** 现在的时间戳（写入 generatedAt）。 */
  now: number;
  /** 随机数源，返回 [0,1)；测试注入。 */
  random: () => number;
  /** 每个时段解析出的候选事件（键为 slotId；缺失/空数组 → 用兜底）。 */
  candidates: Partial<Record<LifeSlotId, string[]>>;
  /** 配置（提供 fallbacks 与 max_event_chars）。 */
  config: LifeEventsConfig;
}

/** 从候选里随机取一条；空则返回 undefined（不在这里兜底，交给调用方）。 */
function pickOne(list: string[] | undefined, random: () => number): string | undefined {
  if (!Array.isArray(list) || list.length === 0) return undefined;
  const r = Number(random());
  // 防御：random 可能返回 1.0 / NaN / 负数（测试注入或异常源）
  const safe = Number.isFinite(r) && r >= 0 && r < 1 ? r : 0;
  const index = Math.min(list.length - 1, Math.floor(safe * list.length));
  return list[index];
}

/** 取某个时段的兜底文案（配置里没有 → 用一个中性默认，保证绝不空）。 */
export function fallbackOf(slotId: LifeSlotId, config: LifeEventsConfig): string {
  const configured = config?.fallbacks?.[slotId];
  const text = typeof configured === 'string' ? configured.trim() : '';
  return text || '在发呆';
}

/**
 * 抽卡：为四个时段各抽一条（有候选用候选，没有用兜底）。
 *
 * **一次抽四段并全部落盘**（方案的「带上日期和具体的时段」）：
 * 这样同一时段内多次 assemble 拿到的都是同一条，不会前后矛盾。
 */
export function pickLifeEvents(input: PickLifeEventsInput & { previous?: DailyMoodState; skipSlots?: LifeSlotId[] }): DailyMoodState {
  const slots: Partial<Record<LifeSlotId, string>> = {};
  const date = String(input.date ?? '');
  // P5 作息联动修正（2026-11-16）：
  //   late_night（02:00-06:00）是她的装死窗口，currentSlotEvent 在那段时间永远返回空。
  //   所以这一段抽了也用不上，等于每天白浪费 1/4 素材。现在直接跳过：不抽、不写 slots。
  // ⚠️ 2026-11-16：默认**不跳过**（保持既有「4 段都抽」语义，不影响已有测试/行为）；
  //   P5 的「装死窗口不抽」由调用方显式传 skipSlots: ['late_night'] 开启。
  const skipSlots = new Set<LifeSlotId>(input.skipSlots ?? []);
  for (const slot of LIFE_SLOTS) {
    if (skipSlots.has(slot.id)) continue;
    const picked = pickOne(input.candidates?.[slot.id], input.random);
    const text = picked === undefined ? fallbackOf(slot.id, input.config) : picked;
    slots[slot.id] = clampEventText(text, input.config?.max_event_chars ?? 0);
  }
  // ── 跨天延续（2026-11-16）：把旧条目并进 recent，自动裁剪 ──
  return {
    date,
    slots,
    generatedAt: Number(input.now) || 0,
    recent: mergeRecent(input.previous?.recent, date, slots),
  };
}

/**
 * 合并「最近生活痕迹」：丢掉超期/今天的旧条目，把今天的 4 条并进去，裁到上限。
 *
 * 只做纯数据整形，不读盘、不抛错。
 */
function mergeRecent(
  prev: DailyMoodState['recent'],
  today: string,
  todaySlots: Partial<Record<LifeSlotId, string>>,
): NonNullable<DailyMoodState['recent']> {
  const keepFrom = new Date(`${today}T00:00:00+08:00`);
  const cutoff = Number.isFinite(keepFrom.getTime())
    ? keepFrom.getTime() - (RECENT_KEEP_DAYS - 1) * 86400_000
    : 0;
  const out: NonNullable<DailyMoodState['recent']> = [];
  const seen = new Set<string>();
  for (const it of Array.isArray(prev) ? prev : []) {
    const t = it && typeof it.text === 'string' ? it.text.trim() : '';
    const d = it && typeof it.date === 'string' ? it.date : '';
    if (!t || !d) continue;
    if (d === today) continue;                       // 今天的重新写
    const ts = new Date(`${d}T00:00:00+08:00`).getTime();
    if (cutoff && Number.isFinite(ts) && ts < cutoff) continue;  // 超期丢弃
    const key = `${d}|${t}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ date: d, text: t, slot: String(it.slot ?? '') });
  }
  for (const slot of LIFE_SLOTS) {
    const t = todaySlots[slot.id];
    if (typeof t !== 'string' || !t.trim()) continue;
    const key = `${today}|${t}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ date: today, text: t.trim(), slot: slot.id });
  }
  return out.slice(-RECENT_MAX_ITEMS);
}

/**
 * 取「昨天/前天的旧事」（用于注入时带一句延续感）。
 *
 * @returns 最多 2 条，**不含今天**；没有则空数组（调用方据此不注入）
 */
export function recentPastEvents(
  state: DailyMoodState | undefined,
  today: string,
  limit = 2,
): Array<{ date: string; text: string }> {
  const list = Array.isArray(state?.recent) ? state.recent : [];
  const out: Array<{ date: string; text: string }> = [];
  for (let i = list.length - 1; i >= 0 && out.length < limit; i--) {
    const it = list[i];
    if (!it || typeof it.text !== 'string' || !it.text.trim()) continue;
    if (it.date === today) continue;
    out.push({ date: String(it.date ?? ''), text: it.text.trim() });
  }
  return out;
}

/**
 * 取当前时段应注入的那条事件。
 *
 * @param state 当日状态（可能来自磁盘）
 * @param hour  当前小时（0-23，由调用方用 `zonedTime` 取，**本模块不读时间**）
 * @param config 配置
 * @returns 事件文本；**处于装死窗口 / 无时段 / 配置关闭 → 空串（不注入）**
 *
 * ★ 主人确认（2026-11-04）：02:00-06:00 装死窗口**不注入**。
 *   注意：本模块不 import time.ts（模块纪律），装死判据由调用方传入。
 *   这里只用「凌晨段」这个已知事实：`late_night` 恰好覆盖 02:00-06:00。
 */
export function currentSlotEvent(
  state: DailyMoodState | undefined,
  hour: number,
  config: LifeEventsConfig,
): string {
  if (!config?.enabled) return '';
  const slot = slotOfHour(hour);
  if (!slot) return '';
  // 装死窗口 = 凌晨段（02:00-06:00）→ 主人确认不注入。
  // 用 slot id 判而不是硬编码小时，避免与 LIFE_SLOTS 漂移。
  if (slot.id === 'late_night') return '';
  const event = state?.slots?.[slot.id];
  if (typeof event !== 'string') return '';
  const text = event.trim();
  return text ? clampEventText(text, config.max_event_chars ?? 0) : '';
}

/**
 * 渲染注入文本（方案 §3 逐字 + 强约束）。
 *
 * 形如：
 * ```
 * [你的隐藏背景板：在整理书架]
 *
 * 这是你的隐藏背景板，绝对禁止生硬地主动提起（比如"我今天在喝茶"）。
 * 只有当群友问到相关话题，或者语境极其合适时，才能自然流露
 * （如：群友抱怨下雨，你可以附和说：原来你那边也下雨啦，我还担心我的花呢～）。
 * ```
 *
 * @param event 已抽中的事件（空串 → 返回空串，调用方据此不注入）
 * @returns 完整注入段；空事件返回空串
 */
export function lifeBackgroundText(event: string, carried?: string): string {
  const text = String(event ?? '').trim();
  if (!text) return '';
  const old = String(carried ?? '').trim();
  const lines = [
    `[你的隐藏背景板：${text}]`,
    '',
    '这是你的隐藏背景板，绝对禁止生硬地主动提起（比如"我今天在喝茶"）。',
    '只有当群友问到相关话题，或者语境极其合适时，才能自然流露',
    '（如：群友抱怨下雨，你可以附和说：原来你那边也下雨啦，我还担心我的花呢～）。',
  ];
  // ── 跨天延续（2026-11-16）：这两天你还做过这些事 ──
  //   作用：让"生活"连起来，而不是每天换一套随机台词。
  //   ⚠️ 同样**不主动提**；只在话题自然对上时才可能想起来（"诶，昨天那件事……"）。
  if (old) {
    lines.push(
      '',
      '另外，这两天你还做过这些事（同样是背景，不是要说给人听的）：',
      old,
      '如果需要，可以自然想起（"诶，前两天好像……"）；不需要就完全不用提，别硬凑。',
    );
  }
  return lines.join('\n');
}

/** 判断某日状态是否已过期（跨天 → 需要重抽）。纯比较，无 IO。 */
export function isStaleMood(state: DailyMoodState | undefined, today: string): boolean {
  if (!state || typeof state.date !== 'string') return true;
  if (state.date !== today) return true;
  // 防御：同一天但 slots 缺失（文件损坏）→ 也重抽
  const slots = state.slots;
  if (!slots || typeof slots !== 'object') return true;
  for (const slot of LIFE_SLOTS) {
    if (typeof slots[slot.id] !== 'string' || !slots[slot.id]?.trim()) return true;
  }
  return false;
}
