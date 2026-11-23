/**
 * 记忆联想 · 主入口（**组装层**）
 *
 * 把三个数据源拼成一段可注入的正文：
 *   ① 人物档案（最重要）
 *   ② 群档案
 *   ③ 最近事件
 *
 * 预算（2026-11-08 三轮审查后确定）：
 *   **220 字独立预算** —— 不挤占 `inject.ts` 的 `EXTRA_BUDGET`（140 字，已被子 4 段占满）。
 *
 * 分配：
 *   人物 100 / 群 50 / 事件 70（可配，见 config.ts）
 *
 * 纪律（`开发规则`）：
 *   · 无 IO 失败必须降级为空，绝不抛；
 *   · 无魔法数字，阈值全来自 config；
 *   · 所有诊断落盘（插件 logger 不进 engine.log）。
 */

import { formatRecall, clipText, type RecallItem } from './format.js';
import { PersonCardIndex, type MemoryServiceLike, type RecallLogger } from './person-card.js';
import { groupCardOf, recentEventsOf } from './group-card.js';

/** 记忆联想配置（全外置，见 config.ts）。 */
export interface MemoryRecallConfig {
  enabled: boolean;
  /** 总预算（字符）。默认 220。 */
  budgetChars: number;
  /** 人物档案上限。默认 100。 */
  personChars: number;
  /** 群档案上限。默认 50。 */
  groupChars: number;
  /** 最近事件上限。默认 70。 */
  eventsChars: number;
  /** 「最近」指多少天。默认 3。 */
  recentDays: number;
  /** 人物档案缓存 TTL（毫秒）。默认 5 分钟。 */
  cacheTtlMs: number;
  /** 最多扫几人档案。默认 50。 */
  maxPersonFiles: number;
  /** 最多取几条事件。默认 2。 */
  maxEvents: number;
}

export const MEMORY_RECALL_DEFAULTS: MemoryRecallConfig = {
  enabled: true,
  budgetChars: 280,
  personChars: 100,
  groupChars: 50,
  eventsChars: 70,
  recentDays: 3,
  cacheTtlMs: 5 * 60 * 1000,
  maxPersonFiles: 50,
  maxEvents: 2,
};

/** 组装输入。 */
export interface BuildRecallInput {
  /** 记忆服务（可能 undefined —— 服务未就绪时必须降级）。 */
  service: MemoryServiceLike | undefined;
  /** 记忆 scope（通常是 `{ type:'group', id:gid }`）。 */
  scope: unknown;
  /** 说话人 openid。空串 = 只注入群档案。 */
  userId: string;
  /** 当前时间（毫秒）。 */
  now: number;
  /** 配置。 */
  config: MemoryRecallConfig;
  /** 人物档案索引（**复用**，由调用方持有跨轮缓存）。 */
  personIndex?: PersonCardIndex;
  /** 日志。 */
  logger?: RecallLogger;
  /** 诊断回调（可选，测试可注入）。 */
  diag?: (event: string, data: Record<string, unknown>) => void;
}

/** 组装结果。 */
export interface BuildRecallResult {
  /** 注入正文；空串 = 不注入。 */
  text: string;
  /** 实际用掉字符数。 */
  used: number;
  /** 各部分是否命中（诊断用）。 */
  present: { person: boolean; group: boolean; events: number };
}

/**
 * 组装记忆联想注入文本。**任何失败都返回空串，绝不影响主链。**
 */
