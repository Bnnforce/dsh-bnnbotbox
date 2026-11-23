/**
 * persona-service — 把 persona 插件的能力注册成 cordis 服务 `persona`
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 🔴 红线 R2（统一架构，2026-11-06）：
 *
 *   **`session-groups.json` 仍然是 `session-map.ts` 的唯一持有者。**
 *   本文件只是把它的结果**转发**出去，绝不允许自己再去 readFileSync 那个文件。
 *
 *   为什么：R4 的 session-map 里有明写红线——
 *   「若出现第二份副本，两份的 mtime 缓存会不同步 → 偶发串群（A 群的消息投到 B 群）。
 *     这正是 2026-11-03 修过的 P1-5 类问题。」
 *
 *   本服务的存在，就是让**其他插件**（如 dsh-qq-memory）不必自己读那个文件。
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 服务名：`persona`
 * 消费方式：`ctx.get('persona')` 或 `inject: ['persona']`
 */
import { Service } from '@deepseek-ai/cordis';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { guidelinePath } from './store.js';

type LoggerLike = { info?: (msg: string) => void; warn?: (msg: string) => void };

/** 本服务对外暴露的契约（唯一真源，消费方按此使用）。 */
export interface PersonaServiceContract {
  /** sessionId → groupId；拿不到返回空串（**永不抛**）。 */
  resolveGroup(sessionId: string): string;
  /** sessionId → senderId；拿不到返回空串。 */
  resolveSender(sessionId: string): string;
  /** senderId 是否主人（白名单优先 + current-sender 兜底）。 */
  isOwner(senderId: string, groupId?: string): boolean;
  /** 本群语感 guideline 文本；没有返回空串。 */
  guideline(groupId: string): string;
  /** guideline 是否新鲜（mtime 在 maxAgeMs 内）。 */
  guidelineFresh(groupId: string, maxAgeMs?: number): boolean;
  /** 主人白名单快照。 */
  owners(): string[];
  /**
   * 登记 sessionId → groupId 映射（**唯一写入口**，2026-11-15 新增）。
   *
   * 为什么需要：此前这个映射文件由扩展包 `hooks/session-title-group.mjs` **直接写**，
   * 存在三个问题：
   *   ① 无契约 —— 两侧路径/格式各写一遍，改一处就静默断裂
   *   ② 无校验 —— 测试夹具（'NEWGID' 等）能直接写进生产（11-15 已发生过）
   *   ③ 无清理 —— 条目只增不减，无 TTL
   * 现在收归服务：写入唯一、校验内置、顺手清理过期条目。
   *
   * @param sessionId 会话 id（非空）
   * @param groupId   群 openid（必须是 32 位十六进制，否则拒绝）
   * @returns ok=false 表示被拒绝（非法入参/写盘失败），调用方**不应**当作错误处理
   */
  rememberSessionGroup(sessionId: string, groupId: string): { ok: boolean; reason?: string };
  /** 诊断信息（排查用）。 */
  diagnostics(): Record<string, unknown>;
}

export interface PersonaServiceDeps {
  logger?: LoggerLike;
  /** 🔴 必须传入 session-map 的 groupIdForSession（不许自己读文件）。 */
  groupIdForSession: (sessionId: string) => string;
  /**
   * 登记 sessionId → groupId（2026-11-15 新增；实现由 session-map.ts 提供，本文件只转发）。
   * 不传时 rememberSessionGroup 返回 {ok:false, reason:'not-supported'}。
   */
  rememberSessionGroup?: (sessionId: string, groupId: string) => { ok: boolean; reason?: string };
  /** senderId 解析（R4 bridge 提供；拿不到时返回空）。 */
  senderOf: (sessionId: string, groupId: string) => string;
  /** 找 qqbot 设置文件（可能为空，表示探测不到）。 */
  settingsFilePath?: () => string;
}

/** owner 白名单缓存的 TTL（设置文件 mtime 变了才重读）。 */
const OWNERS_CACHE_TTL_MS = 30_000;

/** current-sender 旁路的 TTL（扩展包写的是 15 分钟）。 */
const CURRENT_SENDER_TTL_MS = 15 * 60 * 1000;

/**
 * 找到 qqbot 设置文件。
 *
 * 优先 `{DSH_HOME}/qqbot-settings/web/<ns>.json`，退一步扫同级目录。
 * 探测不到返回空串（调用方按「无白名单」处理，fail-closed）。
 */
function defaultSettingsFilePath(): string {
  try {
    const root = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'qqbot-settings');
    const prefer = join(root, 'web', 'im-qqbot-2.json');
    if (existsSync(prefer)) return prefer;
    const alt = join(root, 'web', 'im-qqbot.json');
    if (existsSync(alt)) return alt;
    return prefer;
  } catch {
    return '';
  }
}

export class PersonaService extends Service implements PersonaServiceContract {
  private readonly deps: PersonaServiceDeps;
  private ownersCache: { at: number; list: string[] } = { at: 0, list: [] };

  constructor(ctx: any, deps: PersonaServiceDeps) {
    super(ctx, 'persona');
    this.deps = deps;
  }

  /** sessionId → groupId（转调 session-map，**不自己读文件**）。 */
  resolveGroup(sessionId: string): string {
    try {
      const sid = String(sessionId ?? '').trim();
      if (!sid) return '';
      return String(this.deps.groupIdForSession(sid) ?? '');
    } catch (err) {
      this.warnOnce('resolveGroup 异常', err);
      return '';
    }
  }

