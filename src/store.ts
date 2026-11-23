import { copyFileSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

export function dshHome(): string {
  return process.env.DSH_HOME || join(homedir(), '.dsh');
}

/** 防止群号被当成路径；正常群号是 hex / 字母数字。 */
export function safeGroupId(groupId: string): string {
  const s = String(groupId || '').trim().replace(/[^0-9A-Za-z_-]/gu, '_');
  return s || 'unknown';
}

export function guidelineDir(): string {
  return join(dshHome(), 'data', 'dsh-anti-ai-persona', 'guidelines');
}

/** V2：每个群一个文件：data/dsh-anti-ai-persona/guidelines/{group_id}.md */
export function guidelinePath(groupId: string): string {
  return join(guidelineDir(), `${safeGroupId(groupId)}.md`);
}

export function readGuidelineSync(groupId: string): string {
  try {
    return readFileSync(guidelinePath(groupId), 'utf8').trim();
  } catch {
    return '';
  }
}

/** 返回 mtime（毫秒）；文件不存在返回 null。 */
export function guidelineMtimeMs(groupId: string): number | null {
  try {
    return statSync(guidelinePath(groupId)).mtimeMs;
  } catch {
    return null;
  }
}

/** 列出已有的 group guideline 文件名（去掉 .md）。 */
export function listGuidelineGroupIds(): string[] {
  try {
    return readdirSync(guidelineDir())
      .filter((f) => f.endsWith('.md'))
      .map((f) => f.slice(0, -3));
  } catch {
    return [];
  }
}

/** 原子写入：先写同目录临时文件，再 rename，避免读到半截文件。 */
export function writeGuidelineSync(groupId: string, text: string): void {
  const target = guidelinePath(groupId);
  mkdirSync(dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, text.trimEnd() + '\n', 'utf8');
  renameSync(tmp, target);
}

/** 防止人格名被当成路径；中文保留。 */
export function safePersonaName(persona: string): string {
  const s = String(persona || '').trim()
    .replace(/[\\/:*?"<>|\u0000-\u001f]/gu, '_')
    .replace(/\s+/gu, '_')
    .replace(/^\.+|\..+$/gu, '');
  return s || 'default';
}

export function overlayDir(): string {
  return join(dshHome(), 'data', 'dsh-anti-ai-persona', 'overlay');
}

export function overlayHistoryDir(): string {
  return join(dshHome(), 'data', 'dsh-anti-ai-persona', 'overlay-history');
}

/**
 * 全局兜底：data/.../overlay.md
 * 按人格：data/.../overlay/{group_id}_{persona_name}.md
 */
export function overlayPath(groupId = '', persona = ''): string {
  if (groupId && persona) {
    return join(overlayDir(), `${safeGroupId(groupId)}_${safePersonaName(persona)}.md`);
  }
  return join(dshHome(), 'data', 'dsh-anti-ai-persona', 'overlay.md');
}

/** 只读指定群+人格文件，不回落到全局；复盘合并时使用。 */
export function readOverlayExactSync(groupId = '', persona = ''): string {
  try {
    return readFileSync(overlayPath(groupId, persona), 'utf8').trim();
  } catch {
    return '';
  }
}

/** 按群+人格读取；找不到自动回落到全局 overlay.md。 */
export function readOverlaySync(groupId = '', persona = ''): string {
  if (groupId && persona) {
    try {
      const text = readFileSync(overlayPath(groupId, persona), 'utf8').trim();
      if (text) return text;
    } catch { /* fall through to global */ }
  }
  try {
    return readFileSync(overlayPath(), 'utf8').trim();
  } catch {
    return '';
  }
}

function pruneBackups(scope: string): void {
  try {
    const hist = overlayHistoryDir();
    const prefix = `${scope}-`;
    const backups = readdirSync(hist)
      .filter((f) => f.startsWith(prefix) && /^.+\d{4}-\d{2}-\d{2}\.md$/u.test(f))
      .sort()
      .reverse();
    for (const oldFile of backups.slice(3)) {
      try { unlinkSync(join(hist, oldFile)); } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}

/**
 * 写入 overlay；groupId + persona 都存在时写按人格文件，否则写全局兜底。
 * 旧文件会备份到 overlay-history/{scope}-YYYY-MM-DD.md，最多保留 3 份。
 */
export function writeOverlaySync(text: string, groupId = '', persona = ''): void {
  const target = overlayPath(groupId, persona);
  const scope = groupId && persona ? `${safeGroupId(groupId)}_${safePersonaName(persona)}` : 'overlay';
  mkdirSync(dirname(target), { recursive: true });
  try {
    const old = readFileSync(target, 'utf8').trim();
    if (old) {
      const hist = overlayHistoryDir();
      mkdirSync(hist, { recursive: true });
      const day = new Date().toISOString().slice(0, 10);
      copyFileSync(target, join(hist, `${scope}-${day}.md`));
      pruneBackups(scope);
    }
  } catch { /* first run / backup best effort */ }
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, text.trimEnd() + '\n', 'utf8');
  renameSync(tmp, target);
}
