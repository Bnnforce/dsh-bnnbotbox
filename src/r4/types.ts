/**
 * R4.0「赛博生命体」共享类型契约。
 *
 * 纪律（施工图纸 0.1/0.2）：
 *  - 各模块只许从这里取类型，**不得互相 import**（编排由 r4/index 与 scheduler 完成）；
 *  - 字段名与 Schema 逐字一致（`heartbeat/{groupId}.json`、`relationships/{groupId}.json`、
 *    `profiles/index.json`、`profile-events/{userId}.json`、`state/extraction-state.json`）；
 *  - 不得自行增删字段。
 */

/** 关系等级：L0 高信任 / L1 熟悉 / L2 普通 / L3 低互动。 */
export type Level = 'L0' | 'L1' | 'L2' | 'L3';

/** 心跳状态枚举；`cold` 是独立布尔标记，不参与枚举。 */
export type HeartbeatStatus = 'normal' | 'waiting' | 'cooldown';

/** `state/heartbeat/{groupId}.json`。 */
export interface HeartbeatState {
  date: string;
  dailyCount: number;
  lastNonBotMessageAt: number;
  lastBotMessageAt: number;
  state: HeartbeatStatus;
  cold: boolean;
  coldSetAt: number;
  waitingUntil: number;
  cooldownUntil: number;
}

export const EMPTY_HEARTBEAT_STATE: HeartbeatState = {
  date: '',
  dailyCount: 0,
  lastNonBotMessageAt: 0,
  lastBotMessageAt: 0,
  state: 'normal',
  cold: false,
  coldSetAt: 0,
  waitingUntil: 0,
  cooldownUntil: 0,
};

/** 计分类型：`reply` 接梗 / `mention` 引用 bot / `bot` @bot。**不存在 `meme` 键。** */
export type ScoreKind = 'reply' | 'mention' | 'bot';

export const SCORE_KINDS: readonly ScoreKind[] = ['reply', 'mention', 'bot'];

/** `state/relationships/{groupId}.json` 里单个 userId 的记录。 */
export interface RelationshipEntry {
  level: Level;
  score: number;
  lastDecayAt: number;
  updatedAt: number;
  scoreCooldowns: Record<ScoreKind, number>;
  temporaryAttitude: string;
  temporaryAttitudeExpiresAt: number;
  /**
   * ★ 2026-11-05 R4.3（F3）：首次互动时间。
   *
   * 「认识 N 天」的事实来源。老数据没有这个字段 → 读取为 0，
   * `milestones` 会把首次观测时刻补上（所以老用户的 N 从启用日起算，会偏小）。
   */
  firstMetAt?: number;
  /** ★ 2026-11-05 R4.3（F3）：累计真人消息数，「聊过 N 次」的事实来源。 */
  messageCount?: number;
}

export function emptyRelationshipEntry(level: Level, score: number): RelationshipEntry {
  return {
    level,
    score,
    lastDecayAt: 0,
    updatedAt: 0,
    scoreCooldowns: { reply: 0, mention: 0, bot: 0 },
    temporaryAttitude: '',
    temporaryAttitudeExpiresAt: 0,
  };
}

/** `state/relationships/{groupId}.json` 整文件：userId -> 记录。 */
export type RelationshipsFile = Record<string, RelationshipEntry>;

/**
 * ★ 2026-11-05 R4.3：`lastMentionedTags` 的单条值。
 *
 * 旧格式是**裸数字**（时间戳），新格式带**提及次数**（F2 的「提及冷却 + 措辞分级」要用）。
 * 读取侧必须同时兼容两种形态（见 `profile-store.tagMentionStats`）。
 */
export interface TagMentionStat {
  at: number;
  count: number;
}

/** `profiles/index.json` 里单个 userId 的记录。 */
export interface ProfileIndexEntry {
  /** 旧：`number`（时间戳）；新：`{ at, count }`。**两种都可能存在**。 */
  lastMentionedTags: Record<string, number | TagMentionStat>;
  coldStartUntil: number;
}

/** `profiles/index.json` 整文件。 */
export type ProfileIndex = Record<string, ProfileIndexEntry>;

/**
 * `state/profile-events/{userId}.json` 单条事件。
 *
 * ★ 2026-11-04 双层记忆（主人需求）：
 *  - `permanent: true`  = **永久标签**（性格/偏好/梗/语气）→ 永不淘汰、直接进画像正文；
 *  - `permanent: false` = **临时事件**（琐事/今天干了什么）→ 近 7 天后自动忽略、不进正文。
 *  - 字段**可选**：磁盘上已有的老数据没有这个键时按 `false`（临时）处理，向后兼容。
 */
