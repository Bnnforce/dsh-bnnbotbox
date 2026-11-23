/**
 * events-recall — 旧事召回（R4.3 / F1）
 *
 * 批次 B：**完整实现**（阶段 A1 曾为骨架）。
 *
 * 设计要点（来自两轮评审）：
 *   · 只查【当前发言人】的 open 事件 —— 绝不跨用户
 *   · `groupId` 双重校验 —— 绝不跨群
 *   · 关键词是**召回门槛**（至少命中 1 个），type 相关词只加分、不单独触发
 *   · 时间衰减打分：`score = 命中强度 × exp(-Δt / τ)`，越近越优先
 *   · 排除冷却中的事件，最多 `max_candidates` 条里取最高分
 *   · 任何异常 → 返回 null（**不阻塞回复**）
 *
 * 关于 `RecallInput.random`：阶段 A 预留的测试注入点。当前规则是「取最高分」，
 * 不做随机抽样，因此该字段暂未使用（保留以兼容已锁定的接口）。
 */

import { DEFAULT_CONFIG } from './config.js';
import { readEventFile } from './events-store.js';
import type { EventRecord, EventsConfig, EventType, RecallHint } from './types.js';

/** 一天毫秒数（与配置单位一致）。 */
const DAY_MS = 86_400_000;

/** type 相关词每命中一个的加分（基础分：关键词每命中一个 +1）。 */
const TYPE_BONUS_PER_HIT = 0.5;

/**
 * 各事件类型的「相关词」。
 *
 * 纯本地规则，不调用模型（红线：不新增 LLM 调用）。
 * 这些词只参与加分，**不代替**事件关键词做召回门槛。
 */
const TYPE_WORDS: Record<EventType, readonly string[]> = {
  exam: ['考试', '备考', '复习', '成绩', '分数', '考场', '准考证', '补考', '挂科'],
  project: ['项目', '需求', '上线', '交付', '验收', '开发', '部署', '代码', '评审', '方案'],
  interview: ['面试', '简历', 'offer', '笔试', '招聘', '求职', 'hr'],
  trip: ['旅行', '旅游', '出差', '机票', '高铁', '酒店', '行程', '出发', '景点', '假期'],
  health: ['生病', '感冒', '发烧', '医院', '看病', '吃药', '体检', '输液', '不舒服', '住院'],
  move: ['搬家', '租房', '房子', '新家', '装修', '搬'],
  game: ['游戏', '上分', '排位', '开黑', '副本', '段位', '通关'],
  other: [],
};

export interface RecallInput {
  /** 当前群（跨群隔离必需）。 */
  groupId: string;
  /** 当前发言人（跨用户隔离必需）。 */
  userId: string;
  /** 已清洗的正文。 */
  text: string;
  now: number;
  config: EventsConfig;
  root: string;
  /** 测试注入。 */
  random?: () => number;
}

/** 统计 `words` 中有多少个（去重后）出现在正文里。含英文字母时忽略大小写。 */
function countHits(words: readonly string[], body: string): number {
  if (!body) return 0;
  const haystack = body.toLowerCase();
  const seen = new Set<string>();
  for (const raw of words) {
    const word = String(raw ?? '').trim();
    if (!word) continue;
    const key = word.toLowerCase();
    if (seen.has(key)) continue;
    if (haystack.includes(key)) seen.add(key);
  }
  return seen.size;
}

/** 配置兜底：非法值回落默认（配置加载层已做范围校验，这里只防运行时手搓 config）。 */
function daysOf(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return fallback;
  return value;
}

/**
 * 最新一次提及（`at` 最大）；没有提及链 → 回落 `createdAt`（用于时间衰减）。
 * 同一时间多条 → 取数组中靠后的一条（提及链按追加顺序存）。
 */
function latestMention(event: EventRecord): { at: number; text: string } {
  let at = event.createdAt;
  let text = '';
  for (const mention of event.mentions) {
    if (!Number.isFinite(mention.at) || mention.at < at) continue;
    at = mention.at;
    text = mention.text;
  }
  return { at, text };
}

