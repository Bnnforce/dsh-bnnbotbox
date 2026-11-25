/**
 * session-map — sessionId ↔ groupId 旁路映射（从 `index.ts` 拆出，重构任务 B2）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 🔴 红线 R3（主人明确要求，改动前必读）：
 *
 *   **读取 `session-groups.json` 与其缓存的逻辑只能存在于本文件。**
 *   其他任何文件严禁自己再去读一遍那个 JSON。
 *
 *   为什么这么严：这个映射决定「哪条消息属于哪个群」。若出现第二份副本，
 *   两份的 mtime 缓存会不同步 → 偶发**串群**（A 群的消息投到 B 群）。
 *   这正是 2026-11-03 修过的 P1-5 类问题（多群串号），代价是一条错话。
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 数据来源：QQBot 的 `session-title` hook 会把 `sessionId -> groupId` 写进这个旁路文件。
 * （DSH 的 `system-prompt/assemble` context 里通常只有 agent，没有 groupId。）
 *
 * 设计要点：
 *   · 带 **mtime 缓存**：文件没变就不重复 parse（每次 assemble 都会调，不能每次都读盘）
 *   · **永不抛错**：文件不存在 / 坏 JSON → 返回空 Map 并继续（首次启动时是常态）
 *   · 提供 `dispose()` 以便统一清理（虽然本模块无监听，保持接口一致性）
 */
import { resolveDataRoot } from '../shared/paths.js';
import { readFileSync, statSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
/** 旁路映射文件路径（`$DSH_HOME/data/dsh-anti-ai-persona/session-groups.json`）。 */
export function sessionGroupsPath() {
    return join(resolveDataRoot(), 'session-groups.json');
}
/**
 * 创建 session 映射（**本模块内唯一持有那份缓存**）。
 *
 * 缓存判据：`mtime` 变化才重读。首次调用（`at === 0`）强制读一次。
 */
export function createSessionMap(path = sessionGroupsPath()) {
    let cache = { at: 0, mtime: -1, map: new Map() };
    const reload = () => {
        try {
            const mtime = statSync(path).mtimeMs;
            if (cache.at === 0 || cache.mtime !== mtime) {
                const raw = JSON.parse(readFileSync(path, 'utf8'));
                const map = new Map();
                for (const [key, value] of Object.entries(raw)) {
                    const gid = typeof value === 'string' ? value : String(value?.groupId ?? '');
                    if (key && gid)
                        map.set(key, gid);
                }
                cache = { at: Date.now(), mtime, map };
            }
        }
        catch { /* 文件还没生成 / 坏 JSON：保持上一次的缓存（首次则空 Map） */ }
        return cache.map;
    };
    const groupIdForSession = (sessionId) => {
        const sid = String(sessionId || '');
        if (!sid)
            return '';
        return reload().get(sid) ?? '';
    };
    const groupIdFromContext = (context) => {
        const c = context;
        const sid = String(c?.agent?.session?.id || c?.session?.id || c?.agent?.id || '');
        return groupIdForSession(sid);
    };
    /**
     * 写入实现（本模块是唯一写入方）：读现有 → 合并 → 清理 → 原子写。
     * 清理：删 90 天前过期条目；超 500 条保留最新 500。
     */
    const rememberSessionGroup = (sessionId, groupId) => {
        try {
            const sid = String(sessionId ?? '').trim();
            const gid = String(groupId ?? '').trim();
            if (!sid)
                return { ok: false, reason: 'empty-session-id' };
            // sessionId 长度上限：DSH 会话 id 是 UUID(36)，放宽到 128 足够；超长多为脏数据
            if (sid.length > 128)
                return { ok: false, reason: 'session-id-too-long' };
            if (!/^[0-9A-Fa-f]{32}$/.test(gid))
                return { ok: false, reason: 'bad-group-id' };
            let all = {};
            try {
                const parsed = JSON.parse(readFileSync(path, 'utf8'));
                if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
                    all = parsed;
            }
            catch { /* 不存在/损坏 → 从空开始 */ }
            all[sid] = { groupId: gid, updatedAt: Date.now() };
            const MAX_ENTRIES = 500;
            const MAX_AGE_MS = 90 * 24 * 3600 * 1000;
            const now = Date.now();
            let kept = Object.entries(all).filter(([, v]) => {
                const at = Number(v?.updatedAt ?? 0);
                return !at || now - at <= MAX_AGE_MS;
            });
            if (kept.length > MAX_ENTRIES) {
                kept = kept.sort((a, b) => Number(b[1]?.updatedAt ?? 0) - Number(a[1]?.updatedAt ?? 0)).slice(0, MAX_ENTRIES);
            }
            mkdirSync(dirname(path), { recursive: true });
            const tmp = path + '.tmp-' + process.pid + '-' + Date.now();
            writeFileSync(tmp, JSON.stringify(Object.fromEntries(kept)), 'utf8');
            renameSync(tmp, path);
            cache = { at: 0, mtime: -1, map: cache.map }; // 让下次读重新加载
            return { ok: true };
        }
        catch (err) {
            return { ok: false, reason: err instanceof Error ? err.message : String(err) };
        }
    };
    return {
        rememberSessionGroup,
        groupIdForSession,
        groupIdFromContext,
        dispose: () => { cache = { at: 0, mtime: -1, map: new Map() }; },
    };
}