export interface ProfileEvent {
  tag: string;
  category: string;
  timestamps: number[];
  /** 是否永久标签（缺省 = false，即临时事件）。 */
  permanent?: boolean;
}

/** `state/profile-events/{userId}.json` 整文件。 */
export interface ProfileEventsFile {
  events: ProfileEvent[];
}

/**
 * 模型提取画像时的单条 tag 输出。
 *
 * ★ 2026-11-04：模型**必须**给出 `permanent`（true=稳定特征 / false=生活琐事）。
 * 模型漏给或给了非布尔值 → 一律按 `false`（保守，宁可少记）。
 */
export interface ExtractedTag {
  tag: string;
  category: string;
  /** 是否永久标签。 */
  permanent: boolean;
}

/** `state/extraction-state.json`。 */
export interface ExtractionState {
  lastRunDate: string;
}

/** 模型路由（与 `model_config` 同名字段一致）。 */
export interface ModelConfig {
  heartbeatModel: string;
  extractionModel: string;
}

/** 时间与作息配置。 */
export interface TimeConfig {
  sleep_start: string;
  sleep_end: string;
  wake_probability: number;
}

/** 心跳配置。 */
export interface HeartbeatConfig {
  interval_minutes: number;
  jitter_minutes: number;
  max_daily: number;
  cooldown_hours: number;
  /**
   * waiting 等待窗口（分钟）。图纸 2.1 固定 15，**可选**：缺省=15。
   * 2026-11-04 新增：原先是硬编码常量，测试时无法调短
   * （interval 调成 5 分钟也没用，每轮仍要等满 15 分钟 waiting 才推进状态机）。
   */
  waiting_minutes?: number;
  /**
   * **心跳白名单**（群号数组）。2026-11-04 新增。
   *
   * 缺省/空数组 = 全部群都参与（向后兼容，行为与之前一致）。
   * 非空 = **只有名单内的群**才走心跳（其余群在 tick 里直接跳过，
   * **不生成内容、不调模型**——避免 QQ 主动消息权限没开的群白白消耗模型调用）。
   *
   * 典型用法：只给「已开通主动消息权限」的群开心跳。
   */
  enabled_groups?: string[];
  /**
   * **死群判定窗口**（小时）。2026-11-04 新增，原先是硬编码常量。
   *
   * 判据：`最近一条非 bot 消息` 距今超过这个窗口 → 视为死群，**跳过心跳不打扰**。
   * 缺省 = 2（与之前行为一致）。
   *
   * 为什么做成配置：低活跃度的群（一天只说几句话）在 2 小时口径下永远被判死群，
   * 心跳一次都发不出去。主人 2026-11-04 要求把口径放宽到 **24 小时（1 天）**。
   * 设成 `0` 表示**关闭死群判定**（任何静默时长都照发，慎用）。
   */
  dead_group_hours?: number;
  /**
   * ★ 2026-11-05（心跳人性化·阶段1）：群最近 N 分钟内**有人说过话** → 跳过心跳（不插嘴）。
   *
   * 为什么：旧状态机只看自己的 waiting/cooldown，不看群里刚有没有人说话，
   * 于是会在别人正聊天时硬插一句总结（20:05 事故：群 11 分 45 秒前还有人说话）。
   *
   * 缺省 = 20；`0` = 关闭该判定（回到旧行为）。
   * 注意：它**只保证不插嘴**，不保证 wake 能成功（会话是否还活着取决于有没有被 @ dispatch）。
   */
  min_quiet_minutes?: number;
  /**
   * ★ 2026-11-05（心跳人性化·阶段2）：心跳生成模式。
   *
   * - `'legacy'`（缺省/非法值）：现状 —— `host.complete` 裸生成 + 三条发送通道。**必须保持缺省**，
   *   否则 `test-r4/r4-e2e.mjs` 里基于 `DEFAULT_CONFIG` 的断言（`sentToGroup` 被调用）会失败。
   * - `'wake'`：不再生成文本，改为拼 wake 指令写入 outbox，由扩展桥用 `caps.wakeTo` 唤醒
   *   agent 用**完整人格**说话；agent 可选择 `reply_gate` 沉默。
   */
  generation_mode?: 'legacy' | 'wake';
  /**
   * ★ 2026-11-05（心跳人性化·阶段2）：wake 模式的**灰度白名单**。
   *
   * `generation_mode` 是 `heartbeat_config` 的全局字段，做不到"只让某个群先试"。
   * 非空 = 只有名单内的群走 wake；名单外的群仍走 legacy。缺省/空 = 全部群按 `generation_mode`。
   */
  wake_first_groups?: string[];
  heartbeatMaxTokens: number;
  heartbeatTimeoutMs: number;
}

