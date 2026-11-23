/**
 * r4/message-utils — 消息层小工具（无状态、无 IO）
 *
 * 从 `r4/index.ts` 拆出（重构阶段 2 / 批次 C）。
 * 这些函数原来散在 `index.ts` 底部，被 `createR4Runtime` 的心跳/提取路径使用。
 * 抽出来的好处：`index.ts` 只剩 `createR4Runtime` 一个主体，读起来不再被工具函数打断。
 */

import type { RecentlyMessage } from './types.js';

/** 一条消息是否为「非 bot」。 */
export function isNonBot(m: RecentlyMessage): boolean {
  return m.self !== true;
}

/** 最近的非 bot 消息时间（图纸 2.3 的 lastNonBotMessageAt）。 */
export function lastNonBotOf(state: { lastNonBotMessageAt: number }, messages: RecentlyMessage[]): number {
  let at = Number(state.lastNonBotMessageAt) || 0;
  for (const m of messages) if (isNonBot(m) && m.at > at) at = m.at;
  return at;
}

/** 本地负面词命中（图纸 2.4：仅匹配 negative_words.json）。 */
export function hitNegative(messages: RecentlyMessage[], words: string[]): string | null {
  const recent = messages.filter(isNonBot).slice(-20);
  for (const word of words) {
    if (!word) continue;
    for (const m of recent) if (m.text.includes(word)) return word;
  }
  return null;
}

/** 剥掉 markdown 代码围栏（模型常把 JSON 包在 ```json 里）。 */
export function stripCodeFence(raw: string): string {
  const text = String(raw ?? '').trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/iu.exec(text);
  return fenced ? String(fenced[1] ?? '').trim() : text;
}

/**
 * 提取用的系统指令（图纸 3.2 的输出形状写死）。
 *
 * ★ 2026-11-04 双层记忆（主人需求 §2）：模型必须区分
 * `permanent:true`（永久标签：性格/偏好/梗/语气）与 `permanent:false`（临时事件：生活琐事）。
 * 代码侧还有一层 category 硬规则兜底（见 profile-types.ts 的 resolvePermanent）。
 */
export function EXTRACTION_SYSTEM(whitelist: string[]): string {
  return [
    '你是群聊画像提取器。只输出一个 JSON 对象，不要任何解释、不要 markdown。',
    '格式：{"tags":[{"tag":"...","category":"...","permanent":true|false}]}',
    `category 只能是以下之一：${whitelist.join('、')}。`,
    'tag 必须是被提取者自己反复表现出的特征（说话风格、常用梗、话题偏好、语气、活跃时段），不超过 20 字。',
    '',
    '★ permanent 字段的含义（这条决定她能不能"记得住你"，务必仔细分辨）：',
    '- permanent=true：**稳定特征**。性格脾气、口头禅、常用梗、说话语气、长期爱好、固定的作息习惯。',
    '  例：{"tag":"爱用猫图","category":"常用表情/梗","permanent":true}',
    '- permanent=false：**一次性生活琐事**。今天吃了什么、昨天几点睡、这周加班、明天考试、刚去哪玩了。',
    '  例：{"tag":"今晚复习数学","category":"话题偏好","permanent":false}',
    '- **拿不准时一律填 false**（宁可少记，也不要把琐事当成人格）。',
    '',
    '不要提取隐私信息（住址、电话、账号、健康、家庭关系等），不要主观评价，不要编造。',
    '最多 5 条；没有可靠特征就输出 {"tags":[]}。',
    '',
    '★ 另外：如果这个人提到了**将来 / 进行中的具体事件**（考试、项目、面试、出差、搬家、比赛、看病…），',
    '在同一个 JSON 里**多给一个 events 数组**：',
    '{"tags":[...],"events":[{"type":"exam","keywords":["期中考试"],"summary":"周日期中考试，数学不会"}]}',
    '  · type 只能是：exam / project / interview / trip / health / move / game / other',
    '  · summary ≤40 字，**只写事实不评价**；keywords 1~3 个（以后用来判断是不是同一件事）',
    '  · 没有这类事件就省略 events 字段（或给空数组）',
  ].join('\n');
}
