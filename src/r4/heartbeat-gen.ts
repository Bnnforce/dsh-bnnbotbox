/**
 * R4.0 模块二配套：心跳内容生成（LLM 侧）。
 *
 * 图纸 2.4「生成」：
 *  - 取最近 20 条非 bot 消息；
 *  - 本地负面词命中 → Prompt 明确「不诊断、不追问健康隐私、不调侃」，
 *    **仅允许 `[人际关心]`**，禁止 `[冷场救援]` / `[话题共鸣]`；
 *  - 否则调用 `heartbeatModel`，判定 `[冷场救援]` / `[话题共鸣]` / `[人际关心]` 并生成内容；
 *  - 限制 `heartbeatMaxTokens`，超时 `heartbeatTimeoutMs` 或空返回 → 跳过、不重试、不计数、不进 `waiting`。
 *
 * 负面词判定：**仅匹配本地 `negative_words.json`**，与隐私敏感词表独立。
 */

import type { RecentlyMessage } from './types.js';
import { zonedTime } from './time.js';

/** 三种心跳标签（图纸 2.4）。 */
export type HeartbeatTag = '冷场救援' | '话题共鸣' | '人际关心';

export const HEARTBEAT_TAGS: readonly HeartbeatTag[] = ['冷场救援', '话题共鸣', '人际关心'];

/** 生成结果。 */
export interface HeartbeatGeneration {
  ok: boolean;
  /** 判定标签（解析失败时为 undefined）。 */
  tag?: HeartbeatTag;
  /** 正文（已剥掉标签前缀）。 */
  text: string;
  /** 跳过原因（ok=false 时）。 */
  reason?: string;
}

/** 生产 Prompt 用的系统指令（**图纸约束逐字落进 prompt**，不自由发挥）。 */
export const HEARTBEAT_SYSTEM = [
  '你在给一个 QQ 群写一条「主动开口」的短消息，语气必须贴合当前人格。',
  '只输出一条可直接发到群里的消息正文，不要解释、不要列举、不要自称在写心跳、不要输出任何标签之外的元信息。',
  '长度要短：像随口说的一句话，最多两句。',
  '禁止：诊断他人身体或心理状况、追问健康/隐私、调侃病痛、说教、长篇大论、客服腔。',
].join('\n');

/** 构造用户侧 Prompt。 */
export function buildHeartbeatPrompt(input: {
  messages: RecentlyMessage[];
  negativeHit: string | null;
  maxMessages?: number;
}): string {
  const maxMessages = Math.max(1, input.maxMessages ?? 20);
  const recent = input.messages
    .filter((m) => !m.self)
    .slice(-maxMessages)
    .map((m) => `${m.senderName || m.senderId}: ${m.text}`);
  const chatBlock = recent.length > 0 ? recent.join('\n') : '（这个群最近很安静，没有可参考的对话）';

  if (input.negativeHit) {
    return [
      '【本群最近对话（仅作语感与话题参考）】',
      chatBlock,
      '',
      '【本轮特别约束】',
      `本群最近出现让人担心的内容（命中本地负面词「${input.negativeHit}」）。`,
      '这一条只允许写成「人际关心」：轻轻关心一句，点到为止。',
      '明确禁止：诊断、追问健康或隐私细节、调侃、冷场救援式找话题、话题共鸣式接梗。',
      '不要提出建议、不要列举做法、不要说「你要多休息」这类说教。',
      '',
      '只输出一条消息正文，不要写标签。',
    ].join('\n');
  }

  return [
    '【本群最近对话（仅作语感与话题参考）】',
    chatBlock,
    '',
    '【本轮任务】',
    // ⚠️ 2026-11-07 说明：这是 **legacy 函数**（`buildHeartbeatPrompt`），
    //   实际生产路径已改用 `buildWakePrompt`（新的、不含三分类的那种）。
    //   本函数只为「legacy 回归测试」保留，**行为严禁改动**（测试断言含「冷场救援」）。
    //   「冷场救援」职能已被 `life-stream`（碎片生活流）接管，
    //   但那是新路径的事，与这个历史函数无关 —— 不要在这里删字。
    '从下面三种里判断这一条最该是哪一种，然后按那种方式写一句话：',
    '- 冷场救援：群里安静太久，主动挑一个轻松话题或问一句在忙什么；',
    '- 话题共鸣：大家正在聊的事，你接一句有共鸣的话；',
    '- 人际关心：有人状态不好，你关心一句。',
    '',
    '只输出一条消息正文，不要写标签、不要说明你选了哪种。',
  ].join('\n');
}