/** 每日画像提取配置。 */
export interface ExtractionConfig {
  max_messages_per_day: number;
  extractionMaxTokens: number;
  extractionTimeoutMs: number;
  run_daily_at: string;
}

/** 「有人回复」判定配置。 */
export interface ReplyDetection {
  window_minutes: number;
  keywords: string[];
  question_regex: string;
}

/** 关系等级文案。 */
export type RelationshipLevels = Record<Level, string>;

/** 半开区间；L0 用 `maxInclusive`。 */
export interface LevelBound {
  minInclusive: number;
  maxExclusive?: number;
  maxInclusive?: number;
}

/** 关系网配置。 */
export interface RelationshipConfig {
  initial_level: Level;
  initial_score: number;
  level_bounds: Record<Level, LevelBound>;
  decay_per_day: number;
  score_cooldown_minutes: number;
  score_reply: number;
  score_mention: number;
  score_bot: number;
}

/**
 * ★ 2026-11-04 新增：分时段「生活痕迹」抽卡配置。
 *
 * 灵感来源（方案 §1-§3）：让角色有真实的"生活轨迹"，按四个时段从外部文本库
 * 随机抽一条隐藏事件作为内心背景板，**只隐性流露、绝不主动报备**。
 *
 * 纪律（开发规则四.1）：四段起止时间、兜底文案、截断长度**全部外置**，
 * 代码里不得出现魔法数字。`eventsDir` 也允许覆盖（不写死绝对路径）。
 */
export interface LifeEventsConfig {
  /** 总开关（默认 true）。关掉 = 完全不读文件、不抽卡、不注入。 */
  enabled: boolean;
  /**
   * 事件库目录（含 late_night.md / morning.md / afternoon.md / evening.md）。
   * 默认值由 `DEFAULT_CONFIG` 给出；此处允许配置覆盖，便于迁移设备。
   */
  events_dir: string;
  /** 单条事件最大字符数（超出截断 + 省略号），防有人写长句撑爆 prompt。 */
  max_event_chars: number;
  /**
   * 每个时段的**兜底文案**（文件缺失/为空/读不了时用它）。
   * 键必须是 `late_night` / `morning` / `afternoon` / `evening`。
   */
  fallbacks: Record<string, string>;
}

/**
 * ★ 2026-11-05 R4.3 新增：**功能总开关**。
 *
 * 安全原则（主人要求「最安全、最不容易出问题」）：
 *   **全部默认 false** —— 部署后行为与加这些代码之前**完全一致**。
 *   验证通过后再逐个打开，任何一项出问题都能单独关掉。
 */
export interface FeaturesConfig {
  /** F1 记忆关联：她说的话能接住几天前的旧事。 */
  memory_link: boolean;
  /** F2 记忆表达分级：提及冷却 + 措辞分级（不做遗忘）。 */
  memory_tier: boolean;
  /** F3 关系里程碑：只产出「可引用的关系事实」，不做等级播报。 */
  milestones: boolean;
  /** F4 对话推进：答完可自然反问。 */
  push: boolean;
  /** F5 作息仪式：深夜困意 / 清晨刚醒。 */
  ritual: boolean;
  /**
   * ★ 2026-11-09 R4.1：**新人识别**（这个人刚来，别装熟）。
   *
   * 判据纯本地（关系文件的 `firstMetAt` + `messageCount`），零 LLM、零新增 IO。
   * 命中后注入一段独立的语气约束（走独立预算 `NEWCOMER_BUDGET`，不挤占 140 字调味料）。
   */
  newcomer: boolean;
  /** ★ 2026-11-09：认识不满几天算新人（默认 3，与里程碑冷启动门槛一致）。 */
  newcomer_days: number;
  /** ★ 2026-11-09：累计发言少于几条算新人（老用户 firstMetAt 被补成"首次观测"时的兜底）。 */
  newcomer_max_messages: number;

  // ───────────────────────────────────────────────────────────────────────
  // ★ 2026-11-16「活人感」五功能开关（每个可独立关，关闭 = 零开销）
  // ───────────────────────────────────────────────────────────────────────

