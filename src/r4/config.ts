/**
 * R4.0 配置加载（阶段一基建）。
 *
 * 红线：
 *  - `elysia.json` 缺失/坏 → 默认值 + warn，绝不抛顶层；
 *  - `sleep_start/end` 只做一致性校验：不等于 `02:00/06:00` → warn 并回退默认；
 *  - `model_config` 模型 ID 为 `"..."` / 空 / 占位符 → `backgroundEnabled = false`
 *    （禁用后台心跳/提取，主聊天不受影响）；
 *  - `useLegacyAffinity: false`（启动时读取，不做运行时静默回退）。
 */

import { readJsonSafe, isPlainObject } from './atomic.js';
import { personaConfigPath, personaDataRoot } from './paths.js';
import { DEFAULT_TIME_ZONE, resolveTimeZone } from './time.js';
import type { ConfigLoadResult, ElysiaConfig, Level } from './types.js';

/**
 * 群静默判定的**生产默认值**（分钟）。2026-11-05（心跳人性化·阶段1）。
 *
 * 为什么放在配置层而不是 `heartbeat.evaluateTick`：那 52 条状态机单测依赖
 * 「给定状态该发就发」，判定函数的纯函数兜底必须是 0（=关闭），否则老用例
 * 全变「跳过」；生产默认 20 由这里给 —— scheduler 会把 `config.heartbeat_config`
 * 原样传给判定层，配上本字段即生效。
 */
const DEFAULT_MIN_QUIET_MINUTES = 20;

