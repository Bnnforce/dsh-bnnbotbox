/**
 * R4.0 路径与身份净化（阶段一基建）。
 *
 * 红线（施工图纸 0.3 / 0.5）：
 *  - `PERSONA_DATA_ROOT` 默认 `~/.dsh/data/dsh-anti-ai-persona`；
 *  - 子目录固定为 `persona-configs/`、`elysia/profiles/`、`state/heartbeat/`、
 *    `state/relationships/`、`state/profile-events/`、`state/extraction-state.json`、`configs/`；
 *  - `groupId` / `userId` 拼路径前必须 sanitize（非 `[A-Za-z0-9_-]` → `_`），
 *    结果为空或全 `_` → 拒绝并 warn（返回 null，不抛错）；
 *  - 双覆盖 `PERSONA_DATA_ROOT` 与 `QQBOT_DATA_ROOT`（测试隔离）。
 *
 * 2026-11-03 修复（R4 体检 P1-9 / P1-10）：
 *  - 所有 `*Path()` **内部自己 sanitize**（不再依赖调用方自觉）；非法身份返回空串，
 *    由各 store 判空后返回 false/空值（绝不写到意外路径）；
 *  - `dictPath()` 增加**根目录逃逸防护**：解析后必须仍在 `PERSONA_DATA_ROOT` 内，
 *    拒绝绝对路径与 `../` 穿越。
 */

import { homedir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';

/** 数据根的环境变量名（测试隔离用）。 */
export const PERSONA_ROOT_ENV = 'PERSONA_DATA_ROOT';

/** qqbot 数据根的环境变量名（只读历史用，测试隔离）。 */
export const QQBOT_ROOT_ENV = 'QQBOT_DATA_ROOT';

/** 从环境变量取数据根（空串 = 未覆盖）。 */
export function personaRootOverride(): string {
  const v = String(process.env[PERSONA_ROOT_ENV] ?? '').trim();
  return v;
}

/** 默认数据根：`~/.dsh/data/dsh-anti-ai-persona`。 */
export function defaultPersonaRoot(): string {
  return join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'data', 'dsh-anti-ai-persona');
}

/** 生效的数据根（环境变量覆盖优先）。 */
export function personaDataRoot(): string {
  const o = personaRootOverride();
  return o || defaultPersonaRoot();
}

/** `persona-configs/{persona}.json` 目录。 */
export function personaConfigsDir(root = personaDataRoot()): string {
  return join(root, 'persona-configs');
}

/** 人格配置路径：`persona-configs/{persona}.json`。 */
export function personaConfigPath(persona = 'elysia', root = personaDataRoot()): string {
  return join(personaConfigsDir(root), `${safePersonaId(persona)}.json`);
}

/** `elysia/profiles/` —— 画像正文与 `index.json` 的所在。 */
export function profilesDir(root = personaDataRoot()): string {
  return join(root, 'elysia', 'profiles');
}

/** `profiles/index.json`（按 userId 记录 lastMentionedTags / coldStartUntil）。 */
export function profilesIndexPath(root = personaDataRoot()): string {
  return join(profilesDir(root), 'index.json');
}

/**
 * `profiles/{userId}.md`（画像正文）。
 * **userId 非法（净化后为空/全 `_`）→ 返回空串**（调用方必须判空）。
 */
export function profilePath(userId: string, root = personaDataRoot()): string {
  const id = sanitizeId(userId);
  if (!id) return '';
  return join(profilesDir(root), `${id}.md`);
}

/** `elysia/` 根（人格维度的容器）。 */
export function personaScopeDir(root = personaDataRoot()): string {
  return join(root, 'elysia');
}

/** `state/` 根。 */
export function stateDir(root = personaDataRoot()): string {
  return join(root, 'state');
}

/** `state/heartbeat/`。 */
export function heartbeatDir(root = personaDataRoot()): string {
  return join(stateDir(root), 'heartbeat');
}

/**
 * `state/heartbeat/{groupId}.json`。
 * **groupId 非法 → 返回空串**（调用方必须判空）。
 */
export function heartbeatPath(groupId: string, root = personaDataRoot()): string {
  const id = sanitizeId(groupId);
  if (!id) return '';
  return join(heartbeatDir(root), `${id}.json`);
}

/** `state/relationships/`。 */
export function relationshipsDir(root = personaDataRoot()): string {
  return join(stateDir(root), 'relationships');
}

/**
 * `state/relationships/{groupId}.json`。
 * **groupId 非法 → 返回空串**（调用方必须判空）。
 */
export function relationshipsPath(groupId: string, root = personaDataRoot()): string {
  const id = sanitizeId(groupId);
  if (!id) return '';
  return join(relationshipsDir(root), `${id}.json`);
}

/** `state/profile-events/`。 */
export function profileEventsDir(root = personaDataRoot()): string {
  return join(stateDir(root), 'profile-events');
}

/**
 * `state/profile-events/{userId}.json`。
 * **userId 非法 → 返回空串**（调用方必须判空）。
 */
export function profileEventsPath(userId: string, root = personaDataRoot()): string {
  const id = sanitizeId(userId);
  if (!id) return '';
  return join(profileEventsDir(root), `${id}.json`);
}

/** `state/extraction-state.json`。 */
export function extractionStatePath(root = personaDataRoot()): string {
  return join(stateDir(root), 'extraction-state.json');
}

/** `configs/`（字典文件所在）。 */
export function configsDir(root = personaDataRoot()): string {
  return join(root, 'configs');
}

/**
 * 字典文件路径（配置里的相对路径相对 `PERSONA_DATA_ROOT`）。
 *
 * **逃逸防护**：`relative` 为绝对路径、或解析后落在 root 之外（`../` 穿越）→ 返回空串。
 * 空串会让 `readJsonSafe` 直接返回 undefined，等价于「字典缺失 → 降级」，不抛错。
 */
export function dictPath(relative: string, root = personaDataRoot()): string {
  const rel = String(relative || '').trim();
  if (!rel) return '';
  if (isAbsolute(rel)) return '';
  const base = resolve(root);
  const target = resolve(base, rel);
  if (target !== base && !target.startsWith(`${base}${sep}`)) return '';
  return target;
}

/**
 * 身份净化（groupId / userId 拼路径前必过）。
 *
 * @returns 净化后的字符串；为空或全 `_` 时返回 `null`（调用方拒绝并 warn）。
 */
export function sanitizeId(raw: unknown): string | null {
  const s = String(raw ?? '')
    .trim()
    .replace(/[^A-Za-z0-9_-]/gu, '_');
  if (!s || /^_+$/u.test(s)) return null;
  return s;
}

/** 人格名（目录/文件名用）：保留中文与常见符号，去掉路径分隔符。 */
export function safePersonaId(raw: unknown): string {
  const s = String(raw ?? '')
    .trim()
    .replace(/[\\/:*?"<>|\u0000-\u001f]/gu, '_')
    .replace(/\s+/gu, '_')
    .replace(/^\.+|\..+$/gu, '');
  return s || 'elysia';
}
