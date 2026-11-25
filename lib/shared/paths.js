/**
 * shared/paths — 统一路径推导（零硬编码，开源可移植）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么需要这一层：
 *
 *   合并前，两个插件各有自己的路径推导，且都含作者环境硬编码：
 *     · persona/lib/paths-runtime.js:50  push('{WORKSPACE_ROOT}/Bot/dshqqbot')
 *     · qq-memory/lib/index.js:58        push('{WORKSPACE_ROOT}/Bot/dshqqbot')
 *
 *   这些是「多级兜底链」的最后一环，功能上不致命，但违反开源规范
 *   （别人机器上这个路径不存在）。
 *
 * ── 推导链（按优先级）──────────────────────────────────────────────────────
 *
 *   1. 显式传入（config）
 *   2. 环境变量 QQBOT_DATA_ROOT
 *   3. DSH_HOME 推导
 *   4. 从 cwd 向上找（含 .qqbot 目录的即为数据根）
 *   5. 标准位置 ~/.dsh-qqbot
 *
 *   全部失败 → 返回第一个候选（让上层报可读错误），绝不硬编码作者路径。
 * ═══════════════════════════════════════════════════════════════════════════
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/** 判断目录是否是有效 qqbot 数据根（有 .qqbot/msg-history）。 */
function isValidQqbotRoot(dir) {
  if (!dir) return false;
  try {
    return statSync(join(dir, '.qqbot', 'msg-history')).isDirectory();
  } catch {
    return false;
  }
}


/**
 * 从各 profile 的 qqbot-settings 里读 dataRoot。
 *
 * 为什么单独抽出来：
 *   · 生产配置的真实来源是 `{DSH_HOME}/qqbot-settings/web/im-qqbot-*.json`
 *   · 但测试常把 DSH_HOME 指向临时目录做隔离 —— 此时 DSH_HOME 下没有这份配置
 *   · 所以**额外**扫真实 home，保证「隔离测试」不影响数据根解析
 *
 * @returns {string[]} 找到的 dataRoot 候选（按出现顺序）
 */
export function dataRootsFromSettings() {
  const out = [];
  const bases = new Set();
  const envHome = String(process.env.DSH_HOME ?? '').trim();
  if (envHome) bases.add(envHome);
  // 真实 home 也扫（测试隔离时 DSH_HOME 是临时目录，但生产配置仍在真实 home）
  try { bases.add(join(homedir(), '.dsh')); } catch { /* ignore */ }

  for (const base of bases) {
    const settingsRoot = join(base, 'qqbot-settings');
    let profiles;
    try { profiles = readdirSync(settingsRoot); } catch { continue; }
    for (const prof of profiles) {
      const dir = join(settingsRoot, prof);
      let files;
      try { files = readdirSync(dir).filter((f) => f.endsWith('.json') && !f.endsWith('.writer.json')); } catch { continue; }
      for (const f of files) {
        try {
          const j = JSON.parse(readFileSync(join(dir, f), 'utf8'));
          if (typeof j?.dataRoot === 'string' && j.dataRoot.trim()) {
            if (!out.includes(j.dataRoot.trim())) out.push(j.dataRoot.trim());
          }
        } catch { /* 坏 json 跳过 */ }
      }
    }
  }
  return out;
}

/**
 * 从某个起点向上找 qqbot 数据根。
 *
 * @param {string} start 起始目录
 * @param {number} [maxDepth=6] 最多上溯几层
 * @returns {string|null}
 */