/** 图纸 1.1 的完整默认配置（逐字对齐）。 */
export const DEFAULT_CONFIG: ElysiaConfig = {
  name: '爱莉希雅',
  timezone: 'Asia/Shanghai',
  useLegacyAffinity: false,
  time_config: {
    sleep_start: '02:00',
    sleep_end: '06:00',
    wake_probability: 0.7,
  },
  heartbeat_config: {
    interval_minutes: 45,
    jitter_minutes: 15,
    max_daily: 5,
    cooldown_hours: 3,
    // 2026-11-05（心跳人性化·阶段1）：群最近 N 分钟有人说话 → 跳过心跳（不插嘴）。
    //   **生产默认必须在这里显式给 20**：`heartbeat.evaluateTick` 的纯函数兜底是 0（关），
    //   靠本字段让「不配置该字段的部署」也默认开启该判定；`0` = 关闭。
    min_quiet_minutes: DEFAULT_MIN_QUIET_MINUTES,
    // 2026-11-05（心跳人性化·阶段2）：生成模式缺省 legacy。
    //   **绝不能默认 wake**：`test-r4/r4-e2e.mjs` 的既有断言依赖 legacy 的 send 通道。
    generation_mode: 'legacy',
    heartbeatMaxTokens: 200,
    heartbeatTimeoutMs: 5000,
  },
  extraction_config: {
    max_messages_per_day: 50,
    extractionMaxTokens: 500,
    extractionTimeoutMs: 8000,
    run_daily_at: '03:00',
  },
  reply_detection: {
    window_minutes: 10,
    keywords: ['哈哈', '确实', '真的吗', '怎么说', '为什么', '然后呢', '你觉得'],
    question_regex: '([?？]|[吗呢][?？])$',
  },
  model_config: {
    heartbeatModel: '...',
    extractionModel: '...',
  },
  relationship_levels: {
    L0: '高信任',
    L1: '熟悉',
    L2: '普通',
    L3: '低互动',
  },
  relationship_config: {
    initial_level: 'L2',
    initial_score: 0,
    level_bounds: {
      L3: { minInclusive: -100, maxExclusive: -5 },
      L2: { minInclusive: -5, maxExclusive: 10 },
      L1: { minInclusive: 10, maxExclusive: 25 },
      L0: { minInclusive: 25, maxInclusive: 100 },
    },
    decay_per_day: 1,
    score_cooldown_minutes: 10,
    score_reply: 2,
    score_mention: 3,
    score_bot: 1,
  },
  privacy_whitelist: ['互动风格', '常用表情/梗', '话题偏好', '语气特征', '活跃时段'],
  sensitive_words_path: 'configs/sensitive_words.json',
  synonym_dict_path: 'configs/synonyms.json',
  negative_words_path: 'configs/negative_words.json',
  meme_dict_path: 'configs/memes.json',
  /**
   * ★ 2026-11-04 新增：生活痕迹抽卡（方案 §1-§3）。
   * 四段兜底文案各给一句本来就"像她"的中性事件，即便用户还没填事件库
   * 也能跑（主人说文件内容稍后自己搞，所以兜底必须够用）。
   */
  life_events: {
    enabled: true,
    events_dir: process.env.PERSONA_EVENTS_DIR || '',
    max_event_chars: 40,
    fallbacks: {
      late_night: '还没什么睡意，在窗边发呆',
      morning: '刚泡好一杯茶',
      afternoon: '在整理书架',
      evening: '出去散步了',
    },
  },
  /**
   * ★ 2026-11-05 参数解耦：熔断预算从 `fuse.ts` 的硬编码外置到这里。
   * 缺省 1000 与旧行为**完全一致**（改这里才变）。
   */
  inject_config: {
    fuse_budget: 1000,
  },
  /**
   * ★ 2026-11-05 R4.3：**功能总开关，全部默认 false**。
   *
   * 安全原则：加这些代码之后，**部署行为与之前完全一致**；
   * 验证通过后逐个打开，任何一项出问题都能单独关掉。
   */
  features_config: {
    memory_link: false,
    memory_tier: false,
    milestones: false,
    push: false,
    ritual: false,
    // ★ 2026-11-09 R4.1 新人识别：默认关闭（与其它功能同一保守策略，
    //   验证通过后在 elysia.json 里显式打开）
    newcomer: false,
    newcomer_days: 3,
    newcomer_max_messages: 6,
    // ★ 2026-11-16「活人感」（默认：P1 关，其余开）
    life_continuity: true,
    absence_hint: true,
    own_time: false,       // 唯一增加成本的功能，默认关
    mood_tint: true,
    life_slot_fix: true,
  },
  /**
   * ★ 2026-11-05 R4.3：事件召回参数（按主人群的实际对话密度定，全部往小调）。
   */
  events_config: {
    window_days: 3,
    cooldown_days: 2,
    expire_days: 4,
    max_per_user: 30,
    max_candidates: 3,
    model_judge: false,
    tau_days: 3,
  },
  // ★ 2026-11-16 P1：自己的时间（参数可调）
  own_time_config: {
    intervalMin: 150,
    dailyMax: 4,
    quietFromHour: 2,
    quietToHour: 6,
  },
};

const LEVELS: Level[] = ['L0', 'L1', 'L2', 'L3'];
/** 模型 ID 占位符集合（命中即禁用后台任务）。 */
const MODEL_PLACEHOLDER_RE = /^(\.{2,}|…|placeholder|占位|待填|none|null|undefined)?$/iu;

/** 判断模型 ID 是否可用（非空、非占位符）。 */
export function modelIdUsable(id: unknown): boolean {
  const s = String(id ?? '').trim();
  if (!s) return false;
  if (MODEL_PLACEHOLDER_RE.test(s)) return false;
  if (s.startsWith('...')) return false;
  return true;
}

