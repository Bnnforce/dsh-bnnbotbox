/**
 * card-audit — 人物卡/群卡**格式体检**（2026-11-08 新增）
 *
 * 为什么需要（真机实测教训）：
 *   示例群那张 `群友C.md` 只有两行碎片评价：
 *     ```
 *     # 群友C
 *     - 主人评价：嘴特别欠
 *     - 主人补充：扬言要吃水泥
 *     ```
 *   缺两样关键东西 → **记忆联想永远静默失效**：
 *     ① 没有 `openid` 字段 → 记忆联想靠 openid 匹配人，匹配不到 → 每轮 `recall:skip no-items`
 *     ② 没有 `## Current` 段 → `extractCurrentSection` 只从这段取正文 → 抽不出摘要
 *
 *   这两条都是**没有报错、没有日志**的静默失效，只能靠翻数据才发现。
 *
 * 本模块做**只读体检**：扫出「缺 openid / 缺 Current」的人物卡，返回告警清单。
 *   · **绝不修改任何文件**（数据是主人的，不由代码自动改写）
 *   · 告警进日志 + 诊断文件，由人决定怎么补
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
/**
 * 人物卡的「标准格式」判据（与记忆联想模块保持**同一口径**）：
 *
 * ```markdown
 * # 群成员-群友C
 *
 * ## Current
 * - 群成员：群友C；openid：<32位openid>。
 * - 备注：会反复夸 bot「你好可爱」。
 * ```
 *
 * ⚠️ 两个正则必须与 `dsh-anti-ai-persona/src/r4/memory-recall/format.ts` 里的
 * `extractOpenid` / `extractCurrentSection` **语义一致**，否则体检通过但注入失败（假阴性）。
 */
const OPENID_RE = /openid\s*[：:]\s*([A-Za-z0-9_-]{8,64})/iu;
const CURRENT_RE = /^\s*##\s*Current\s*$/imu;
/** 单张卡体检（纯函数，便于单测）。 */
export function auditCardText(text) {
    const t = String(text ?? '');
    const missing = [];
    if (!OPENID_RE.test(t))
        missing.push('openid');
    if (!CURRENT_RE.test(t))
        missing.push('current');
    return missing;
}
/**
 * 扫一个群目录下的人物卡（`entities/people/*.md`）。
 *
 * @returns 该群的问题清单（空数组 = 全部合格）
 */
function auditGroupPeople(groupRoot, groupId) {
    const peopleDir = join(groupRoot, 'entities', 'people');
    const issues = [];
    let files;
    try {
        files = readdirSync(peopleDir).filter((f) => f.endsWith('.md'));
    }
    catch {
        return issues; // 没有 people 目录 = 该群还没人物卡，不是问题
    }
    for (const f of files) {
        try {
            const text = readFileSync(join(peopleDir, f), 'utf8');
            const missing = auditCardText(text);
            if (missing.length) {
                issues.push({ groupId, path: `entities/people/${f}`, missing });
            }
        }
        catch { /* 单文件读失败不影响其它 */ }
    }
    return issues;
}
/**
 * 全库体检。
 *
 * @param memoryRoot 记忆库根（`.../group-memory`）
 * @returns `{ scanned, issues }`；任何异常都降级为空结果，绝不抛
 */
export function auditMemoryCards(memoryRoot) {
    const empty = { scanned: 0, issues: [] };
    try {
        const groupsDir = join(memoryRoot, 'groups');
        let dirs;
        try {
            dirs = readdirSync(groupsDir);
        }
        catch {
            return empty;
        }
        let scanned = 0;
        const issues = [];
        for (const gid of dirs) {
            if (gid.startsWith('.'))
                continue;
            const groupRoot = join(groupsDir, gid);
            try {
                const peopleDir = join(groupRoot, 'entities', 'people');
                scanned += readdirSync(peopleDir).filter((f) => f.endsWith('.md')).length;
            }
            catch { /* 该群无 people 目录 */ }
            issues.push(...auditGroupPeople(groupRoot, gid));
        }
        return { scanned, issues };
    }
    catch {
        return empty;
    }
}
//# sourceMappingURL=card-audit.js.map