export function buildMemoryRecall(input: BuildRecallInput): BuildRecallResult {
  const empty: BuildRecallResult = { text: '', used: 0, present: { person: false, group: false, events: 0 } };
  const cfg = input?.config ?? MEMORY_RECALL_DEFAULTS;
  if (cfg.enabled === false) {
    input?.diag?.('recall:skip', { reason: 'disabled' });
    return empty;
  }
  if (!input?.service || typeof input.service.list !== 'function') {
    input?.diag?.('recall:skip', { reason: 'no-service' });
    return empty;
  }

  try {
    const items: RecallItem[] = [];
    const present = { person: false, group: false, events: 0 };

    // ① 人物档案
    const uid = String(input.userId ?? '').trim();
    if (uid) {
      try {
        const index = input.personIndex ?? new PersonCardIndex({
          cacheTtlMs: cfg.cacheTtlMs,
          cacheMaxEntries: 200,
          perItemChars: cfg.personChars,
          maxFiles: cfg.maxPersonFiles,
          logger: input.logger,
        });
        const summary = index.find(input.service, input.scope, uid, input.now);
        if (summary) {
          items.push({ kind: 'person', text: clipText(summary, cfg.personChars) });
          present.person = true;
        }
      } catch (err) {
        input.logger?.warn?.(`[memory-recall] 人物档案异常（已跳过）：${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // ② 群档案
    try {
      const g = groupCardOf(input.service, input.scope, cfg.groupChars, input.logger);
      if (g) {
        items.push({ kind: 'group', text: g });
        present.group = true;
      }
    } catch (err) {
      input.logger?.warn?.(`[memory-recall] 群档案异常（已跳过）：${err instanceof Error ? err.message : String(err)}`);
    }

    // ③ 最近事件
    try {
      const evs = recentEventsOf(
        input.service,
        input.scope,
        {
          days: cfg.recentDays,
          maxItems: cfg.maxEvents,
          perItemChars: Math.max(20, Math.floor(cfg.eventsChars / Math.max(1, cfg.maxEvents))),
          now: input.now,
        },
        input.logger,
      );
      for (const ev of evs) {
        items.push({ kind: 'event', text: ev.text });
      }
      present.events = evs.length;
    } catch (err) {
      input.logger?.warn?.(`[memory-recall] 事件异常（已跳过）：${err instanceof Error ? err.message : String(err)}`);
    }

    // ④ 按独立预算裁剪 + 拼装
    if (!items.length) {
      input.diag?.('recall:skip', { reason: 'no-items' });
      return empty;
    }
    const res = formatRecall(items, {
      totalChars: cfg.budgetChars,
      perItemChars: Math.max(cfg.personChars, cfg.groupChars, cfg.eventsChars),
    });

    // ★ 2026-11-15 增强（方案 A-Phase 1：观测埋点）
    //   原来只记「注入了多少字 + 三个布尔」，无法回答三个关键问题：
    //     ① 各数据源各出几条？（只有 1 条也算 hit，看不出单薄）
    //     ② 注入的具体内容是什么？（失败/幻觉排查时无从对照）
    //     ③ 是不是被预算截断了？（used 贴近 budget 时值得警惕）
    //   新增：sources 明细 / hash（内容指纹，可跨日志对照）/ budget/truncated。
    input.diag?.('recall:ok', {
      used: res.used,
      person: present.person,
      group: present.group,
      events: present.events,
      dropped: res.dropped.length,
      // 新增字段（只增不改，旧日志解析器不会受影响）
      sources: {
        person: present.person ? 1 : 0,
        group: present.group ? 1 : 0,
        events: Number(present.events) || 0,
      },
      hash: (() => {
        try {
          // 内容指纹：同一段注入内容得到同一个 8 位 hex，便于跨会话对照"是不是老重复那几句"
          let h = 0x811c9dc5;
          for (let i = 0; i < res.text.length; i++) {
            h ^= res.text.charCodeAt(i);
            h = Math.imul(h, 0x01000193) >>> 0;
          }
          return h.toString(16).padStart(8, '0');
        } catch { return ''; }
      })(),
      budget: cfg.budgetChars,
      truncated: res.used >= cfg.budgetChars,
    });

    return { text: res.text, used: res.used, present };
  } catch (err) {
    input?.diag?.('recall:fail', { err: String(err) });
    input?.logger?.warn?.(`[memory-recall] 组装异常（已降级为空）：${err instanceof Error ? err.message : String(err)}`);
    return empty;
  }
}
