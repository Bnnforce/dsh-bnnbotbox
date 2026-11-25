/**
 * QqMemoryService — 把记忆库注册成 cordis 服务 `qqMemory`
 *
 * 消费方式：`ctx.get('qqMemory')` 或 `inject: ['qqMemory']`
 *
 * 分工：
 *   · 存储/隔离/防穿透 → MemoryStore（store/）
 *   · scope 解析 → **必须**来自 persona 服务（红线：session-groups.json 只有 persona 能读）
 *   · 权限判定 → persona 服务的 isOwner（白名单为主）+ ownersFallback 兜底
 */
import { Service } from '@deepseek-ai/cordis';
import { makeScope } from './scope.js';
export class QqMemoryService extends Service {
    deps;
    constructor(ctx, deps) {
        super(ctx, 'qqMemory');
        this.deps = deps;
    }
    // ── scope ──────────────────────────────────────────────────────────────
    /**
     * sessionId → scope。
     *
     * 🔴 红线：**只能**通过 persona 服务解析（不许自己读 session-groups.json）。
     *    persona 不可用 → 返回 null（调用方按「读不到群」处理，绝不猜）。
     */
    scopeOfSession(sessionId) {
        const sid = String(sessionId ?? '').trim();
        if (!sid)
            return null;
        const persona = this.safePersona();
        if (!persona)
            return null;
        try {
            const gid = String(persona.resolveGroup(sid) ?? '').trim();
            if (!gid)
                return null;
            return makeScope('group', gid);
        }
        catch (err) {
            this.deps.logger?.warn?.(`[bnnbotbox] scope 解析失败: ${err instanceof Error ? err.message : String(err)}`);
            return null;
        }
    }
    // ── 读操作（群友可用）──────────────────────────────────────────────────
    search(scope, query) {
        if (!scope)
            return [];
        try {
            return this.deps.store.search(scope, query);
        }
        catch (err) {
            return this.warnAnd('search', err, []);
        }
    }
    read(scope, relPath) {
        if (!scope)
            return { ok: false, reason: '缺少 scope' };
        try {
            return this.deps.store.read(scope, relPath);
        }
        catch (err) {
            return this.warnAnd('read', err, { ok: false, reason: '内部错误' });
        }
    }
    list(scope, relDir) {
        if (!scope)
            return { ok: false, reason: '缺少 scope' };
        try {
            return this.deps.store.list(scope, relDir ?? '');
        }
        catch (err) {
            return this.warnAnd('list', err, { ok: false, reason: '内部错误' });
        }
    }
    // ── 写操作（仅主人）────────────────────────────────────────────────────
    remember(scope, relPath, content, actor) {
        const denied = this.denyIfNotOwner(scope, actor);
        if (denied)
            return denied;
        if (!scope)
            return { ok: false, reason: '缺少 scope' };
        try {
            return this.deps.store.remember(scope, relPath, content);
        }
        catch (err) {
            return this.warnAnd('remember', err, { ok: false, reason: '内部错误' });
        }
    }
    forget(scope, relPath, actor) {
        const denied = this.denyIfNotOwner(scope, actor);
        if (denied)
            return denied;
        if (!scope)
            return { ok: false, reason: '缺少 scope' };
        try {
            return this.deps.store.forget(scope, relPath);
        }
        catch (err) {
            return this.warnAnd('forget', err, { ok: false, reason: '内部错误' });
        }
    }
    // ── 权限 ───────────────────────────────────────────────────────────────
    /**
     * 主人判定：persona 白名单为主 → ownersFallback 兜底 → fail-closed。
     */
    isOwner(senderId, groupId = '') {
        const sid = String(senderId ?? '').trim();
        if (!sid)
            return false;
        const persona = this.safePersona();
        if (persona && typeof persona.isOwner === 'function') {
            try {
                if (persona.isOwner(sid, groupId))
                    return true;
            }
            catch { /* fallthrough */ }
        }
        const fb = this.deps.ownersFallback ?? [];
        return fb.length > 0 && fb.includes(sid);
    }
    diagnostics() {
        return {
            hasPersona: Boolean(this.safePersona()),
            ownersFallback: (this.deps.ownersFallback ?? []).length,
            ownerWriteOnly: this.deps.ownerWriteOnly !== false,
        };
    }
    // ── 内部 ───────────────────────────────────────────────────────────────
    safePersona() {
        try {
            return this.deps.getPersona();
        }
        catch {
            return undefined;
        }
    }
    denyIfNotOwner(scope, actor) {
        if (this.deps.ownerWriteOnly === false)
            return null;
        const sid = String(actor?.senderId ?? '').trim();
        if (!sid)
            return { ok: false, reason: '写记忆需要身份（拿不到 senderId）' };
        if (this.isOwner(sid, scope?.id ?? ''))
            return null;
        return { ok: false, reason: '写记忆仅限主人' };
    }
    warnAnd(op, err, fallback) {
        this.deps.logger?.warn?.(`[bnnbotbox] ${op} 异常: ${err instanceof Error ? err.message : String(err)}`);
        return fallback;
    }
}
//# sourceMappingURL=service.js.map