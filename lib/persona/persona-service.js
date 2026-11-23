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
function defaultSettingsFilePath() {
    try {
        const root = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'qqbot-settings');
        const prefer = join(root, 'web', 'im-qqbot-2.json');
        if (existsSync(prefer))
            return prefer;
        const alt = join(root, 'web', 'im-qqbot.json');
        if (existsSync(alt))
            return alt;
        return prefer;
    }
    catch {
        return '';
    }
}
export class PersonaService extends Service {
    deps;
    ownersCache = { at: 0, list: [] };
    constructor(ctx, deps) {
        super(ctx, 'persona');
        this.deps = deps;
    }
    /** sessionId → groupId（转调 session-map，**不自己读文件**）。 */
    resolveGroup(sessionId) {
        try {
            const sid = String(sessionId ?? '').trim();
            if (!sid)
                return '';
            return String(this.deps.groupIdForSession(sid) ?? '');
        }
        catch (err) {
            this.warnOnce('resolveGroup 异常', err);
            return '';
        }
    }
    /** sessionId → senderId。 */
    resolveSender(sessionId) {
        try {
            const sid = String(sessionId ?? '').trim();
            if (!sid)
                return '';
            const gid = this.resolveGroup(sid);
            return String(this.deps.senderOf(sid, gid) ?? '');
        }
        catch (err) {
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
    isOwner(senderId, groupId = '') {
        const sid = String(senderId ?? '').trim();
        if (!sid)
            return false;
        // ① 白名单
        const owners = this.owners();
        if (owners.length > 0)
            return owners.includes(sid);
        // ② 白名单为空时，才用旁路兜底（避免白名单被旁路覆盖）
        try {
            const m = globalThis[Symbol.for('qqbot.current-sender')];
            if (m && typeof m.get === 'function') {
                const keys = groupId ? [`group:${groupId}`, `c2c:${groupId}`] : [];
                for (const k of keys) {
                    const e = m.get(k);
                    if (!e)
                        continue;
                    const ts = Number(e.ts ?? 0);
                    if (ts && Date.now() - ts > CURRENT_SENDER_TTL_MS)
                        continue; // 过期不用
                    if (String(e.senderId ?? '') === sid && e.isOwner === true)
                        return true;
                }
            }
        }
        catch { /* ignore */ }
        return false;
    }
    /** 主人白名单（带 mtime 缓存；读不到返回空数组）。 */
    owners() {
        const now = Date.now();
        if (this.ownersCache.at && now - this.ownersCache.at < OWNERS_CACHE_TTL_MS) {
            return this.ownersCache.list;
        }
        let list = [];
        try {
            const file = (this.deps.settingsFilePath ?? defaultSettingsFilePath)();
            if (file && existsSync(file)) {
                const j = JSON.parse(readFileSync(file, 'utf8'));
                const raw = j?.groupAdmin?.owners;
                if (Array.isArray(raw))
                    list = raw.map((x) => String(x).trim()).filter(Boolean);
            }
        }
        catch (err) {
            this.warnOnce('读取 owner 白名单失败', err);
        }
        this.ownersCache = { at: now, list };
        return list;
    }
    /** 本群语感文本（读 guideline 文件；不存在返回空串）。 */
    guideline(groupId) {
        try {
            const gid = String(groupId ?? '').trim();
            if (!gid)
                return '';
            const p = guidelinePath(gid);
            if (!existsSync(p))
                return '';
            return String(readFileSync(p, 'utf8') ?? '').trim();
        }
        catch (err) {
            this.warnOnce('读取 guideline 失败', err);
            return '';
        }
    }
    /** guideline 是否新鲜。 */
    guidelineFresh(groupId, maxAgeMs = 24 * 60 * 60 * 1000) {
        try {
            const gid = String(groupId ?? '').trim();
            if (!gid)
                return false;
            const p = guidelinePath(gid);
            if (!existsSync(p))
                return false;
            return Date.now() - statSync(p).mtimeMs <= maxAgeMs;
        }
        catch {
            return false;
        }
    }
    /**
     * 登记 sessionId → groupId 映射（唯一写入口，2026-11-15）。
     *
     * 🔴 红线 R2 依然成立：**本文件不直接读写 session-groups.json**。
     *   实际写入委托给 `deps.rememberSessionGroup`（由 session-map.ts 提供实现），
     *   本文件只做入参校验与结果转发。
     */
    rememberSessionGroup(sessionId, groupId) {
        try {
            const sid = String(sessionId ?? '').trim();
            const gid = String(groupId ?? '').trim();
            if (!sid)
                return { ok: false, reason: 'empty-session-id' };
            if (sid.length > 128)
                return { ok: false, reason: 'session-id-too-long' };
            // QQ 群 openid 实测为 32 位十六进制；不符合一律拒绝（防测试夹具/脏数据写进生产）
            if (!/^[0-9A-Fa-f]{32}$/.test(gid))
                return { ok: false, reason: 'bad-group-id' };
            if (typeof this.deps.rememberSessionGroup !== 'function') {
                return { ok: false, reason: 'not-supported' };
            }
            return this.deps.rememberSessionGroup(sid, gid);
        }
        catch (err) {
            this.warnOnce('rememberSessionGroup', err);
            return { ok: false, reason: 'failed' };
        }
    }
    diagnostics() {
        return {
            ownerCount: this.owners().length,
            ownersCachedAt: this.ownersCache.at,
            hasSettingsFile: Boolean((this.deps.settingsFilePath ?? defaultSettingsFilePath)()),
        };
    }
    /** 同一个警告只打一次，避免刷屏。 */
    warned = new Set();
    warnOnce(tag, err) {
        const msg = `${tag}: ${err instanceof Error ? err.message : String(err)}`;
        if (this.warned.has(msg))
            return;
        this.warned.add(msg);
        try {
            this.deps.logger?.warn?.(`[persona-service] ${msg}`);
        }
        catch { /* ignore */ }
    }
}
