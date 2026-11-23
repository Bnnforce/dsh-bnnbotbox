/**
 * r4/host-types — R4 运行时的宿主契约类型
 *
 * 从 `r4/index.ts` 拆出（重构阶段 2 / 批次 C）。
 * 单独成文件的原因：`inbound.ts` 要引用 `R4Host`，若类型留在 `index.ts` 会造成
 * `index → inbound → index` 的循环引用。把**纯类型**抽出来，依赖方向变成单向：
 *
 *     host-types ← inbound / outbound / index
 *
 * `r4/index.ts` 仍然 `export type { R4Host, R4Handle }`，所以对外 API 面不变。
 */

import type { R4Logger } from './logger.js';

/** 宿主提供给 R4 的能力（全部可缺失 → 对应功能降级）。 */
export interface R4Host {
  /** 宿主 logger。 */
  logger?: R4Logger;
  /** qqbot 数据根（只读 msg-history）。 */
  qqbotDataRoot: string;
  /** 当前时间（测试注入）。 */
  now?: () => number;
  /** 随机（测试注入）。 */
  random?: () => number;
  /** 发消息到某群（心跳用）；缺失 = 心跳不发送。 */
  sendToGroup?: (groupId: string, text: string) => Promise<boolean>;
  /** 调模型（心跳生成/画像提取）；缺失 = 后台任务禁用。 */
  complete?: (input: { model: string; system: string; prompt: string; maxTokens: number; timeoutMs?: number }) => Promise<string>;
  /** 列出已知群（一般来自 msg-history 目录）。 */
  listGroups?: () => string[];
  /** session -> groupId 映射解析（宿主/扩展旁路文件）。 */
  resolveGroupId?: (sessionId: string) => string;
  /** 当前会话的发送者 openid（画像/关系计分用）。 */
  resolveSenderId?: (sessionId: string) => string;
  /** 读错题本摘要（旧 overlay，只读）。 */
  readOverlay?: (groupId: string, persona: string) => string;
  /** 读高光（旧 highlights，只读）。 */
  readHighlights?: (limit: number) => string;
  /**
   * ★ 2026-11-05 阶段 5：把执行器登记到**任务中心**（定时器全部集成到一处）。
   *
   * 由宿主（`src/index.ts`）实现：它知道扩展包/任务中心的位置，负责往
   * `globalThis[Symbol.for('dsh.taskcenter.registry.v1')]` 写登记项。
   * **缺失时**（旧宿主/单测）→ R4 退回自排 setTimeout，行为与之前一致。
   */
  registerTaskCenterExecutor?: (runKey: string, fn: () => Promise<unknown>) => void;
  /**
   * ★ 2026-11-08 记忆联想化（第一层「被动联想」）：按 (groupId, userId) 取回
   * 人物卡/群卡摘要，供 `assemble` 注入到 prompt 顶部（独立 220 字预算）。
   *
   * 由宿主（`src/index.ts`）实现：它才能 `ctx.get('qqMemory')` 拿到记忆插件的
   * 存储服务。**缺失时**（未装 dsh-qq-memory / 单测）→ 该段不注入，
   * 其余注入逻辑完全不变（失败关闭）。
   */
  getMemoryRecall?: (groupId: string, userId: string) => string;
}

/** `createR4Runtime` 的返回句柄。 */
export interface R4Handle {
  /** 停止定时器并解绑（幂等）。 */
  stop: () => void;
  /** 手工跑一次心跳（测试/运维）。 */
  tickHeartbeatOnce: () => Promise<unknown>;
  /** 手工跑一次提取。 */
  runExtractionOnce: () => Promise<unknown>;
  /** 让 `system-prompt/assemble` 钩子用的处理器（外部注册接入点，便于不依赖 cordis 单测）。 */
  assemble: (context: { agent?: { session?: { id?: string } }; [k: string]: unknown }) => string;
  /** 处理一条入站真人消息（关系计分 / 凌晨装死 / 临时冷淡）。返回是否放行。 */
  onMessage: (input: { groupId: string; userId: string; text: string; atBot?: boolean; quoteBot?: boolean }) => { allow: boolean; scored: boolean; kind?: string; coldApplied?: boolean; reason?: string; wokeText?: string };
  /**
   * 出站装饰（图纸 2.1 最后一条：cooldown 到期后第一次正常回复 → 强制小脾气前缀）。
   * 宿主在**真正发消息之前**调用；返回 `{ text, injected }`。
   */
  decorateOutgoing: (input: { groupId: string; text: string }) => { text: string; injected: boolean };
  /**
   * ★ 2026-11-18 R5.1：用「她这轮实际说了什么」推进情绪底色漂移。
   *
   * 背景：P3 的 advanceMoodTint 原来只挂在 heartbeat wake 通道，
   * 普通聊天回复不经过那里 ⇒ 实测 samples 永远 0，功能从未生效。
   * 现在由扩展包 outbound/50-mood-driver.mjs 在每次出站调用。
   *
   * @returns 是否真的推进了（配置关闭/文本太短返回 false）
   */
  advanceMood?: (replyText: string) => boolean;
  /**
   * ★ 2026-11-18 R5.1：这一轮该不该给她加「小脾气」前缀。
   * 内部读心跳状态 + 判断 cooldown 到期，异常返回 false。
   */
  shouldSulk?: (groupId: string) => boolean;
  /** ★ 2026-11-18 R5.1：清掉小脾气状态（加过前缀后必须调，防重复）。 */
  clearSulk?: (groupId: string) => void;
  /** 诊断快照。 */
  diagnostics: () => Record<string, unknown>;
  /**
   * ★ 2026-11-16 P1：「她自己的时间」挂载（默认配置关）。
   *
   * 为什么由宿主启动：提示要投进 agent 上下文，只有宿主有那能力
   * （心跳走 sendWakeToGroup → outbox → 扩展 caps.wakeTo，同一套）。
   *
   * @returns 停止函数（幂等）
   */
  /**
   * ★ 2026-11-16：把一条 wake 指令投递给扩展桥（心跳同款链路）。
   *   P1「自己的时间」复用它，避免另建通道导致再次踩「拿不到 manager」的坑。
   * @returns true = 已入队（不代表群里已看到）
   */
  sendWakeToGroup?: (payload: { id: string; groupId: string; text: string; wakePrompt?: string; at: number }) => Promise<boolean>;
  startOwnTime?: (opts: {
    groupId: string;
    deliver: (text: string) => Promise<boolean> | boolean;
    recentPast?: () => string[];
  }) => () => void;
}