  /** sessionId → senderId。 */
  resolveSender(sessionId: string): string {
    try {
      const sid = String(sessionId ?? '').trim();
      if (!sid) return '';
      const gid = this.resolveGroup(sid);
      return String(this.deps.senderOf(sid, gid) ?? '');
    } catch (err) {
      this.warnOnce('resolveSender 异常', err);
      return '';
    }
  }

  /**
   * 主人判定（D3 = 白名单为主 + current-sender 兜底）。
   *
   * 顺序：
   *   ① 白名单命中 → true
   *   ② current-sender 旁路的 isOwner（仅当同一群/同一人、且记录新鲜）
   *   ③ 都拿不到 → false（**fail-closed**，宁可拒绝）
   */
  isOwner(senderId: string, groupId = ''): boolean {
    const sid = String(senderId ?? '').trim();
    if (!sid) return false;

    // ① 白名单
    const owners = this.owners();
    if (owners.length > 0) return owners.includes(sid);

    // ② 白名单为空时，才用旁路兜底（避免白名单被旁路覆盖）
    try {
      const m = (globalThis as any)[Symbol.for('qqbot.current-sender')];
      if (m && typeof m.get === 'function') {
        const keys = groupId ? [`group:${groupId}`, `c2c:${groupId}`] : [];
        for (const k of keys) {
          const e = m.get(k);
          if (!e) continue;
          const ts = Number(e.ts ?? 0);
          if (ts && Date.now() - ts > CURRENT_SENDER_TTL_MS) continue; // 过期不用
          if (String(e.senderId ?? '') === sid && e.isOwner === true) return true;
        }
      }
    } catch { /* ignore */ }

    return false;
  }

  /** 主人白名单（带 mtime 缓存；读不到返回空数组）。 */
  owners(): string[] {
    const now = Date.now();
    if (this.ownersCache.at && now - this.ownersCache.at < OWNERS_CACHE_TTL_MS) {
      return this.ownersCache.list;
    }
    let list: string[] = [];
    try {
      const file = (this.deps.settingsFilePath ?? defaultSettingsFilePath)();
      if (file && existsSync(file)) {
        const j = JSON.parse(readFileSync(file, 'utf8')) as any;
        const raw = j?.groupAdmin?.owners;
        if (Array.isArray(raw)) list = raw.map((x) => String(x).trim()).filter(Boolean);
      }
    } catch (err) {
      this.warnOnce('读取 owner 白名单失败', err);
    }
    this.ownersCache = { at: now, list };
    return list;
  }

  /** 本群语感文本（读 guideline 文件；不存在返回空串）。 */
  guideline(groupId: string): string {
    try {
      const gid = String(groupId ?? '').trim();
      if (!gid) return '';
      const p = guidelinePath(gid);
      if (!existsSync(p)) return '';
      return String(readFileSync(p, 'utf8') ?? '').trim();
    } catch (err) {
      this.warnOnce('读取 guideline 失败', err);
      return '';
    }
  }

  /** guideline 是否新鲜。 */
  guidelineFresh(groupId: string, maxAgeMs = 24 * 60 * 60 * 1000): boolean {
    try {
      const gid = String(groupId ?? '').trim();
      if (!gid) return false;
      const p = guidelinePath(gid);
      if (!existsSync(p)) return false;
      return Date.now() - statSync(p).mtimeMs <= maxAgeMs;
    } catch { return false; }
  }

  /**
   * 登记 sessionId → groupId 映射（唯一写入口，2026-11-15）。
   *
   * 🔴 红线 R2 依然成立：**本文件不直接读写 session-groups.json**。
   *   实际写入委托给 `deps.rememberSessionGroup`（由 session-map.ts 提供实现），
   *   本文件只做入参校验与结果转发。
   */
  rememberSessionGroup(sessionId: string, groupId: string): { ok: boolean; reason?: string } {
    try {
      const sid = String(sessionId ?? '').trim();
      const gid = String(groupId ?? '').trim();
      if (!sid) return { ok: false, reason: 'empty-session-id' };
      if (sid.length > 128) return { ok: false, reason: 'session-id-too-long' };
      // QQ 群 openid 实测为 32 位十六进制；不符合一律拒绝（防测试夹具/脏数据写进生产）
      if (!/^[0-9A-Fa-f]{32}$/.test(gid)) return { ok: false, reason: 'bad-group-id' };
      if (typeof this.deps.rememberSessionGroup !== 'function') {
        return { ok: false, reason: 'not-supported' };
      }
      return this.deps.rememberSessionGroup(sid, gid);
    } catch (err) {
      this.warnOnce('rememberSessionGroup', err);
      return { ok: false, reason: 'failed' };
    }
  }

  diagnostics(): Record<string, unknown> {
    return {
      ownerCount: this.owners().length,
      ownersCachedAt: this.ownersCache.at,
      hasSettingsFile: Boolean((this.deps.settingsFilePath ?? defaultSettingsFilePath)()),
    };
  }

  /** 同一个警告只打一次，避免刷屏。 */
  private warned = new Set<string>();
  private warnOnce(tag: string, err: unknown): void {
    const msg = `${tag}: ${err instanceof Error ? err.message : String(err)}`;
    if (this.warned.has(msg)) return;
    this.warned.add(msg);
    try { this.deps.logger?.warn?.(`[persona-service] ${msg}`); } catch { /* ignore */ }
  }
}