function num(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function str(value: unknown, fallback: string): string {
  const s = String(value ?? '').trim();
  return s || fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function strArray(value: unknown, fallback: readonly string[]): string[] {
  if (!Array.isArray(value)) return [...fallback];
  const out = value.map((x) => String(x ?? '').trim()).filter(Boolean);
  return out.length > 0 ? out : [...fallback];
}

/**
 * 把磁盘 JSON 合并进默认值。**只做保守覆盖**：类型不对就用默认，缺就用默认。
 * @returns 合并后的配置 + 覆盖过程中产生的 warning 列表。
 */
export function mergeConfig(raw: unknown): { config: ElysiaConfig; warnings: string[] } {
  const warnings: string[] = [];
  const base: ElysiaConfig = JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as ElysiaConfig;
  if (!isPlainObject(raw)) {
    warnings.push('[r4] persona-configs 配置缺失或不是对象 → 全部使用默认值');
    return { config: base, warnings };
  }
  base.name = str(raw.name, base.name);
  // 2026-11-03 修复（R4 体检 P1-4）：时区非法 → 回退图纸默认 + 仅告警。
  // 图纸 0.5 明确「全局时区 Asia/Shanghai」；配置误写成 UTC 会让跨天与装死窗口双基准。
  const tzRaw = str(raw.timezone, base.timezone);
  const tz = resolveTimeZone(tzRaw);
  if (tz !== tzRaw || tz !== DEFAULT_TIME_ZONE) {
    warnings.push(`[r4] timezone=${tzRaw} 非图纸默认 Asia/Shanghai → 已归一为 ${tz}（跨天/装死窗口统一按它算）`);
  }
  base.timezone = tz;
  base.useLegacyAffinity = bool(raw.useLegacyAffinity, base.useLegacyAffinity);
  if (base.useLegacyAffinity) {
    warnings.push('[r4] useLegacyAffinity=true 与 R4.0 不兼容（旧 affinity.json 只读）→ 已按 false 运行');
    base.useLegacyAffinity = false;
  }

  const timeConfig = isPlainObject(raw.time_config) ? raw.time_config : {};
  base.time_config = {
    sleep_start: str(timeConfig.sleep_start, base.time_config.sleep_start),
    sleep_end: str(timeConfig.sleep_end, base.time_config.sleep_end),
    wake_probability: num(timeConfig.wake_probability, base.time_config.wake_probability),
  };
  // 图纸 1.1：sleep_start/end 只做一致性校验，运行逻辑硬编码 02:00-06:00。
  if (base.time_config.sleep_start !== '02:00' || base.time_config.sleep_end !== '06:00') {
    warnings.push(
      `[r4] sleep_start/end 与固定装死窗口不一致（${base.time_config.sleep_start}-${base.time_config.sleep_end}）`
      + ' → 运行逻辑仍用 02:00-06:00，配置仅告警',
    );
    base.time_config.sleep_start = '02:00';
    base.time_config.sleep_end = '06:00';
  }
  // wake_probability 必须先钳到 [0,1]，再判 NaN 兜底。
  const wp = base.time_config.wake_probability;
  base.time_config.wake_probability = Number.isFinite(wp) ? Math.max(0, Math.min(1, wp)) : 0.7;

  const hb = isPlainObject(raw.heartbeat_config) ? raw.heartbeat_config : {};
  const waitingRaw = Number(hb.waiting_minutes);
  // 2026-11-05（心跳人性化·阶段1）：群静默判定窗口（分钟）。缺省/非法 → 生产默认 20。
  //   ⚠️ `0` 是**合法值**（=关闭该判定），所以合法性判据只能写 `>= 0`，绝不能写 `> 0`；
  //   负数按「写坏了」处理 → 回落 20（而不是钳到 0，避免手滑写成 -1 就悄悄关掉判定）。
  //   只有数字/数字串才参与换算：null / 布尔 / 空串 / 缺省一律视为非法 → 回落 20
  //   （`Number(null)` 与 `Number('')` 都是 0，直接套 `num()` 会把「没填」误读成「关闭该判定」）。
  const quietValue = hb.min_quiet_minutes;
  const quietNum = typeof quietValue === 'number'
    ? quietValue
    : typeof quietValue === 'string' && quietValue.trim().length > 0
      ? Number(quietValue)
      : Number.NaN;
  const minQuietMinutes = Number.isFinite(quietNum) && quietNum >= 0 ? quietNum : DEFAULT_MIN_QUIET_MINUTES;
  // 2026-11-05（心跳人性化·阶段2）：生成模式。**只认 `'wake'`，其余（含缺省/非法）一律 legacy**
  //   —— 唤醒是灰度能力，配置写错绝不能默认开；e2e 的既有断言也依赖默认是 legacy。
  const generationMode: 'legacy' | 'wake' = hb.generation_mode === 'wake' ? 'wake' : 'legacy';
  // 2026-11-05（心跳人性化·阶段2）：wake 灰度白名单。非空 = 只有名单内的群走 wake；
  //   空/缺省 = 不限群（全部群统一按 generation_mode）。顺手过滤空白项并去重。
  const wakeFirstGroupsRaw = Array.isArray(hb.wake_first_groups) ? hb.wake_first_groups : [];
  const wakeFirstGroups = [...new Set(
    wakeFirstGroupsRaw.map((g) => String(g ?? '').trim()).filter((g) => g.length > 0),
  )];
  // 2026-11-04：心跳白名单（只让指定群参与心跳，避免未开通主动消息权限的群白烧模型调用）。
  //   —— 不配 / 空数组 → 不写入字段 → 「全部群参与」（向后兼容）。配了 → 只有名单内参与。
  const groupsRaw = Array.isArray(hb.enabled_groups) ? hb.enabled_groups : [];
  const enabledGroups = groupsRaw
    .map((g) => String(g ?? '').trim())
    .filter((g) => g.length > 0);
  // 2026-11-04：死群判定窗口（小时）可选。不配 → 不写字段 → 回落 2h（原行为）。
  //   ⚠️ `0` 是**合法值**（表示关闭死群判定），所以存在性判据用 `>= 0` 而不是 `> 0`。
  const deadRaw = Number(hb.dead_group_hours);
  const deadValid = Number.isFinite(deadRaw) && deadRaw >= 0;
  base.heartbeat_config = {
    interval_minutes: Math.max(1, num(hb.interval_minutes, base.heartbeat_config.interval_minutes)),
    jitter_minutes: Math.max(0, num(hb.jitter_minutes, base.heartbeat_config.jitter_minutes)),
    max_daily: Math.max(0, num(hb.max_daily, base.heartbeat_config.max_daily)),
    cooldown_hours: Math.max(0, num(hb.cooldown_hours, base.heartbeat_config.cooldown_hours)),
    // 2026-11-04：waiting 窗口可选（缺省 15 = 图纸默认）。
    // 不配时**不写入该字段**，由 heartbeat.resolveWaitingMinutes 回落 WAITING_MINUTES，
    // 保证「不配置 = 原行为」；配了才覆盖。
    ...(Number.isFinite(waitingRaw) && waitingRaw > 0
      ? { waiting_minutes: Math.max(1, Math.round(waitingRaw)) }
      : {}),
    ...(enabledGroups.length > 0 ? { enabled_groups: enabledGroups } : {}),
    // 死群窗口上限 720h（30 天）防手滑写成天文数字；0 = 关闭死群判定。
    ...(deadValid ? { dead_group_hours: Math.min(720, deadRaw) } : {}),
    // 2026-11-05 阶段1：群静默判定窗口（缺省/非法已在上方归一；`0` = 关闭该判定）。
    min_quiet_minutes: minQuietMinutes,
    // 2026-11-05 阶段2：生成模式（缺省/非法已在上方归一为 legacy）。
    generation_mode: generationMode,
    // 2026-11-05 阶段2：wake 灰度白名单；空/缺省**不写字段**（= 不限群，语义同 enabled_groups）。
    ...(wakeFirstGroups.length > 0 ? { wake_first_groups: wakeFirstGroups } : {}),
    heartbeatMaxTokens: Math.max(1, num(hb.heartbeatMaxTokens, base.heartbeat_config.heartbeatMaxTokens)),
    heartbeatTimeoutMs: Math.max(1, num(hb.heartbeatTimeoutMs, base.heartbeat_config.heartbeatTimeoutMs)),
  };

  const ex = isPlainObject(raw.extraction_config) ? raw.extraction_config : {};
  base.extraction_config = {
    max_messages_per_day: Math.max(1, num(ex.max_messages_per_day, base.extraction_config.max_messages_per_day)),
    extractionMaxTokens: Math.max(1, num(ex.extractionMaxTokens, base.extraction_config.extractionMaxTokens)),
    extractionTimeoutMs: Math.max(1, num(ex.extractionTimeoutMs, base.extraction_config.extractionTimeoutMs)),
    run_daily_at: normalizeHhMm(str(ex.run_daily_at, base.extraction_config.run_daily_at), base.extraction_config.run_daily_at, warnings),
  };

  const rd = isPlainObject(raw.reply_detection) ? raw.reply_detection : {};
  base.reply_detection = {
    window_minutes: Math.max(1, num(rd.window_minutes, base.reply_detection.window_minutes)),
    keywords: strArray(rd.keywords, base.reply_detection.keywords),
    question_regex: str(rd.question_regex, base.reply_detection.question_regex),
  };
  if (!regexValid(base.reply_detection.question_regex)) {
    warnings.push('[r4] reply_detection.question_regex 无法编译 → 回退默认正则');
    base.reply_detection.question_regex = DEFAULT_CONFIG.reply_detection.question_regex;
  }

  const mc = isPlainObject(raw.model_config) ? raw.model_config : {};
  base.model_config = {
    heartbeatModel: str(mc.heartbeatModel, base.model_config.heartbeatModel),
    extractionModel: str(mc.extractionModel, base.model_config.extractionModel),
  };

  const levels = isPlainObject(raw.relationship_levels) ? raw.relationship_levels : {};
  for (const level of LEVELS) {
    const label = String(levels[level] ?? '').trim();
    if (label) base.relationship_levels[level] = label;
  }

  const rc = isPlainObject(raw.relationship_config) ? raw.relationship_config : {};
  const initial = String(rc.initial_level ?? base.relationship_config.initial_level).trim().toUpperCase();
  base.relationship_config.initial_level = LEVELS.includes(initial as Level)
    ? (initial as Level)
    : base.relationship_config.initial_level;
  base.relationship_config.initial_score = clampScore(num(rc.initial_score, base.relationship_config.initial_score));
  const bounds = isPlainObject(rc.level_bounds) ? rc.level_bounds : {};
  for (const level of LEVELS) {
    const bound = isPlainObject(bounds[level]) ? bounds[level] : undefined;
    if (!bound) continue;
    const min = num(bound.minInclusive, base.relationship_config.level_bounds[level].minInclusive);
    const out: { minInclusive: number; maxExclusive?: number; maxInclusive?: number } = { minInclusive: min };
    if (Number.isFinite(Number(bound.maxExclusive))) out.maxExclusive = Number(bound.maxExclusive);
    if (Number.isFinite(Number(bound.maxInclusive))) out.maxInclusive = Number(bound.maxInclusive);
    if (out.maxExclusive === undefined && out.maxInclusive === undefined) {
      out.maxExclusive = base.relationship_config.level_bounds[level].maxExclusive;
      out.maxInclusive = base.relationship_config.level_bounds[level].maxInclusive;
    }
    base.relationship_config.level_bounds[level] = out;
  }
  base.relationship_config.decay_per_day = Math.max(0, num(rc.decay_per_day, base.relationship_config.decay_per_day));
  base.relationship_config.score_cooldown_minutes = Math.max(
    0,
    num(rc.score_cooldown_minutes, base.relationship_config.score_cooldown_minutes),
  );
  base.relationship_config.score_reply = num(rc.score_reply, base.relationship_config.score_reply);
  base.relationship_config.score_mention = num(rc.score_mention, base.relationship_config.score_mention);
  base.relationship_config.score_bot = num(rc.score_bot, base.relationship_config.score_bot);

  base.privacy_whitelist = strArray(raw.privacy_whitelist, base.privacy_whitelist);
  base.sensitive_words_path = str(raw.sensitive_words_path, base.sensitive_words_path);
  base.synonym_dict_path = str(raw.synonym_dict_path, base.synonym_dict_path);
  base.negative_words_path = str(raw.negative_words_path, base.negative_words_path);
  base.meme_dict_path = str(raw.meme_dict_path, base.meme_dict_path);

  // ★ 2026-11-04 新增：生活痕迹抽卡配置（保守合并，类型不对就用默认）。
  const life = isPlainObject(raw.life_events) ? raw.life_events : {};
  const fallbacksRaw = isPlainObject(life.fallbacks) ? life.fallbacks : {};
  const fallbacks: Record<string, string> = { ...base.life_events.fallbacks };
  for (const [key, value] of Object.entries(fallbacksRaw)) {
    const text = String(value ?? '').trim();
    if (text) fallbacks[key] = text;
  }
  base.life_events = {
    enabled: bool(life.enabled, base.life_events.enabled),
    // 路径允许配置覆盖；空值 → 保留默认（绝不因为写了个空串就变空路径）
    events_dir: str(life.events_dir, base.life_events.events_dir),
    max_event_chars: Math.max(1, num(life.max_event_chars, base.life_events.max_event_chars)),
    fallbacks,
  };

  /**
   * ★ 2026-11-05 参数解耦：熔断预算外置。
   *   · 不配 → 保留默认 1000（与旧行为一致）
   *   · 配了 → 用配置值，钳到 [200, 8000]（低于 200 会把画像全丢，高于 8000 失去熔断意义）
   */
  const inj = isPlainObject(raw.inject_config) ? raw.inject_config : {};
  base.inject_config = {
    fuse_budget: Math.min(8000, Math.max(200, num(inj.fuse_budget, base.inject_config.fuse_budget))),
  };

  /**
   * ★ 2026-11-05 R4.3：功能总开关。
   *   · 只有**显式 true** 才开；缺字段 / 非布尔 / 其它值 一律 false（最保守）。
   *   · 不写 warning（关闭是默认状态，刷 warning 没意义）。
   */
  const feat = isPlainObject(raw.features_config) ? raw.features_config : {};
  // ★ 2026-11-16 P1：自己的时间参数（数值钳制，防手滑写坏）
  {
    const ot = isPlainObject(raw.own_time_config) ? raw.own_time_config : {};
    base.own_time_config = {
      intervalMin: Math.min(1440, Math.max(10, num(ot.intervalMin, base.own_time_config.intervalMin))),
      dailyMax: Math.min(24, Math.max(1, num(ot.dailyMax, base.own_time_config.dailyMax))),
      quietFromHour: Math.min(23, Math.max(0, num(ot.quietFromHour, base.own_time_config.quietFromHour))),
      quietToHour: Math.min(23, Math.max(0, num(ot.quietToHour, base.own_time_config.quietToHour))),
    };
  }

  base.features_config = {
    memory_link: feat.memory_link === true,
    memory_tier: feat.memory_tier === true,
    milestones: feat.milestones === true,
    push: feat.push === true,
    ritual: feat.ritual === true,
    newcomer: feat.newcomer === true,
    // ★ 2026-11-09 R4.1：与 events_config 同一写法（num + min/max 钳制），不新增 helper
    newcomer_days: Math.min(30, Math.max(1, num(feat.newcomer_days, base.features_config.newcomer_days))),
    newcomer_max_messages: Math.min(100, Math.max(1, num(feat.newcomer_max_messages, base.features_config.newcomer_max_messages))),
    // ★ 2026-11-16「活人感」：默认值与 DEFAULT_CONFIG 保持一致
    //   P2/P4/P3/P5 默认开（零成本）；P1 默认关（唯一增加 LLM 调用）
    life_continuity: typeof feat.life_continuity === 'boolean' ? feat.life_continuity : true,
    absence_hint: typeof feat.absence_hint === 'boolean' ? feat.absence_hint : true,
    own_time: feat.own_time === true,
    mood_tint: typeof feat.mood_tint === 'boolean' ? feat.mood_tint : true,
    life_slot_fix: typeof feat.life_slot_fix === 'boolean' ? feat.life_slot_fix : true,
  };

  /**
   * ★ 2026-11-05 R4.3：事件召回参数。
   *
   * 每项都钳上界，防手滑写成天文数字把「窗口 30 天」「冷却 60 天」这种值写进去
   * （那会让功能直接失去意义）。上界按「群聊合理性」给，不是随便拍的：
   *   window 1~14 天 / cooldown 1~14 天 / expire 1~30 天 / max 1~100 / candidates 1~5。
   */
  const ev = isPlainObject(raw.events_config) ? raw.events_config : {};
  base.events_config = {
    window_days: Math.min(14, Math.max(1, num(ev.window_days, base.events_config.window_days))),
    cooldown_days: Math.min(14, Math.max(1, num(ev.cooldown_days, base.events_config.cooldown_days))),
    expire_days: Math.min(30, Math.max(1, num(ev.expire_days, base.events_config.expire_days))),
    max_per_user: Math.min(100, Math.max(1, num(ev.max_per_user, base.events_config.max_per_user))),
    max_candidates: Math.min(5, Math.max(1, num(ev.max_candidates, base.events_config.max_candidates))),
    model_judge: ev.model_judge === true,
    tau_days: Math.min(30, Math.max(1, num(ev.tau_days, base.events_config.tau_days))),
  };
  return { config: base, warnings };
}

function clampScore(n: number): number {
  return Math.max(-100, Math.min(100, Math.round(n)));
}

function regexValid(source: string): boolean {
  try {
    // eslint-disable-next-line no-new
    new RegExp(source, 'u');
    return true;
  } catch {
    return false;
  }
}

function normalizeHhMm(value: string, fallback: string, warnings: string[]): string {
  const m = /^(\d{1,2}):(\d{2})$/u.exec(value);
  if (!m) {
    warnings.push(`[r4] extraction_config.run_daily_at 格式非法（${value}）→ 回退 ${fallback}`);
    return fallback;
  }
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    warnings.push(`[r4] extraction_config.run_daily_at 越界（${value}）→ 回退 ${fallback}`);
    return fallback;
  }
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/**
 * 加载配置。永不抛错。
 * @param persona 人格 id（默认 `elysia`）。
 * @param root    数据根（默认由 `PERSONA_DATA_ROOT` / `~/.dsh` 决定）。
 */
export function loadConfig(persona = 'elysia', root = personaDataRoot()): ConfigLoadResult {
  const path = personaConfigPath(persona, root);
  const raw = readJsonSafe<unknown>(path);
  const { config, warnings } = mergeConfig(raw);
  // `null` 也算「没读到」：mergeConfig 会按缺失处理，这里同步标记 loaded=false。
  const loaded = isPlainObject(raw);
  if (!loaded) {
    warnings.push(`[r4] 未读到人格配置（${path}）→ 使用内置默认值（主聊天不受影响）`);
  }
  const backgroundEnabled = modelIdUsable(config.model_config.heartbeatModel)
    && modelIdUsable(config.model_config.extractionModel);
  if (!backgroundEnabled) {
    warnings.push('[r4] model_config 的模型 ID 为空/占位符 → 禁用后台心跳与提取任务（主聊天不受影响）');
  }
  return { config, warnings, path, loaded, backgroundEnabled };
}