export function findQqbotRootUpward(start, maxDepth = 6) {
  let cur = resolve(start || '.');
  for (let i = 0; i < maxDepth; i++) {
    if (isValidQqbotRoot(cur)) return cur;
    const up = dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  return null;
}

/**
 * 解析 qqbot 数据根（多级兜底，无硬编码）。
 *
 * @param {object} [opts]
 * @param {string} [opts.explicit] 显式指定（配置里的 qqbotDataRoot）
 * @param {string} [opts.cwd] 起始查找目录（默认 process.cwd()）
 * @returns {string} 数据根绝对路径（可能不存在，需上层校验）
 */
export function resolveQqbotDataRoot(opts = {}) {
  // 语义（2026-11-20 修）：显式指定 > 环境变量 > 自动发现
  //   显式/环境变量是「用户明确要的」，直接返回，不走发现链。
  //   否则测试隔离（QQBOT_DATA_ROOT=临时目录）会被发现链里的真实路径覆盖。
  const explicit = String(opts.explicit ?? '').trim();
  if (explicit) return resolve(explicit);

  const envRoot = String(process.env.QQBOT_DATA_ROOT ?? '').trim();
  if (envRoot) return resolve(envRoot);

  // ── 以下为自动发现（按可信度排序）──
  const candidates = [];

  // ① 从 qqbot-settings 读（生产配置的真实来源）
  for (const r of dataRootsFromSettings()) candidates.push(r);

  // ② BOT_DATA_ROOT 兜底
  const botRoot = String(process.env.BOT_DATA_ROOT ?? '').trim();
  if (botRoot) candidates.push(botRoot);

  // ③ DSH_HOME 推导
  const dshHome = String(process.env.DSH_HOME ?? '').trim();
  if (dshHome) candidates.push(join(dshHome, 'qqbot'));

  // ④ 从 cwd 向上找
  const upward = findQqbotRootUpward(opts.cwd || process.cwd());
  if (upward) candidates.push(upward);

  // ⑤ 标准位置
  candidates.push(join(homedir(), '.dsh-qqbot'));

  // 返回第一个「有效」的
  for (const c of candidates) {
    if (!c) continue;
    const abs = resolve(c);
    if (isValidQqbotRoot(abs)) return abs;
  }

  // 都不有效 → 返回第一个非空候选（让上层报可读错误，不抛）
  for (const c of candidates) {
    if (c) return resolve(c);
  }
  return resolve(join(homedir(), '.dsh-qqbot'));
}

/**
 * 解析 persona/memory 的数据根（插件自己的数据目录）。
 *
 * 优先级：
 *   1. PERSONA_DATA_ROOT 环境变量
 *   2. DSH_HOME/data/bnn-botbox
 *   3. ~/.dsh/data/bnn-botbox
 *
 * 兼容：若存在旧目录 dsh-anti-ai-persona，自动沿用（平滑迁移）。
 *
 * @param {object} [opts]
 * @param {string} [opts.explicit]
 * @returns {string}
 */
export function resolveDataRoot(opts = {}) {
  const candidates = [];

  if (opts.explicit) candidates.push(String(opts.explicit));

  const envRoot = String(process.env.PERSONA_DATA_ROOT ?? '').trim();
  if (envRoot) candidates.push(envRoot);

  const dshHome = String(process.env.DSH_HOME ?? '').trim() || join(homedir(), '.dsh');
  candidates.push(join(dshHome, 'data', 'bnn-botbox'));

  // 平滑迁移：旧目录存在就继续用，避免拆散已有数据
  const legacy = join(dshHome, 'data', 'dsh-anti-ai-persona');
  candidates.push(legacy);

  // 已存在的优先（尤其 legacy，保证老数据不丢）
  for (const c of candidates) {
    if (c && existsSync(c)) return resolve(c);
  }
  return resolve(candidates[0]);
}

/**
 * 解析「记忆数据根」（合并前是独立插件 dsh-qq-memory 的目录）。
 *
 * ★ 2026-11-25 新增：合并后记忆侧仍散落着 join(...,'data','dsh-qq-memory') 硬编码，
 *   与 persona 侧同理需要一个统一入口 + 旧目录平滑迁移。
 *
 * 优先级：
 *   1. MEMORY_DATA_ROOT 环境变量
 *   2. persona 根同级（与 resolveDataRoot 保持同一 data/ 父目录）
 *   3. 旧目录 {DSH_HOME}/data/dsh-qq-memory（存在则沿用，老数据不丢）
 *
 * @param {object} [opts]
 * @param {string} [opts.explicit]
 * @returns {string}
 */
export function resolveMemoryRoot(opts = {}) {
  const candidates = [];

  if (opts.explicit) candidates.push(String(opts.explicit));

  const envRoot = String(process.env.MEMORY_DATA_ROOT ?? '').trim();
  if (envRoot) candidates.push(envRoot);

  const dshHome = String(process.env.DSH_HOME ?? '').trim() || join(homedir(), '.dsh');

  // 旧目录优先沿用（合并前的真实位置，老数据都在这儿）
  const legacy = join(dshHome, 'data', 'dsh-qq-memory');
  candidates.push(legacy);

  // 新位置：与 persona 根同父目录（便于统一迁移）
  candidates.push(join(dshHome, 'data', 'bnn-botbox-memory'));

  for (const c of candidates) {
    if (c && existsSync(c)) return resolve(c);
  }
  return resolve(candidates[0]);
}

/**
 * 计算「工作区根」——即 Bot/ 的父目录。
 *
 * 结构：
 *   {WORKSPACE}/Bot/{人格,曲库,事件库}
 *   {WORKSPACE}/Bot/dshqqbot/      ← qqbot 数据根
 *
 * @param {string} qqbotRoot
 * @returns {string}
 */
export function workspaceRootOf(qqbotRoot) {
  // qqbotRoot = .../Bot/dshqqbot → 上两级
  return dirname(dirname(resolve(qqbotRoot)));
}

export default {
  resolveQqbotDataRoot,
  resolveQqbotRootTiered,
  resolveDataRoot,
  findQqbotRootUpward,
  dataRootsFromSettings,
  isValidQqbotRoot,
  hasQqbotDir,
  workspaceRootOf,
};
// ═══════════════════════════════════════════════════════════════════════════
// 分层解析（persona 语义：配置无效则自动发现）
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 判断目录是否有 `.qqbot` 目录（宽松判据：历史可能还没产生 msg-history）。
 *
 * @param {string} dir
 * @returns {boolean}
 */
export function hasQqbotDir(dir) {
  if (!dir) return false;
  try {
    return statSync(join(dir, '.qqbot')).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 分层解析 qqbot 数据根。
 *
 * 与 `resolveQqbotDataRoot` 的区别：
 *   · `resolveQqbotDataRoot`：显式/环境变量**直接返回**（测试隔离语义）
 *   · `resolveQqbotRootTiered`：显式值也要**校验**，无效则自动发现
 *     （persona 语义："配置值无效 → 已自动解析"）
 *
 * 候选顺序（首个命中即用）：
 *   ① 显式配置
 *   ② QQBOT_DATA_ROOT
 *   ③ qqbot-settings 里的 dataRoot
 *   ④ BOT_DATA_ROOT
 *   ⑤ DSH_HOME/qqbot
 *   ⑥ cwd 向上探测
 *   ⑦ ~/.dsh-qqbot
 *
 * 判定顺序：先找有 `.qqbot/msg-history` 的，退一步找有 `.qqbot` 的。
 *
 * @param {string} [explicit] 配置里的 qqbotDataRoot
 * @returns {string} 解析结果（永不抛）
 */
export function resolveQqbotRootTiered(explicit) {
  const candidates = [];
  const push = (v) => {
    const s = String(v ?? '').trim();
    if (!s) return;
    const full = resolve(s);
    if (!candidates.includes(full)) candidates.push(full);
  };

  push(explicit);
  push(process.env.QQBOT_DATA_ROOT);
  for (const r of dataRootsFromSettings()) push(r);
  push(process.env.BOT_DATA_ROOT);

  const dshHome = String(process.env.DSH_HOME ?? '').trim();
  if (dshHome) push(join(dshHome, 'qqbot'));

  const upward = findQqbotRootUpward();
  if (upward) push(upward);

  push(join(homedir(), '.dsh-qqbot'));

  // 两轮判定：严格 → 宽松
  for (const c of candidates) if (isValidQqbotRoot(c)) return c;
  for (const c of candidates) if (hasQqbotDir(c)) return c;

  // 都不命中 → 返回显式值（让上层报可读错误）
  return candidates[0] || resolve(join(homedir(), '.dsh-qqbot'));
}

/**
 * 展开 `~` 前缀（不抛）。
 *
 * @param {string} p
 * @returns {string}
 */
export function expandHomeSafe(p) {
  const s = String(p ?? '').trim();
  if (!s) return '';
  if (s === '~') return homedir();
  if (s.startsWith('~/')) return join(homedir(), s.slice(2));
  return s;
}