  /** P2 生活连续性：跨天接续（前几天的事会被记住）。 */
  life_continuity: boolean;
  /** P4 好久没见：超过 N 天没互动的人，可自然提一句。 */
  absence_hint: boolean;
  /**
   * P1 自己的时间：静默唤醒（**默认关闭**）。
   *
   * ⚠️ 这是唯一会**增加 LLM 调用**的功能（每次唤醒 1 次，一天最多 4 次）。
   * 关闭时零开销：不建定时器、不读盘、不记日志。
   */
  own_time: boolean;
  /** P3 情绪底色：慢漂移的无数字情绪提示。 */
  mood_tint: boolean;
  /** P5 作息修正：装死窗口（02:00-06:00）不抽生活素材。 */
  life_slot_fix: boolean;
}

/** ★ 2026-11-16 P1：自己的时间参数（可调，改配置即生效）。 */
export interface OwnTimeConfigShape {
  /** 两次唤醒最小间隔（分钟），默认 150 = 2.5h。 */
  intervalMin: number;
  /** 每日上限（次），默认 4。 */
  dailyMax: number;
  /** 不打扰时段起（小时，默认 2 = 02:00）。 */
  quietFromHour: number;
  /** 不打扰时段止（小时，默认 6 = 06:00）。 */
  quietToHour: number;
}

/** ★ R4.3：事件类型（召回与闭环按它做类型匹配）。 */
export type EventType = 'exam' | 'project' | 'interview' | 'trip' | 'health' | 'move' | 'game' | 'other';

/**
 * ★ R4.3 F1：**结构化事件**（记忆关联的核心实体）。
 *
 * 为什么不是关键词：关键词会跨用户串记忆、同词不同事、误触发。
 * 所以事件是**独立实体**：有 id、归属（user + group）、类型、摘要、状态、提及链。
 */
export interface EventRecord {
  /** `evt_<YYYYMMDD>_<时间戳后4位>_<随机2位>`，冷却与闭环都按它，不按关键词。 */
  id: string;
  /** 归属用户。 */
  userId: string;
  /**
   * ★ 归属群 —— **跨群隔离的关键**。
   * 召回时必须 `event.groupId === 当前群 && event.userId === 当前发言人`，缺一不可。
   */
  groupId: string;
  type: EventType;
  keywords: string[];
  /** 注入用摘要，≤40 字，只描述事实。 */
  summary: string;
  /** 提及链：每次提及追加，注入取**最新**一条（追踪进展）。 */
  mentions: Array<{ at: number; text: string }>;
  status: 'open' | 'done' | 'expired';
  createdAt: number;
  updatedAt: number;
  /** 闭环依据（done 时填，诊断用）。 */
  closeWhy?: string;
  /** F2 冷却：上次被注入引用的时间（0 = 从未）。 */
  lastReferencedAt: number;
}

/** `state/events/{userId}.json` 整文件。 */
export interface EventFile {
  version: number;
  userId: string;
  events: EventRecord[];
}

/**
 * ★ R4.3：事件召回参数。
 *
 * ⚠️ 数值按「本群实际对话密度」定（主人确认「往小调」）：
 *   群聊稀疏，窗口太长 = 功能永远等不到触发 = 空转。
 */
export interface EventsConfig {
  /** 召回时间窗口（天）。默认 3。 */
  window_days: number;
  /** 同一事件被注入后的冷却（天）。默认 2。 */
  cooldown_days: number;
  /** 未闭环事件的过期（天）。默认 4。 */
  expire_days: number;
  /** 每用户事件上限（超出淘汰最旧）。默认 30。 */
  max_per_user: number;
  /** 单次召回最多候选数。默认 3。 */
  max_candidates: number;
  /** 是否启用轻量模型二次判断（默认 false：只用本地规则）。 */
  model_judge: boolean;
  /** 时间衰减常数 τ（天）：`score = 命中 × exp(-Δt/τ)`。默认 3。 */
  tau_days: number;
}

/** ★ R4.3 F1：召回结果（供注入层渲染，**不暴露内部记录**）。 */
export interface RecallHint {
  summary: string;
  /** 距今多少天。 */
  daysAgo: number;
  eventId: string;
}

/** ★ R4.3 F3：关系事实（只做「可引用事实」，不做等级播报）。 */
export interface MilestoneFact {
  kind: 'first_topic' | 'days_known' | 'message_count';
  text: string;
  at: number;
}

