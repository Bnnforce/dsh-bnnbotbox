/**
 * auto-card — 自动建档（群卡 / 人物卡**骨架**）（2026-11-09 新增）
 *
 * ── 为什么需要 ───────────────────────────────────────────────────────────────
 * 2026-11-09 实测发现一个结构性缺口：
 *   · 画像层（`elysia/profiles/*.md`）是**真自动**的 —— 每天 03:00 由 `r4-extract`
 *     从群聊天里提取特征，33 个人全部有档；
 *   · 但**人物卡 / 群卡**（`entities/people/*.md`、`entities/groups/*.md`）**全仓库零自动写入**：
 *     `store.remember()` 只有两个调用方（`qq_memory` 工具、`group_memory` 兼容工具），
 *     两者都要求「主人主动开口」。实测生产环境 `remember` 调用次数 = **0**（15 次全是测试数据）。
 *   后果：7 个群里只有 1 个有群卡，19 个关系人只有 5 篇人物卡 →
 *   记忆联想第一层「你记得我吗」对绝大多数人**静默降级为空**。
 *
 * ── 本模块做什么（**保守方案**，主人 2026-11-09 批准）────────────────────────────
 * 只写**能从本机数据直接观测到的事实**，绝不推测、绝不评价：
 *   · 群卡：群名（`groups.json`）、gid、已知成员名单（群成员台账 + 消息历史）；
 *   · 人物卡：昵称、openid、所属群 —— 以及「近期发言 N 条」这类**计数事实**。
 *   · **不写**：主人评价、性格判断、群氛围、群规 —— 那些仍然只有主人能写。
 *
 * ── 数据来源（全部在 qqbot 数据根内，**零 LLM 调用、零跨插件依赖**）────────────
 *   `{root}/.qqbot/groups.json`                → gid → 群名
 *   `{root}/表情包/group-members.jsonl`         → gid/mid/name/ts（插件中间件记录的成员台账）
 *   `{root}/.qqbot/msg-history/group_<gid>/*.jsonl` → 真实消息（s=发言人 openid、n=昵称、t=时间）
 *
 * ── 纪律 ───────────────────────────────────────────────────────────────────────
 *   · **只在文件不存在时创建**，已存在的卡**绝不改写**（主人的数据优先级最高）；
 *   · 证据不足不建（发言数 < `minMessages` 的一律跳过，避免给一见而过的陌生人建垃圾卡）；
 *   · 每群有人数上限（`maxPerGroup`），防一次建几百张把记忆索引拖垮；
 *   · 所有 IO 失败一律降级（返回报告而不是抛）；
 *   · 目标路径全部走 `entities/...` 白名单前缀，文件名做**路径安全清洗**
 *     （昵称里的 `/`、`..`、零宽字符、控制字符一律处理掉）。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { atomicWriteText } from '../shared/atomic.js';
/** 每张人物卡最多显示的「已知成员」人数（防止群卡正文过长挤爆注入预算）。 */
const GROUP_CARD_MAX_MEMBERS = 12;
/** 文件名最大字符数（防超长昵称／防超长路径）。 */
const MAX_NAME_CHARS = 40;
/** 允许进文件名的字符：字母（含非 ASCII）／数字／下划线／连字符／空格／常见标点。 */
const NAME_ALLOWED = /[\p{L}\p{N}_\- （）()·、]+/gu;
/** 零宽字符（实测群昵称里真的存在：`⁡⁣​⁠⁣⁣`）。 */
const ZERO_WIDTH_RE = /[\u200B-\u200F\u2060-\u2064\uFEFF\u00AD]/gu;
const CONTROL_RE = /[\u0000-\u001F\u007F-\u009F]/gu;
/**
 * 把昵称清洗成**安全的文件名**（纯函数）。
 *
 * 处理（实测真实昵称里全都出现过）：
 *   · 零宽字符（`⁡⁣​⁠⁣⁣` 这种完全不可见的昵称）→ 删；
 *   · 控制字符 / 路径分隔符 `/\` / Windows 保留字符 → 删；
 *   · 英文句点 → 删（防 `.`/`..`/隐藏文件）；
 *   · 空白折叠成单个空格；
 *   · 超长截断；清空后用「成员-<openid 后 6 位>」兜底，**绝不返回空串**。
 */
