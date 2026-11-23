/**
 * r4-bridge — R4 需要的「外部世界能力」供应层（从 `index.ts` 拆出，重构任务 B3）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么这四块**合并**成一个文件（而不是拆更碎）：
 *   `r4Groups` / `r4SenderOf` / `r4MentionFlagsOf` / `r4BotOpenid` / `sendToGroupViaBridge`
 *   全部服务于同一个目的 —— 给 R4 提供"外部世界"的访问能力（群列表、当前发送者、
 *   @/引用标记、bot 身份、发消息）。它们共享 `qqbotDataRoot` 与若干 TTL 缓存，
 *   **拆得更碎只会制造循环依赖**（例如 mention 判定要用 botOpenid）。
 *
 * 🔵 依赖注入约定（防循环的第二道保险）：
 *   本模块**不 import `r4/index.js`**，也不持有 `r4` 实例。
 *   R4 实例相关的三个能力（diagnostics / decorateOutgoing）通过 `deps` 传入。
 *   这样将来 R4 换实现，本模块无感。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ⚠️ 这里面的注释**逐字保留**（都是真实事故记录，删了容易重蹈覆辙）：
 *   · `r4SenderOf`   —— 2026-11-04 「R4 收不到真人消息」根因（键是 group:<gid> 不是 sessionId）
 *   · `sendToGroupViaBridge` —— 2026-11-04 「心跳永远发不出去」根因（三条真实通道的优先级）
 *   · `r4Groups`     —— 2026-11-03 P1-9 目录名必须 sanitize
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { expandHome } from './analyzer.js';
import { sanitizeId } from './r4/paths.js';
import { stateDir, personaDataRoot } from './r4/paths.js';
import { writeTextAtomic } from './r4/atomic.js';
import { listGuidelineGroupIds } from './store.js';
// 只 import 类型（编译期擦除）：payload 契约定义在 scheduler.ts，避免在这里再造一份。
import type { HeartbeatWakePayload } from './r4/scheduler.js';

/** 只依赖最小上下文，不 import config（避免与 config 模块循环）。 */
export interface R4BridgeDeps {
  /** 真实 qqbot 数据根（由 `paths-runtime` 解析）。 */
  qqbotDataRoot: string;
  /** 日志（可选字段的宽松类型）。 */
  logger?: { info?: (msg: string) => void; warn?: (msg: string) => void };
  /**
   * 读 R4 诊断（取 `botOpenid` 等）。**由 index 注入**，本模块不碰 r4 实例。
   * 未接线时返回空串（判定保守）。
   */
  r4Diagnostics?: () => Record<string, unknown> | undefined;
  /**
   * R4 出站装饰（cooldown 到期后首次开口加"小脾气"前缀）。**由 index 注入**。
   * 未接线时原文返回（功能降级但不报错）。
   */
  r4DecorateOutgoing?: (input: { groupId: string; text: string }) => { text: string; injected: boolean };
}

export interface R4Bridge {
  /** R4 群列表（msg-history 目录优先，退回 guidelines）。 */
  r4Groups: () => string[];
  /** R4 当前会话发送者 openid（拿不到返回空串）。 */
  r4SenderOf: (sessionId: string, groupId?: string) => string;
  /** 从 session event 判定「本条是否 @bot / 引用 bot」。 */
  r4MentionFlagsOf: (event: unknown) => { atBot: boolean; quoteBot: boolean };
  /** R4 用的 bot openid。 */
  r4BotOpenid: () => string;
  /** 向群里发消息（心跳用）——三条通道 + 文件桥兜底。 */
  sendToGroupViaBridge: (groupId: string, text: string) => Promise<boolean>;
  /**
   * ★ 2026-11-05 心跳 wake：把 wake 指令写进 outbox 文件（**不是"已送达"**）。
   * 返回 true = 已入队，由扩展包 `hooks/r4-heartbeat-bridge.mjs` 用 `caps.wakeTo` 注入 agent。
   */
  sendWakeToGroup: (payload: HeartbeatWakePayload) => Promise<boolean>;
  /** 无监听无定时器，保持统一接口。 */
  dispose: () => void;
}