/** `persona-configs/elysia.json` 全量配置（TypeScript 形状）。 */
export interface ElysiaConfig {
  name: string;
  timezone: string;
  useLegacyAffinity: boolean;
  time_config: TimeConfig;
  heartbeat_config: HeartbeatConfig;
  extraction_config: ExtractionConfig;
  reply_detection: ReplyDetection;
  model_config: ModelConfig;
  relationship_levels: RelationshipLevels;
  relationship_config: RelationshipConfig;
  privacy_whitelist: string[];
  sensitive_words_path: string;
  synonym_dict_path: string;
  negative_words_path: string;
  meme_dict_path: string;
  /** ★ 2026-11-04 新增：生活痕迹抽卡。 */
  life_events: LifeEventsConfig;
  /**
   * ★ 2026-11-05 新增：**注入熔断参数外置**（审查标准「参数解耦」项）。
   *
   * 原先 `FUSE_BUDGET = 1000` 硬编码在 `fuse.ts` —— 属审查标准点名要消灭的"魔法数字"。
   * 现在外置到 `persona-configs/elysia.json`，可随时调、不用改代码。
   * 缺省不配 → 回落 `FUSE_BUDGET`（行为与之前完全一致）。
   */
  inject_config: InjectConfig;
  /**
   * ★ 2026-11-05 R4.3 新增：功能总开关（全部默认 false = 行为与之前完全一致）。
   */
  features_config: FeaturesConfig;
  /** ★ 2026-11-05 R4.3 新增：事件召回参数。 */
  events_config: EventsConfig;
  /** ★ 2026-11-16 P1：自己的时间参数。 */
  own_time_config: OwnTimeConfigShape;
}

/** 注入层参数（2026-11-05 参数解耦：从 fuse.ts 的硬编码提取）。 */
export interface InjectConfig {
  /**
   * 熔断预算（字符）。参与熔断的段总和超过它就按既定顺序丢弃。
   *
   * **高光与记忆法则不参与熔断**（宪法级，不随预算变化）。
   * 缺省 1000：
   *   · 上调 → 更多动态内容进上下文（更"记得住"，但每轮成本更高）
   *   · 下调 → 更省，但更容易丢画像/琐事
   */
  fuse_budget: number;
}

/** 本地字典（相对 `PERSONA_DATA_ROOT` 的文件；缺失即降级）。 */
export interface Dictionaries {
  sensitiveWords: string[];
  /** 归一化用：alias -> canonical。 */
  synonyms: Record<string, string>;
  negativeWords: string[];
  memes: string[];
  /** 缺失字典的名字（诊断用，不含文件内容）。 */
  missing: string[];
}

/** 一次配置加载的结果：有默认值兜底，永不抛错。 */
export interface ConfigLoadResult {
  config: ElysiaConfig;
  /** 降级/回退说明（给 logger.warn 用）。 */
  warnings: string[];
  /** 本次实际读取的配置文件绝对路径（不存在也算，便于诊断）。 */
  path: string;
  /** 配置是否真的从磁盘读到（false = 全默认）。 */
  loaded: boolean;
  /** 后台心跳/提取是否可用（模型 ID 为占位/空 → false）。 */
  backgroundEnabled: boolean;
}

/** 一条“取最近消息”的入参（供画像/心跳共用；不含图片）。 */
export interface RecentlyMessage {
  /** 发送者 openid（机器人自己 = 'self'）。 */
  senderId: string;
  /** 昵称（可选）。 */
  senderName?: string;
  /** 正文（已剥掉插件注入块）。 */
  text: string;
  /** 毫秒时间戳。 */
  at: number;
  /** 是否机器人自己发的。 */
  self: boolean;
  /** QQ message_id（可能为空）。 */
  msgId?: string;
  /**
   * 原始正文里出现过的 `<@openid>` 列表（**未清洗**，2026-11-03 新增）。
   * `@bot` 判定（图纸 2.2 的 A 条件）用它，不能拿清洗后的 text（`<@…>` 已被剥掉）。
   */
  mentioned?: string[];
  /** 是否出现 `<@all>`（@全体，不算 @bot）。 */
  mentionAll?: boolean;
  /** 本条是否 @ 了 bot（由调度层结合 bot openid 计算，采样层不知道 bot 是谁）。 */
  mentionedBot?: boolean;
  /** 本条是否引用了 bot 的消息（由宿主/外部结构体提供，采样层默认为 false）。 */
  quoteOfSelf?: boolean;
}
