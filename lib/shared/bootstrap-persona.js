/**
 * bootstrap-persona — 全新安装时铺一份最小可用人格
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么要这个（2026-11-23 真实需求）
 *
 *   插件在全新环境（没有人格卡、没有 persona-config.json）里是能启动的，
 *   但「没有人格」对使用者是个黑洞：
 *     · prompt 注入按名字找不到卡 → 她不知道自己是谁
 *     · 复盘记录挂到一个不存在的人格名
 *     · 以前更糟：代码兜底写死 '比安安'，凭空造出一个并不存在的人格
 *
 *   所以改成：**首次运行就铺一份「最小默认人格」**（assets/default-persona/），
 *   让任何全新部署开箱就有个能说话的身份，而不是空着。
 *
 * ── 铁律（这几条决定了它安全）──────────────────────────────────────────────
 *
 *   ① **只在目标不存在时复制**。已有的人格卡 / 配置一个字都不碰。
 *   ② 复制完不写回仓库、不改源（assets 是只读模板）。
 *   ③ 任何失败只 warn，绝不阻塞插件启动。
 *   ④ 默认人格只是**占位**：文件里写明了「换成你自己的角色卡」。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { existsSync, mkdirSync, copyFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 本包内模板目录（assets/default-persona/） */
const ASSETS_DIR = join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))), 'assets', 'default-persona');

/** 递归列文件（相对路径）；目录不存在返回 [] */
function listFiles(dir, base = dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) listFiles(p, base, out);
    else if (e.isFile()) out.push(p.slice(base.length + 1));
  }
  return out;
}

/**
 * 确保工作区里有一份最小人格。
 *
 * 目标位置：**`dirname(qqbotDataRoot)/人格/`** —— 必须和 persona.js 的 catalogFor 读的
 * 完全同一个路径（它就是用 dirname(dataRoot) 拼的）。差一层目录就会出现
 * 「引导铺好了，但 catalog 读不到」的诡异现象（2026-11-23 踩过）。
 *
 * @param {object} opts
 * @param {string} opts.qqbotDataRoot QQBot 数据根（如 .../Bot/dshqqbot）
 * @param {object} [opts.logger] 至少要有 info/warn
 * @returns {{ok:boolean, created:string[], skipped:string[], reason?:string}}
 */
export function ensureDefaultPersona({ qqbotDataRoot, logger } = {}) {
  const out = { ok: false, created: [], skipped: [] };

  if (!qqbotDataRoot) {
    out.reason = 'no-qqbot-root';
    return out;
  }
  if (!existsSync(ASSETS_DIR)) {
    out.reason = 'no-assets';
    logger?.warn?.(`[bootstrap-persona] 模板目录不存在，跳过：${ASSETS_DIR}`);
    return out;
  }

  // ⚠️ 必须与 persona.js catalogFor 完全一致：join(dirname(dataRoot), '人格')
  const personaDir = join(dirname(qqbotDataRoot), '人格');
  const files = listFiles(ASSETS_DIR);

  for (const rel of files) {
    const src = join(ASSETS_DIR, rel);
    const dst = join(personaDir, rel);

    // ① 目标已存在 → 一个字都不碰
    if (existsSync(dst)) {
      out.skipped.push(rel);
      continue;
    }

    try {
      mkdirSync(dirname(dst), { recursive: true });
      copyFileSync(src, dst);
      out.created.push(rel);
    } catch (err) {
      out.skipped.push(rel);
      logger?.warn?.(`[bootstrap-persona] 复制失败 ${rel}：${err?.message ?? err}`);
    }
  }

  out.ok = true;

  if (out.created.length) {
    logger?.info?.(
      `[bootstrap-persona] 已铺最小默认人格 ${out.created.length} 个文件 `
      + `（${out.created.join(', ')}）→ ${personaDir}`,
    );
    logger?.info?.('[bootstrap-persona] 这是占位人格，想换：改「人格/角色卡/」下的卡，并把 persona-config.json 的 defaultPersona 指过去');
  }

  return out;
}

export default { ensureDefaultPersona };