/** 从模型输出里剥掉可能出现的标签前缀（`[冷场救援]` 等），并识别标签。 */
export function parseHeartbeatOutput(raw: string, allowedTags: readonly HeartbeatTag[] = HEARTBEAT_TAGS): { tag?: HeartbeatTag; text: string } {
  let text = String(raw ?? '').trim();
  let tag: HeartbeatTag | undefined;
  for (const candidate of allowedTags) {
    const patterns = [
      new RegExp(`^\\s*[\\[【(（]?${candidate}[\\]】)）]?\\s*[：:，,。.、\\-—]?\\s*`, 'u'),
    ];
    for (const re of patterns) {
      if (re.test(text)) {
        tag = candidate;
        text = text.replace(re, '');
        break;
      }
    }
    if (tag) break;
  }
  // 去掉整体包裹的引号
  text = text.replace(/^["“'‘]+/u, '').replace(/["”'’]+$/u, '').trim();
  return { tag, text };
}

/** 判定结果是否可用：非空、不是把标签唯一内容、不超长度上限。 */
export function isUsableHeartbeatText(text: string, maxChars = 120): boolean {
  const t = String(text ?? '').trim();
  if (!t) return false;
  const chars = [...t];
  if (chars.length > maxChars) return false;
  if (HEARTBEAT_TAGS.some((tag) => t === tag || t === `[${tag}]` || t === `【${tag}】`)) return false;
  return true;
}

/** 带超时的异步包装（图纸：超时或空返回 → 跳过、不重试）。 */
export async function withTimeout<T>(task: Promise<T>, timeoutMs: number): Promise<{ timedOut: boolean; value?: T }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ timedOut: true }>((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), Math.max(1, timeoutMs));
    timer.unref?.();
  });
  try {
    const result = await Promise.race([
      task.then((value) => ({ timedOut: false as const, value })),
      timeout,
    ]);
    return result.timedOut ? { timedOut: true } : { timedOut: false, value: result.value };
  } catch {
    return { timedOut: false };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 2026-11-05（心跳人性化·阶段 2）：wake 模式
 *
 * 背景：2026-11-05 20:05 的心跳发出「你们俩这是被同一件事坑了吧哈哈」，被群友
 * 说是人机。复盘真实台账发现：模型没幻觉（那两个人确实对同一张图说了同一句话），
 * 问题是 ① 她在别人正聊天时硬插嘴 ② 喂进去的只有 4 行裸文本（引用/图/@ 全被剥掉）。
 *
 * 所以 wake 模式换一种打法：**不给摘要，把"看群 + 决定说不说"的权力交还给 agent**。
 *   - 用 `group_history` 工具看真实的最后 10 条（带引用、图、@）；
 *   - 有话就接那一句；没话就调 `reply_gate(false)` 让整轮静默终止（群里看不到任何东西）。
 *
 * 人格不写在这里 —— agent 回合自带 system prompt（灵魂锚点 + 群语感 + 时间），
 * 这里只补它不知道的三件事：① 这是内部提示；② 现在的时间状态；③ 这次开口的边界。
 * ═══════════════════════════════════════════════════════════════════════════ */

/**
 * wake 注入消息的**首行标记**。
 *
 * 两个用途，必须是同一个常量：
 *  ① `buildWakePrompt()` 生成的指令首行；
 *  ② 入站防污染（`review-collector.ts` 第一道 / `r4/inbound.ts` 第二道）据此识别
 *     「这不是真人发言」—— `injectToPeer` 用的是 `source.kind='user'`，不拦会被当成
 *     群友说话，污染关系计分 / 高光 / 错题本 / 事件召回。
 *
 * ⚠️ **禁止在任何地方硬编码这个字符串**。方案第一版就是因为 prompt 写
 *    「【心跳提示·插件】」而守卫写「【心跳·内部提示】」，两边永远对不上。
 */
export const HEARTBEAT_WAKE_MARKER = '【你看了一眼群】';

/** `buildWakePrompt()` 的入参。时间单位均为毫秒时间戳（0 = 未知）。 */
export interface WakePromptInput {
  /** 当前时间戳。 */
  now: number;
  /** 她上次在这个群说话的时间戳（heartbeat state 的 `lastBotMessageAt`）。 */
  lastBotMessageAt: number;
  /** 群里最近一条**真人**消息时间戳（heartbeat state 的 `lastNonBotMessageAt`）。 */
  lastNonBotMessageAt: number;
  /** 命中本地负面词时传词，走"轻轻关心"分支；否则不传。 */
  negativeHit?: string | null;
}

/** 时间戳 → `HH:mm`（走模块一的上海时区）；非法/0 → 空串。 */
function hhmm(ms: number): string {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '';
  try {
    const t = zonedTime(n);
    return `${String(t.hour).padStart(2, '0')}:${String(t.minute).padStart(2, '0')}`;
  } catch {
    return '';
  }
}

/** 毫秒差 → 「刚刚 / N 分钟前 / N 小时前」；非法 → 空串。 */
function agoText(deltaMs: number): string {
  const n = Number(deltaMs);
  if (!Number.isFinite(n) || n < 0) return '';
  const minutes = Math.round(n / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  return `${hours} 小时前`;
}

/**
 * 构造 wake 指令（喂给被唤醒的 agent 回合）。
 *
 * 与旧 `buildHeartbeatPrompt()` 的本质区别：
 *  | | 旧 | 新 |
 *  |---|---|---|
 *  | 人格 | "语气必须贴合当前人格"（空话，且没人格内容） | **不提**，agent 自带 |
 *  | 框架 | 三分类器（冷场救援/话题共鸣/人际关心）→ 套模板 | 「先看群，再决定接不接」 |
 *  | 上下文 | 20 行 `昵称: 正文`（剥掉引用/图/@） | 不给摘要，让她自己调 `group_history` 看真的 |
 *  | 沉默 | 不是选项（prompt 明说"说一两句"） | **`reply_gate(false)` 合法收场** |
 *  | 反人机 | 无 | 正面形状：「只对一个人说」「落在他说的具体东西上」 |
 */
export function buildWakePrompt(input: WakePromptInput): string {
  const now = Number(input?.now) || 0;
  const lastBot = Number(input?.lastBotMessageAt) || 0;
  const lastNonBot = Number(input?.lastNonBotMessageAt) || 0;

  const blocks: string[] = [];

  // ① 首行标记（入站守卫据此识别，**不可去掉、不可改写**）
  blocks.push(HEARTBEAT_WAKE_MARKER);

  // ② 时间状态：只给"现在 / 她上次说话 / 群里最后一条多久前"。
  //    **刻意不给聊天摘要** —— 摘要丢引用/图/@，正是 20:05 那次失败的根因。
  const nowText = hhmm(now);
  const botText = hhmm(lastBot);
  const stateLines: string[] = [];
  if (nowText && botText) stateLines.push(`现在 ${nowText}。你上次在群里说话是 ${botText}。`);
  else if (nowText) stateLines.push(`现在 ${nowText}。`);
  if (lastNonBot > 0 && now > lastNonBot) {
    const quiet = agoText(now - lastNonBot);
    // 注意空格：`agoText` 返回「40 分钟前」，拼成「是 40 分钟前」才顺。
    // 原先写成 `是${quiet}` 会输出「是40 分钟前」（2026-11-05 真实测试抓到的文案瑕疵）。
    if (quiet) stateLines.push(`群里最后一条消息是 ${quiet}。`);
  }
  if (stateLines.length) blocks.push(stateLines.join(''));

  // ③ 任务框架：先看真消息，再决定接不接（**不给"必须说"的压力**）
  blocks.push([
    '先看最后 10 条（group_history 就够，不要往前翻）。',
    '',
    '然后只判断一件事：这里面有没有哪一句，让你有话想接？',
  ].join('\n'));

  // ④ 分支：负面词走"轻轻关心"，否则走"挑一条接"
  if (input?.negativeHit) {
    blocks.push([
      `群里刚才有人提到让人担心的事（命中本地负面词「${input.negativeHit}」）。`,
      '如果你要接，就轻轻关心一句，点到为止；不要诊断、不要追问细节、不要给建议、不要调侃。',
      '如果觉得不适合开口，就 reply_gate(false, "不适合接话")，这一轮过去就行。',
    ].join('\n'));
  } else {
    blocks.push([
      '有 —— 就接那一句，对说那句话的人说，一句话，20 字以内。',
      '要落在他说的具体东西上：那个词、那件事、那张图。',
      '如果只是想对"这段聊天"发表感想，那就是没话。',
      '',
      '**绝对禁止评论群的状态**（2026-11-08 补，真机抓到「群里安静好久了，大家最近都在忙啥呢？」）：',
      '- 不许说「群里好安静」「没人说话呀」「大家最近都在忙啥」「都出来冒个泡」这类话。',
      '- 这类话是**群管腔**，不是她的性格；安静的群她可以任它安静。',
      '- 「群很安静」本身**不算**可接的内容 —— 它属于「对这段聊天发表感想」，按上面规则就是「没话」。',
      '',
      '没有 —— 调 reply_gate(false, "没有想接的")，这一轮就过去，群里不会知道你来看过。',
      '这比硬说一句好。**群里安静不算话题，任它安静就行。**',
    ].join('\n'));
  }

  // ⑤ 收尾约束：只禁止"元叙述"，不再堆"不要总结/不要旁观"这类否定（效果弱且会诱发）
  blocks.push('只输出你要发的那一句。不要解释，不要提"心跳/系统/提醒"，也不要说"我刚看到"。');

  return blocks.join('\n\n');
}