export function sanitizeCardName(raw, openid) {
    const tail = String(openid ?? '').trim().toUpperCase().slice(-6) || 'UNKNOWN';
    let s = String(raw ?? '')
        .replace(ZERO_WIDTH_RE, '')
        .replace(CONTROL_RE, '')
        .replace(/[.\\/:*?"<>|]/gu, '')
        .replace(/\s+/gu, ' ')
        .trim();
    // 只保留允许字符（非允许字符直接丢弃，避免把奇怪符号带进路径）
    s = (s.match(NAME_ALLOWED) ?? []).join('').trim();
    s = s.replace(/^[-_\s]+/u, '').replace(/[-_\s]+$/u, '').slice(0, MAX_NAME_CHARS);
    return s || `成员-${tail}`;
}
/** 本机时区的日期键（`YYYY-MM-DD`）。解析不到时区时回落 Asia/Shanghai。 */
export function dateKeyOf(ms, timeZone) {
    const tz = String(timeZone ?? '').trim() || 'Asia/Shanghai';
    try {
        return new Intl.DateTimeFormat('en-CA', {
            timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
        }).format(new Date(ms));
    }
    catch {
        return new Date(ms).toISOString().slice(0, 10);
    }
}
/**
 * 把昵称清洗成**可显示的展示名**（纯函数）。
 *
 * 比 `sanitizeCardName` 宽松（不删标点、不截断），但同样要处理：
 *   · 零宽字符 —— 实测有昵称是纯零宽（`⁡⁣​⁠⁣⁣`，6 个字符全不可见）。
 *     不清洗的话，群卡「已知成员：、群友B、…」会出现一个**空条目**，
 *     注入后模型看到的是一串逗号连着的空洞，纯浪费预算。
 *   · 控制字符；
 *   · 空白折叠。
 * 清洗后为空 → 回退 `成员-<openid 尾号>`（绝不返回空串）。
 */
export function displayNameOf(raw, openid) {
    const tail = String(openid ?? '').trim().toUpperCase().slice(-6) || 'UNKNOWN';
    const s = String(raw ?? '')
        .replace(ZERO_WIDTH_RE, '')
        .replace(CONTROL_RE, '')
        .replace(/\s+/gu, ' ')
        .trim();
    if (s)
        return s;
    // 兜底名本身已带语义，**不要再被 title 前缀二次包装**（否则拼出「群成员-成员-318B82」）
    return `成员-${tail}`;
}
/**
 * 拼人物卡的标题行。
 *
 * 为什么单独抽出来：兜底名（`成员-<尾号>`）已经自带「成员-」语义，
 * 若标题再硬拼 `# 群成员-${name}` 就会变成 `# 群成员-成员-318B82`（2026-11-09 实测）。
 */
export function personCardTitle(name) {
    const n = String(name ?? '').trim();
    if (!n)
        return '# 群成员';
    // 兜底名 `成员-<尾号>` 已含「成员-」；标题再拼一次就成了「群成员-成员-318B82」
    if (n.startsWith('成员-'))
        return `# 群成员-${n.slice('成员-'.length)}`;
    return `# 群成员-${n}`;
}
/** 拼群卡正文（纯函数；**只有可观测事实**）。 */
export function buildGroupCardText(input) {
    const name = String(input.groupName ?? '').trim() || `未命名群-${String(input.gid ?? '').slice(-6)}`;
    const gid = String(input.gid ?? '').trim();
    const cap = Math.max(1, Math.floor(Number(input.maxMembers) || GROUP_CARD_MAX_MEMBERS));
    const names = input.members
        .slice()
        .sort((a, b) => (b.count - a.count) || (a.firstAt - b.firstAt))
        // ★ 展示名必须清洗零宽字符：实测有昵称是纯零宽（`⁡⁣​⁠⁣⁣`），
        //   不洗就会拼出「已知成员：、群友B、…」这种空条目，纯浪费注入预算。
        .map((m) => displayNameOf(m.name, m.openid))
        .filter(Boolean);
    const memberLine = names.length
        ? `- 已知成员：${names.slice(0, cap).join('、')}${names.length > cap ? '等' : ''}。`
        : '';
    return [
        `# 群-${name}`,
        '',
        '## Current',
        `- 群：${name}；openid：${gid}。`,
        `- group openid：${gid}。`,
        ...(memberLine ? [memberLine] : []),
        '',
        '## History',
        `- ${dateKeyOf(input.now, input.timeZone)}：自动建档（据本机群消息与成员台账；`
            + '未写任何评价/群规，需要时由主人补充）。',
        '',
        '## Related',
        '- global/entities/people/<owner>.md',
        '',
    ].join('\n');
}
/** 拼人物卡正文（纯函数；**只有可观测事实**）。 */
export function buildPersonCardText(input) {
    // ★ 正文里的名字也要清洗零宽字符（文件名已被 sanitizeCardName 洗过，正文是独立的）
    const name = displayNameOf(input.name, String(input.openid ?? ''));
    const openid = String(input.openid ?? '').trim().toUpperCase();
    const groupName = String(input.groupName ?? '').trim();
    const gid = String(input.gid ?? '').trim();
    return [
        personCardTitle(name),
        '',
        '## Current',
        `- 群成员：${name}；openid：${openid}。`,
        groupName ? `- 群：${groupName}（${gid}）。` : `- 群 openid：${gid}。`,
        '',
        '## History',
        `- ${dateKeyOf(input.now, input.timeZone)}：自动建档（据本机群消息台账；`
            + `近期可见 ${Math.max(0, Math.floor(Number(input.count) || 0))} 条发言，`
            + `首见于 ${dateKeyOf(input.firstAt, input.timeZone)}）。`
            + '尚未记录任何评价 —— 需要时由主人补充。',
        '',
        '## Related',
        '',
    ].join('\n');
}
/**
 * 挑选该建卡的人（纯函数，便于单测）。
 *
 * 判据（全部保守）：
 *   ① `count >= minMessages`（说过话才算「人」，避免给只看不说的陌生人建卡）；
 *   ② 该群已有的人物卡里**没有这个 openid**（按 openid 去重，不按昵称 ——
 *      昵称会改，openid 不会）；
 *   ③ 昵称不在 `ignoreNames`（Q群管家这类服务号不建）；
 *   ④ 按发言数降序取前 `maxPerGroup` 个。
 */
export function pickNewPeople(input) {
    const min = Math.max(1, Math.floor(Number(input.cfg.minMessages) || 1));
    const cap = Math.max(1, Math.floor(Number(input.cfg.maxPerGroup) || 1));
    const ignore = new Set((input.cfg.ignoreNames ?? []).map((n) => String(n ?? '').trim()).filter(Boolean));
    const all = (input.members ?? []).filter((m) => String(m.openid ?? '').trim());
    const candidates = all
        .filter((m) => {
        const openid = String(m.openid ?? '').trim();
        if (input.existingOpenids.has(openid.toUpperCase()))
            return false;
        if (ignore.has(String(m.name ?? '').trim()))
            return false;
        return Number(m.count) >= min;
    })
        .sort((a, b) => (Number(b.count) - Number(a.count)) || (Number(a.firstAt) - Number(b.firstAt)));
    return {
        picked: candidates.slice(0, cap),
        ineligible: Math.max(0, all.length - candidates.length),
        overCap: Math.max(0, candidates.length - cap),
    };
}
// ══════════════════════════════════ IO 层 ══════════════════════════════════
/** 读 `{root}/.qqbot/groups.json` → gid → 群名。失败 → 空表。 */
function readGroups(root) {
    const out = new Map();
    try {
        const j = JSON.parse(readFileSync(join(root, '.qqbot', 'groups.json'), 'utf8'));
        for (const [gid, v] of Object.entries(j ?? {})) {
            const name = typeof v === 'string' ? v : String(v?.name ?? '');
            if (gid)
                out.set(gid, name.trim());
        }
    }
    catch { /* 没这个文件也无妨 */ }
    return out;
}
/** 读群成员台账 `{root}/表情包/group-members.jsonl` → gid → Map<mid, {name, ts, count}>。 */
function readLedger(root) {
    const out = new Map();
    try {
        const raw = readFileSync(join(root, '表情包', 'group-members.jsonl'), 'utf8');
        for (const line of raw.split('\n')) {
            if (!line.trim())
                continue;
            let e;
            try {
                e = JSON.parse(line);
            }
            catch {
                continue;
            }
            const gid = String(e?.gid ?? '').trim();
            const mid = String(e?.mid ?? '').trim();
            if (!gid || !mid)
                continue;
            let bucket = out.get(gid);
            if (!bucket) {
                bucket = new Map();
                out.set(gid, bucket);
            }
            const cur = bucket.get(mid) ?? { name: '', ts: 0, count: 0 };
            const ts = Number(e?.ts ?? 0);
            const name = String(e?.name ?? '').trim();
            if (ts >= cur.ts && name) {
                cur.ts = ts;
                cur.name = name;
            }
            cur.count += 1;
            bucket.set(mid, cur);
        }
    }
    catch { /* 没有台账也能靠消息历史 */ }
    return out;
}
/**
 * 读某群的真实消息历史 → 发言人 → 事实（条数 / 昵称 / 首见时间）。
 *
 * ⚠️ 只统计**别人**发的（`s === 'self'` 是 bot 自己，跳过）。
 */
function readHistory(root, gid) {
    const out = new Map();
    const dir = join(root, '.qqbot', 'msg-history', `group_${gid}`);
    let files;
    try {
        files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
    }
    catch {
        return out;
    }
    for (const f of files) {
        let raw;
        try {
            raw = readFileSync(join(dir, f), 'utf8');
        }
        catch {
            continue;
        }
        for (const line of raw.split('\n')) {
            if (!line.trim())
                continue;
            let o;
            try {
                o = JSON.parse(line);
            }
            catch {
                continue;
            }
            const openid = String(o?.s ?? '').trim();
            if (!openid || openid === 'self')
                continue;
            const t = Number(o?.t ?? 0);
            const n = String(o?.n ?? '').trim();
            const cur = out.get(openid) ?? { openid, name: '', count: 0, firstAt: 0 };
            cur.count += 1;
            if (n)
                cur.name = n; // 取最新观测到的昵称
            if (t > 0 && (!cur.firstAt || t < cur.firstAt))
                cur.firstAt = t;
            out.set(openid, cur);
        }
    }
    return out;
}
/** 列出某群记忆目录里 `entities/people/*.md` 的正文（用于 openid 去重）。 */
function readExistingPersonCards(groupRoot) {
    const dir = join(groupRoot, 'entities', 'people');
    const out = [];
    let files;
    try {
        files = readdirSync(dir).filter((f) => f.endsWith('.md'));
    }
    catch {
        return out;
    }
    for (const f of files) {
        try {
            out.push({ path: `entities/people/${f}`, text: readFileSync(join(dir, f), 'utf8') });
        }
        catch { /* 单文件失败无妨 */ }
    }
    return out;
}
/** 该群是否已有群卡（`entities/groups/*.md` 至少一篇）。 */
function hasGroupCard(groupRoot) {
    try {
        return readdirSync(join(groupRoot, 'entities', 'groups')).some((f) => f.endsWith('.md'));
    }
    catch {
        return false;
    }
}
/** 从人物卡正文抽 openid（与 `card-audit.ts` / persona `format.ts` **同一口径**）。 */
const OPENID_RE = /openid\s*[：:]\s*([A-Za-z0-9_-]{8,64})/iu;
export function openidOfCard(text) {
    const m = OPENID_RE.exec(String(text ?? ''));
    return m && typeof m[1] === 'string' ? m[1].toUpperCase() : '';
}
/**
 * 写一个 .md（**不存在才写**）。返回 `'created'` / `'exists'` / `'failed'`。
 *
 * ⚠️ 这是「绝不改写主人数据」的**唯一守门人**，因此必须导出以便单测直接验证
 * （2026-11-09 变异测试发现：只在 runAutoCards 里间接测，删掉这个守卫测试**照样全绿** ——
 *  因为第二次 run 时候文件已存在，走的是「已存在」分支，删守卫后行为恰好相同）。
 */
export function writeCardOnce(abs, text) {
    if (existsSync(abs))
        return 'exists';
    try {
        mkdirSync(dirname(abs), { recursive: true });
    }
    catch { /* ignore */ }
    const r = atomicWriteText(abs, text);
    return r.ok ? 'created' : 'failed';
}
/**
 * 跑一次自动建档。
 *
 * **永不抛**：所有异常都降级成报告里的 `failed` 计数（维护任务不能被它带崩）。
 */
export function runAutoCards(deps) {
    const cfg = deps?.config ?? { enabled: false, groupEnabled: false, minMessages: 1, maxPerGroup: 1, ignoreNames: [] };
    const report = {
        scannedGroups: 0, groupsCreated: [], peopleCreated: [], peopleSkipped: 0, failed: 0,
        dryRun: Boolean(deps?.dryRun),
    };
    if (!cfg.enabled)
        return report;
    const memoryRoot = String(deps?.memoryRoot ?? '').trim();
    const qqbotRoot = String(deps?.qqbotRoot ?? '').trim();
    if (!memoryRoot || !qqbotRoot)
        return report;
    if (!existsSync(memoryRoot))
        return report;
    const now = Number.isFinite(Number(deps?.now)) ? Number(deps?.now) : Date.now();
    const tz = deps?.timeZone;
    let groupDirs;
    try {
        groupDirs = readdirSync(join(memoryRoot, 'groups')).filter((n) => !n.startsWith('.'));
    }
    catch {
        return report;
    }
    const groups = readGroups(qqbotRoot);
    const ledger = readLedger(qqbotRoot);
    for (const gid of groupDirs) {
        report.scannedGroups += 1;
        const groupRoot = join(memoryRoot, 'groups', gid);
        try {
            // ── ① 汇总该群的可观测成员事实（消息历史优先，台账补名字）──
            const history = readHistory(qqbotRoot, gid);
            const bucket = ledger.get(gid);
            if (bucket) {
                for (const [openid, v] of bucket) {
                    const cur = history.get(openid);
                    if (cur) {
                        // 台账有更完整名字时补上（消息历史里昵称可能为空）
                        if (!cur.name && v.name)
                            cur.name = v.name;
                    }
                    else {
                        // 只在台账里出现（入群/申请）也算证据，但条数取台账的
                        history.set(openid, { openid, name: v.name, count: v.count, firstAt: v.ts });
                    }
                }
            }
            const members = [...history.values()];
            // ── ② 群卡（没有才建）──
            if (cfg.groupEnabled && !hasGroupCard(groupRoot)) {
                const text = buildGroupCardText({
                    groupName: groups.get(gid) ?? '',
                    gid,
                    members,
                    now,
                    timeZone: tz,
                });
                if (report.dryRun) {
                    report.groupsCreated.push(gid);
                }
                else {
                    const r = writeCardOnce(join(groupRoot, 'entities', 'groups', `${sanitizeCardName(groups.get(gid) ?? '', gid)}.md`), text);
                    if (r === 'created')
                        report.groupsCreated.push(gid);
                    else if (r === 'failed')
                        report.failed += 1;
                }
            }
            // ── ③ 人物卡（按 openid 去重；只建骨架）──
            const existing = readExistingPersonCards(groupRoot);
            const existingOpenids = new Set(existing.map((c) => openidOfCard(c.text)).filter(Boolean));
            const { picked, ineligible, overCap } = pickNewPeople({ members, existingOpenids, cfg });
            report.peopleSkipped += ineligible + overCap;
            const baseNameCount = new Map();
            for (const c of existing) {
                const b = c.path.split('/').pop() ?? '';
                baseNameCount.set(b, (baseNameCount.get(b) ?? 0) + 1);
            }
            for (const m of picked) {
                const openid = String(m.openid ?? '').trim().toUpperCase();
                if (!openid)
                    continue;
                const base = sanitizeCardName(m.name, openid);
                // 同名但不同 openid → 加 openid 后缀，避免覆盖别人
                let fileName = `${base}.md`;
                let path = `entities/people/${fileName}`;
                let guard = 0;
                while (baseNameCount.has(fileName) && guard < 5) {
                    fileName = `${base}-${openid.slice(-6)}${guard ? `-${guard}` : ''}.md`;
                    path = `entities/people/${fileName}`;
                    guard += 1;
                }
                // 已存在同 path → 说明已被别的 openid 占住（极端情况），跳过
                if (baseNameCount.has(fileName)) {
                    report.peopleSkipped += 1;
                    continue;
                }
                baseNameCount.set(fileName, 1);
                const text = buildPersonCardText({
                    name: m.name,
                    openid,
                    groupName: groups.get(gid) ?? '',
                    gid,
                    count: m.count,
                    firstAt: m.firstAt,
                    now,
                    timeZone: tz,
                });
                if (report.dryRun) {
                    report.peopleCreated.push({ groupId: gid, name: m.name, path });
                    continue;
                }
                const r = writeCardOnce(join(groupRoot, path), text);
                if (r === 'created')
                    report.peopleCreated.push({ groupId: gid, name: m.name, path });
                else if (r === 'failed')
                    report.failed += 1;
            }
        }
        catch (err) {
            report.failed += 1;
            deps?.logger?.warn?.(`[bnnbotbox] 自动建档异常（群 ${gid.slice(-6)}，已跳过）：${err instanceof Error ? err.message : String(err)}`);
        }
    }
    return report;
}
//# sourceMappingURL=auto-card.js.map