export function createR4Bridge(deps: R4BridgeDeps): R4Bridge {
  const { qqbotDataRoot } = deps;
  const logger = deps.logger ?? {};

  // ══════════ R4.0 辅助 ══════════

  /** R4 群列表：优先 qqbot msg-history 目录，拿不到退回 guidelines 目录。 */
  const r4Groups = (): string[] => {
    try {
      const root = join(expandHome(qqbotDataRoot), '.qqbot', 'msg-history');
      const names = readdirSync(root, { withFileTypes: true });
      // ★ 2026-11-03 修复 P1-9：目录名剥掉 `group_` 前缀后必须过 sanitize，
      //   否则脏目录名（含 `/`、特殊符号）会被拼进数据路径。
      return names
        .filter((e) => e.isDirectory() && e.name.startsWith('group_'))
        .map((e) => sanitizeId(e.name.replace(/^group_/, '')))
        .filter((id): id is string => id !== null);
    } catch {
      try { return listGuidelineGroupIds(); } catch { return []; }
    }
  };

  /** R4 用的 bot openid（复用 R4 自己那份带缓存的解析，避免重复扫盘）。 */
  const r4BotOpenid = (): string => {
    try {
      const diag = deps.r4Diagnostics?.();
      const id = diag && typeof diag.botOpenid === 'string' ? diag.botOpenid : '';
      return id;
    } catch { return ''; }
  };

  /**
   * R4 当前会话发送者：先查 qqbot 会话注册表，再查扩展包内存旁路；都拿不到返回空串。
   *
   * ★ 2026-11-04 修复（**R4 收不到真人消息的根因**）：
   *   扩展包 `inbound/zz-current-sender.mjs` 写入
   *   `globalThis[Symbol.for('qqbot.current-sender')]` 的 Map，**键是 `${scope}:${peerId}`**
   *   （形如 `group:FADE0001FADE0001FADE0001FADE0001`），**不是 sessionId**。
   *   11-03 那版把查找改成「按 sessionId 精确匹配」，于是永远查不到 → `uid` 为空 →
   *   `handleIncomingMessage` 整条被跳过 → `lastNonBotMessageAt` 恒为 0、关系计分从不触发。
   *   现在按真实键 `group:<groupId>` 查（R4 本来就知道群号），再兜底遍历（只认同群/同会话）。
   *   注：`qqbot.session-registry` 在本机扩展包里**没有写入方**，保留仅作前瞻兼容。
   */
  const r4SenderOf = (sessionId: string, groupId = ''): string => {
    const sid = String(sessionId || '').trim();
    const gid = String(groupId || '').trim();
    if (!sid && !gid) return '';
    // ① 前瞻兼容：将来若有 session-registry，按 sessionId 精确匹配。
    if (sid) {
      try {
        const g = (globalThis as any)[Symbol.for('qqbot.session-registry')];
        if (g && typeof g.values === 'function') {
          for (const list of g.values()) {
            for (const rec of Array.isArray(list) ? list : []) {
              if (rec && String(rec.sessionId ?? '') === sid && rec.senderId) return String(rec.senderId);
            }
          }
        }
      } catch { /* ignore */ }
    }
    // ② 主路径：扩展包旁路，键 = `group:<peerId>`（peerId 就是 R4 的 groupId）。
    try {
      const m = (globalThis as any)[Symbol.for('qqbot.current-sender')];
      if (!m || typeof m.get !== 'function') return '';
      /** 记录是否新鲜（扩展包 TTL 15 分钟；ts 缺失按「新鲜」处理，兼容老格式）。 */
      const isFresh = (e: any): boolean => {
        const ts = Number(e?.ts ?? 0);
        if (!ts) return true;
        return Date.now() - ts <= 15 * 60 * 1000;
      };
      /** 从记录里取 senderId；**过期记录一律不采用**（否则会把 15 分钟前的人当成当前发送者）。 */
      const senderIn = (e: any): string => {
        if (!e) return '';
        if (typeof e === 'string') return e;
        if (typeof e === 'object' && e.senderId && isFresh(e)) return String(e.senderId);
        return '';
      };
      // 精确键（最准）
      if (gid) {
        const hit = senderIn(m.get(`group:${gid}`));
        if (hit) return hit;
      }
      // 兼容：万一将来也按 sessionId 存过
      if (sid) {
        const hit = senderIn(m.get(sid));
        if (hit) return hit;
      }
      // 遍历兜底：只认 peerId/groupId 与当前群一致、或 sessionId 相等的那条；
      // **绝不返回「第一个 senderId」**（那会把 A 群消息计到 B 群头上）。
      if (typeof m.values === 'function') {
        const now = Date.now();
        let best = '';
        let bestTs = -1;
        for (const [key, entry] of m as Map<string, any>) {
          if (!entry || typeof entry !== 'object') continue;
          const ts = Number(entry.ts ?? 0);
          if (ts > 0 && now - ts > 15 * 60 * 1000) continue; // 扩展包 TTL 15 分钟
          const peer = String(entry.peerId ?? '');
          const keyStr = String(key ?? '');
          const peerMatch = Boolean(gid) && (peer === gid || keyStr === `group:${gid}`);
          const sidMatch = Boolean(sid) && String(entry.sessionId ?? entry.sid ?? '') === sid;
          if (!peerMatch && !sidMatch) continue;
          const candidate = String(entry.senderId ?? '');
          if (candidate && ts >= bestTs) {
            best = candidate;
            bestTs = ts;
          }
        }
        if (best) return best;
      }
    } catch { /* ignore */ }
    return '';
  };

  /**
   * 从 session event 里判定「本条是否 @bot / 引用 bot」（2026-11-03 修复 P0-2）。
   *
   * 数据源优先级（任一命中即 true，全部失败 → false，不抛）：
   *  ① `event.data.platform.mentioned` / `event.data.mentioned`：平台已判定的 @ 信号（最准）；
   *  ② 原始 `content` 文本里出现 `<@openid>`：与 qqbot bot-self 缓存的 openid 比对，
   *     拿不到 openid 时退化为「出现 `<@…>` 且不是 `<@all>`」；
   *  ③ 引用：`event.data.context` / `event.data.quote` / `event.data.ref` 里
   *     `refMsg.senderId === botOpenid` 或 `isSelf === true`。
   */
  const r4MentionFlagsOf = (event: any): { atBot: boolean; quoteBot: boolean } => {
    const out = { atBot: false, quoteBot: false };
    try {
      const data = event?.data ?? {};
      const botId = r4BotOpenid();
      // ① 平台信号
      if (data?.platform?.mentioned === true || data?.mentioned === true) out.atBot = true;
      // ② 原始文本里的 <@…>
      const rawBlocks = Array.isArray(data?.message?.content) ? data.message.content : data?.content;
      let raw = '';
      if (Array.isArray(rawBlocks)) {
        for (const b of rawBlocks) {
          if (b && typeof b === 'object' && typeof (b as any).text === 'string') raw += (b as any).text;
        }
      } else if (typeof rawBlocks === 'string') {
        raw = rawBlocks;
      }
      if (raw) {
        for (const m of raw.matchAll(/<@([^>\s]+)>/gu)) {
          const id = String(m[1] ?? '').trim();
          if (!id || id === 'all' || id === 'everyone') continue;
          if (botId ? id === botId : true) {
            out.atBot = true;
            break;
          }
        }
      }
      // ③ 引用
      const refs = [data?.quote, data?.context, data?.ref, data?.quoteRef];
      for (const ref of refs) {
        if (!ref || typeof ref !== 'object') continue;
        const r = ref as Record<string, unknown>;
        const quoted = (r.refMsg ?? r.message ?? r) as Record<string, unknown> | undefined;
        if (!quoted || typeof quoted !== 'object') continue;
        const sender = String(quoted.senderId ?? quoted.sender ?? quoted.openid ?? quoted.s ?? '').trim();
        const isSelf = quoted.me === true || quoted.isSelf === true || sender === 'self';
        if (isSelf || (botId && sender === botId)) {
          out.quoteBot = true;
          break;
        }
      }
    } catch { /* 解析失败 → 保守 false（不误判、不抛） */ }
    return out;
  };

  /**
   * 向群里发消息（心跳用）。
   *
   * ★ 2026-11-04 修复（**心跳永远发不出去的根因**）：
   *   旧实现只认 `globalThis[Symbol.for('qqbot.session-registry')]` —— 那个 Symbol
   *   在本机**从来没有任何写入方**（扩展包与 QQBot 本体全仓都搜不到），
   *   于是 `managers` 恒为 `[]`，函数恒 `return false`：心跳只要判定「该发」，
   *   就会走「发送失败 → 回滚」，永远开不了口，且每次白跑一轮模型调用。
   *
   *   现在按优先级用**真有实现**的三条通道：
   *     ① `im-qqbot.outbound`（QQBot 官方出站总线，`send(text, { target })`）——最正；
   *     ② `qqbot.session-registry`（前瞻兼容，本机目前为空，保留以防上游将来提供）；
   *     ③ 扩展包发送器兜底 / 文件桥（见下）。
   *   全部失败 → 如实返回 false（调度器会回滚，行为不变）。
   */
  const sendToGroupViaBridge = async (groupId: string, text: string): Promise<boolean> => {
    // 发送前过一遍 R4 出站装饰（cooldown 到期后首次开口 → 小脾气前缀）。
    let outgoing = text;
    try {
      const decorated = deps.r4DecorateOutgoing?.({ groupId, text });
      if (decorated?.injected) {
        outgoing = decorated.text;
        logger.info?.(`[anti-ai-persona] R4 小脾气前缀已注入（${groupId}）`);
      }
    } catch { /* 装饰失败 → 用原文发送 */ }

    const body = String(outgoing ?? '');
    if (!body.trim()) return false;

    // ① QQBot 官方出站总线（主动发群消息的唯一官方通道）
    //
    // ★ 2026-11-04 修复（**心跳成功与否依赖偶然顺序**）：
    //   QQBot 的 `sendViaOutboundChannel` 要求 sender 与 target **同时存在**：
    //     `const sender = opts.sender ?? lastCtx?.sender ?? null;
    //      if (!sender || !target) return false;`
    //   上一版只传了 `target`，sender 只能从 `lastCtx`（最近一次出站的 ctx）里"借"——
    //   而 lastCtx 只在**有人走了一次出站链**（例如群里有被动回复）后才被赋值。
    //   后果：**重启后若群里一条消息都没发生过就触发心跳 → lastCtx=null → 必然发送失败**。
    //   这是「靠偶然顺序」的脆弱实现，已改为：显式从 `ob.last()` 取 sender，
    //   并对每个候选 sender 都做可用性校验（要有 sendText 之类的方法）。
    try {
      const ob = (globalThis as any)[Symbol.for('im-qqbot.outbound')];
      if (ob && typeof ob.send === 'function') {
        // 候选 target：优先用「最近一次出站」真实 target（含 scope 语义），否则按群构造
        let lastCtx: any = null;
        try { lastCtx = typeof ob.last === 'function' ? ob.last() : null; } catch { lastCtx = null; }
        const lastTarget = lastCtx?.target && typeof lastCtx.target === 'object' ? lastCtx.target : null;
        const myTarget = lastTarget && String(lastTarget.scope ?? '') === 'group'
          && String(lastTarget.targetId ?? lastTarget.peerId ?? '') === String(groupId)
          ? { ...lastTarget }                       // 同一群：直接复用（避免丢 msgId 等字段）
          : { scope: 'group', targetId: groupId };  // 不同群/无记录：按群构造（走主动发送）

        // 候选 sender：`last()` 里那个真实发送器（可能在不同 scope 下，但 sender 本身就是账号级）
        const candidateSender = lastCtx?.sender && typeof lastCtx.sender === 'object' ? lastCtx.sender : null;

        // 逐个尝试：① 带 sender（最可靠）② 不带 sender（让对方回落 lastCtx）
        const attempts: Array<{ label: string; opts: any }> = [];
        if (candidateSender) attempts.push({ label: 'sender+target', opts: { target: myTarget, sender: candidateSender } });
        attempts.push({ label: 'target-only', opts: { target: myTarget } });

        for (const attempt of attempts) {
          try {
            const sent = await ob.send(body, attempt.opts);
            if (sent !== false) {
              logger.info?.(`[anti-ai-persona] 心跳已发送（outbound/${attempt.label}）：${groupId}`);
              return true;
            }
            logger.warn?.(`[anti-ai-persona] 心跳 outbound/${attempt.label} 返回 false：${groupId}`);
          } catch (error) {
            logger.warn?.(`[anti-ai-persona] 心跳 outbound/${attempt.label} 抛错：${error instanceof Error ? error.message : String(error)}`);
          }
        }
      } else {
        logger.warn?.('[anti-ai-persona] 心跳发送：im-qqbot.outbound 不可用（QQBot 未安装或未启动？）');
      }
    } catch (error) {
      logger.warn?.(`[anti-ai-persona] 心跳发送 outbound 异常：${error instanceof Error ? error.message : String(error)}`);
    }

    // ② 前瞻兼容：session-registry（本机当前无写入方）
    try {
      const g = (globalThis as any)[Symbol.for('qqbot.session-registry')];
      const managers = g && typeof g.values === 'function' ? [...g.values()].flat().filter(Boolean) : [];
      for (const m of managers) {
        const manager = m?.manager ?? m;
        const sender = m?.sender ?? manager?.sender;
        if (!manager || typeof manager.findByPeer !== 'function' || typeof sender?.sendText !== 'function') continue;
        if (!manager.findByPeer('group', groupId)) continue;
        await sender.sendText({ scope: 'group', targetId: groupId }, body);
        logger.info?.(`[anti-ai-persona] 心跳已发送（session-registry）：${groupId}`);
        return true;
      }
    } catch { /* ignore */ }

    // ③ 文件桥兜底（方案 A，2026-11-04）：
    //    R4 拿不到 QQBot 的 sender 实例，而 `im-qqbot.outbound` 的 send() 要求
    //    `sender` 与 `target` 同时存在（sender 只能从 lastCtx 取）——
    //    **重启后群里没说过话时 lastCtx=null，上面两条通道必然失败**。
    //    因此写一份 outbox 文件，由扩展包 `hooks/r4-heartbeat-bridge.mjs`
    //    用 `caps.wakeTo('group', gid, text)` 真正投递（该路径不依赖 lastCtx）。
    try {
      // PERSONA_DATA_ROOT（与 R4 的 paths.ts 同源）：扩展包 hooks/r4-heartbeat-bridge.mjs
      // 读的是同一个 ${PERSONA_DATA_ROOT}/state/heartbeat-outbox/。
      const outboxDir = join(stateDir(personaDataRoot()), 'heartbeat-outbox');
      const outboxPath = join(outboxDir, `${groupId}.json`);
      const ok = writeTextAtomic(outboxPath, `${JSON.stringify({
        groupId,
        text: body,
        at: Date.now(),
        // 小脾气前缀是否已注入（诊断用，扩展侧不关心）
        decorated: outgoing !== text,
      }, null, 2)}\n`, logger);
      if (ok) {
        logger.info?.(`[anti-ai-persona] 心跳已写入 outbox（待扩展投递）：${groupId}`);
        return true; // 交给扩展，视为本环节成功
      }
      logger.warn?.(`[anti-ai-persona] 心跳 outbox 写入失败：${groupId}`);
    } catch (error) {
      logger.warn?.(`[anti-ai-persona] 心跳 outbox 异常：${error instanceof Error ? error.message : String(error)}`);
    }

    logger.warn?.(`[anti-ai-persona] 心跳发送失败：全部通道不可用（group=${groupId}）`);
    return false;
  };

  /**
   * ★ 2026-11-05 心跳 wake：把一条 wake 指令写进 outbox 文件（**不是"已送达"**）。
   *
   * 共享契约 §3/§5（逐字遵守 —— 改这里必须同时对齐扩展包
   * `hooks/r4-heartbeat-bridge.mjs`，那是**另一个 worker 的域**，不要互相改）：
   *   · 路径：`{PERSONA_DATA_ROOT}/state/heartbeat-outbox/`（与老文件桥同源）；
   *   · 文件名：`{groupId}-{at}-{rand4}.json` —— **唯一**，绝不用固定 `{gid}.json`
   *     （固定名会被 5 秒内第二次写覆盖；桥的指纹去重命中后 60 秒还会重发）；
   *   · payload：`{ id, groupId, text, wakePrompt?, at }`，其中 `text` **永远写**
   *     （老桥 `readOutbox` 里 `if (!text) return null` 会整条丢弃 → 向后兼容，硬阻塞 #4）；
   *   · 原子写（`writeTextAtomic`，含 mkdir/fsync/rename），失败/异常 → 如实返回 false
   *     （调度器会走**与发送失败相同**的回滚分支）。
   *
   * 返回 true = 已入队。真正的年龄检查 / id 判重 / `caps.wakeTo` 注入都在扩展桥侧。
   * 注意：`decorateOutgoing`（小脾气前缀）只作用于非空正文；wake 模式没有正文 → 原样写。
   */
  const sendWakeToGroup = async (payload: HeartbeatWakePayload): Promise<boolean> => {
    try {
      const gid = sanitizeId(payload?.groupId);
      if (!gid) {
        logger.warn?.('[anti-ai-persona] 心跳 wake：groupId 非法/为空 → 不入队');
        return false;
      }
      const at = Number(payload?.at) > 0 ? Math.floor(Number(payload.at)) : Date.now();
      // wake 模式没有正文；只有兜底 `text` 非空时才过小脾气装饰（契约 §3：text 可为空）。
      let text = String(payload?.text ?? '');
      if (text.trim()) {
        try {
          const decorated = deps.r4DecorateOutgoing?.({ groupId: gid, text });
          if (decorated?.injected) {
            text = decorated.text;
            logger.info?.(`[anti-ai-persona] R4 小脾气前缀已注入（wake 兜底正文，${gid}）`);
          }
        } catch { /* 装饰失败 → 用原文入队 */ }
      }
      const wakePrompt = String(payload?.wakePrompt ?? '').trim();
      const rand4 = (Math.random().toString(36).slice(2, 6) + '0000').slice(0, 4).toLowerCase();
      // id：优先用调度器算好的（桥按它判重）；缺失/为空 → 按契约现造一个。
      const id = String(payload?.id ?? '').trim() || `${gid}-${at}-${rand4}`;
      const outboxDir = join(stateDir(personaDataRoot()), 'heartbeat-outbox');
      // 唯一文件名（契约 §3）：同一毫秒写两次也不会互相覆盖。
      const outboxPath = join(outboxDir, `${gid}-${at}-${rand4}.json`);
      const ok = writeTextAtomic(outboxPath, `${JSON.stringify({
        id,
        groupId: gid,
        // ★ 向后兼容：老桥看到空 text 会整条丢弃 —— 所以这个字段**永远写**（wake 模式下是空串）。
        text,
        // 空/缺省 = 老格式（桥直接发 text）；非空 = wake 指令（桥走 caps.wakeTo）。
        ...(wakePrompt ? { wakePrompt } : {}),
        at,
      }, null, 2)}\n`, logger);
      if (ok) {
        logger.info?.(`[anti-ai-persona] 心跳 wake 指令已写入 outbox（待扩展桥注入，非已送达）：${gid}（id=${id}）`);
        return true;
      }
      logger.warn?.(`[anti-ai-persona] 心跳 wake：outbox 写入失败：${gid}`);
      return false;
    } catch (error) {
      logger.warn?.(`[anti-ai-persona] 心跳 wake：outbox 异常：${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  };

  return {
    r4Groups,
    r4SenderOf,
    r4MentionFlagsOf,
    r4BotOpenid,
    sendToGroupViaBridge,
    sendWakeToGroup,
    dispose: () => { /* 无监听、无定时器 */ },
  };
}