/** 召回候选（内部形状）。 */
interface ScoredEvent {
  event: EventRecord;
  score: number;
  /** now - 最新提及时间（ms，已夹到 >= 0）。 */
  deltaT: number;
  /** 注入用摘要：最新提及文本，缺失则事件摘要。 */
  summary: string;
}

/**
 * 召回「可接可不接」的旧事。
 * @returns 最优一条；无合适候选 → `null`
 */
export function recallEvents(input: RecallInput): RecallHint | null {
  try {
    if (!input || typeof input !== 'object') return null;
    const userId = String(input.userId ?? '').trim();
    const groupId = String(input.groupId ?? '').trim();
    const body = String(input.text ?? '');
    const now = Number(input.now);
    if (!userId || !groupId || !Number.isFinite(now)) return null;

    const cfg = input.config ?? DEFAULT_CONFIG.events_config;
    const windowDays = daysOf(cfg.window_days, DEFAULT_CONFIG.events_config.window_days);
    const cooldownDays = daysOf(cfg.cooldown_days, DEFAULT_CONFIG.events_config.cooldown_days);
    const tauDays = daysOf(cfg.tau_days, DEFAULT_CONFIG.events_config.tau_days);
    const maxCandidates = daysOf(cfg.max_candidates, DEFAULT_CONFIG.events_config.max_candidates);

    const windowMs = windowDays * DAY_MS;
    const cooldownMs = cooldownDays * DAY_MS;
    const tauMs = tauDays * DAY_MS;

    const file = readEventFile(userId, input.root);
    const scored: ScoredEvent[] = [];

    for (const event of file.events) {
      // ── 红线：只查本人的、当前群的 open 事件（双重校验）──
      if (event.status !== 'open') continue;
      if (event.userId !== userId || event.groupId !== groupId) continue;

      // ── 时间窗口：按「创建时间」与「最近一次提及」的较晚者判定 ──
      //   ★ 2026-11-05 修（P1）：原先只看 createdAt，导致「4 天前创建、昨天又被提到」的
      //   open 事件永远进不了召回池，与"事件链"语义矛盾（mention 链越长越该召回）。
      //   现在：只要「最近一次提及」还在窗口内，就仍然能召回。
      if (!Number.isFinite(event.createdAt)) continue;
      const latest = latestMention(event);
      const lastTouchedAt = Math.max(event.createdAt, latest.at);
      if (now - lastTouchedAt > windowMs) continue;

      // ── 冷却：刚被引用过的事件这次不重复提 ──
      if (event.lastReferencedAt > 0 && now - event.lastReferencedAt < cooldownMs) continue;

      // ── 打分：关键词命中 × 1 + type 相关词加分（关键词是门槛）──
      const keywordHits = countHits(event.keywords, body);
      if (keywordHits <= 0) continue;
      const typeHits = countHits(TYPE_WORDS[event.type] ?? [], body);
      const baseScore = keywordHits + typeHits * TYPE_BONUS_PER_HIT;

      // ── 时间衰减：Δt 取最新提及时间（没有提及则用 createdAt）──
      const deltaT = Math.max(0, now - latest.at);
      const decay = tauMs > 0 ? Math.exp(-deltaT / tauMs) : 1;
      const score = baseScore * decay;
      if (!Number.isFinite(score) || score <= 0) continue;

      scored.push({
        event,
        score,
        deltaT,
        summary: latest.text || event.summary,
      });
    }

    if (scored.length === 0) return null;

    // 分数高优先；同分时最近提及优先；再同则按 id 稳定排序（避免输出抖动）。
    scored.sort((a, b) => (
      b.score - a.score
      || a.deltaT - b.deltaT
      || a.event.id.localeCompare(b.event.id)
    ));

    // max_candidates 限制候选池后取最高分一条（目前只返回 1 条，保留该参数语义）。
    const limit = Math.max(1, Math.floor(Number.isFinite(maxCandidates) ? maxCandidates : 1));
    const best = scored.slice(0, limit)[0];
    if (!best) return null;

    return {
      summary: best.summary,
      daysAgo: Math.round(best.deltaT / DAY_MS),
      eventId: best.event.id,
    };
  } catch {
    // 召回失败绝不阻塞回复。
    return null;
  }
}
