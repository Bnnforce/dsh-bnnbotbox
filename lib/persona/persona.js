import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { expandHome } from './analyzer.js';
function readJson(path) {
    try {
        return JSON.parse(readFileSync(path, 'utf8'));
    }
    catch {
        return undefined;
    }
}
function cardNames(dataRoot) {
    const dir = join(dirname(dataRoot), '人格', '角色卡');
    try {
        return readdirSync(dir)
            .filter((f) => f.endsWith('.md') && !f.endsWith('.bak') && !/\.md\./u.test(f))
            .map((f) => basename(f, '.md'))
            .filter(Boolean);
    }
    catch {
        return [];
    }
}
function catalogFor(dataRoot) {
    const config = readJson(join(dirname(dataRoot), '人格', 'persona-config.json'));
    /**
     * 默认人格的解析顺序（2026-11-23 修）：
     *   ① 人格配置里的 defaultPersona
     *   ② 第一个角色卡的文件名（有人格卡但还没写配置 —— 全新部署的常见状态）
     *   ③ 空串（**一张卡都没有**）
     *
     * ⚠️ 原来第 ③ 步兜底写死了 '比安安'（2026-09 的旧默认人格）。
     *   后果：全新环境里它会对下游**谎称存在一个叫「比安安」的人格**，
     *   而实际没有任何角色卡 → prompt 注入按名字找不到卡、复盘记录挂到一个不存在的人。
     *   没配置就该是「没有人格」，由调用方显式降级，不能凭空造一个。
     */
    const cfgName = String(config?.defaultPersona || '').trim();
    const cards = cardNames(dataRoot);
    const defaultPersona = cfgName || cards[0] || '';
    const aliasesJson = readJson(join(dirname(dataRoot), '人格', 'persona-aliases.json')) || {};
    const names = [...new Set([defaultPersona, ...cards].filter(Boolean))];
    const aliases = new Map();
    for (const name of names) {
        aliases.set(name, name);
        for (const alias of aliasesJson[name] || []) {
            const a = String(alias || '').trim();
            if (a)
                aliases.set(a, name);
        }
    }
    return { defaultPersona, names, aliases };
}
function usableRoot(dataRoot) {
    const root = expandHome(dataRoot);
    return existsSync(join(root, '.qqbot-extensions', 'data', 'persona-groups.json'))
        || existsSync(join(dirname(root), '人格', 'persona-config.json'))
        || existsSync(join(dirname(root), '人格', '角色卡'));
}
function pickRoot(dataRoots) {
    for (const root of dataRoots) {
        const r = expandHome(root);
        if (r && usableRoot(r))
            return r;
    }
    return expandHome(dataRoots[0] || '~/.dsh-qqbot');
}
export function personaCatalog(dataRoots) {
    return catalogFor(pickRoot(dataRoots));
}
/** 从 QQBot 的 persona-groups.json 取当前群人格；没有显式记录时返回空。 */
export function explicitPersonaForGroup(dataRoots, groupId) {
    const root = pickRoot(dataRoots);
    const state = readJson(join(root, '.qqbot-extensions', 'data', 'persona-groups.json'));
    return String(state?.groups?.[groupId]?.persona || '').trim();
}
/** 取当前群人格；无显式状态时回落默认人格。 */
export function personaForGroup(dataRoots, groupId) {
    return explicitPersonaForGroup(dataRoots, groupId) || personaCatalog(dataRoots).defaultPersona;
}
/**
 * 优先群状态；状态缺失时从 system prompt sections 里匹配角色卡名/别名。
 * 这样即使 QQBot 状态文件还没写入，也能按当前 prompt 推断。
 */
export function personaForAssembly(dataRoots, assembly, groupId) {
    const explicitState = explicitPersonaForGroup(dataRoots, groupId);
    if (explicitState)
        return explicitState;
    const stateName = personaForGroup(dataRoots, groupId);
    const catalog = personaCatalog(dataRoots);
    const text = (Array.isArray(assembly?.sections) ? assembly.sections : [])
        .map((s) => String(s?.text || ''))
        .join('\n');
    if (text) {
        const candidates = [...catalog.aliases.entries()].sort((a, b) => b[0].length - a[0].length);
        for (const [alias, canonical] of candidates) {
            if (text.includes(alias))
                return canonical;
        }
    }
    return stateName || catalog.defaultPersona;
}
