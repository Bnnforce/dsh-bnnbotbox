/**
 * dsh-bnnbotbox — 主入口
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 这个包合并了原来的两个插件：
 *
 *   · dsh-anti-ai-persona v2.6.0  →  lib/persona/   人格本体
 *   · dsh-qq-memory        v0.1.4  →  lib/memory/    群记忆
 *
 * ── 为什么要合并 ───────────────────────────────────────────────────────────
 *
 *   1. **消除脆弱依赖**
 *      原来 qq-memory 用 `inject: ['persona']` 依赖 persona 服务。
 *      persona 未就绪时 qq-memory 的 fiber 一直是 PENDING（实测状态）。
 *      合并后是同一进程内的直接调用，不存在就绪时序问题。
 *
 *   2. **统一人物视图**
 *      persona 存「用户画像」（elysia/profiles/*.md），
 *      memory 存「人物卡」（group-memory/.../entities/people/*.md），
 *      两份内容都描述"这个人是谁"，分开维护有同步风险。
 *
 *   3. **部署简化**
 *      从装 2 个包变 1 个，配置从 2 处变 1 处。
 *
 * ── 加载顺序（重要）────────────────────────────────────────────────────────
 *
 *   persona 必须先 apply：
 *     · 它提供 PersonaService（session-map 持有者）
 *     · memory 要用它解析 scope（哪个群 → 哪个人格 → 哪份记忆）
 *
 *   但两者都是独立 apply，互不阻塞：
 *     · persona 失败 → memory 仍尝试运行（降级：scope 解析返回空）
 *     · 任一失败都不影响另一个（隔离 try-catch）
 * ═══════════════════════════════════════════════════════════════════════════
 */

import { resolveQqbotDataRoot, resolveDataRoot, workspaceRootOf } from './shared/paths.js';
import { ensureDefaultPersona } from './shared/bootstrap-persona.js';

// 两个子模块
import * as personaModule from './persona/index.js';
import * as memoryModule from './memory/index.js';

export const name = 'bnnbotbox';

/**
 * 依赖声明。
 *
 * 注意：**不再需要 `persona`**——它现在是本包内部的模块，不是外部服务。
 * 只保留宿主提供的能力。
 */
export const inject = ['systemPrompt', 'llm', 'tools'];

/** 合并两套 Config schema（persona 在前，memory 挂子键）。 */
// 先 import 再导出：default 里要用到同一个绑定（re-export 在模块内不可见）
import { Config as ConfigSchema, resolveConfig as resolveConfigFn } from './config.js';
import { installSettingsRoute } from './settings-route.js';

/** 配置 schema（宿主据此推导设置面板表单；必须同时在 default 导出里）。 */
export const Config = ConfigSchema;
/** 配置解析（合并 persona + memory）。 */
export const resolveConfig = resolveConfigFn;

/**
 * 插件入口。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} rawConfig
 */
export function apply(ctx, rawConfig) {
  const config = rawConfig ?? {};
  const logger = ctx.logger ?? {};

  // ── 解析数据根（统一走 shared/paths，零硬编码）────────────────────────────
  const qqbotDataRoot = resolveQqbotDataRoot({
    explicit: config.qqbotDataRoot,
  });
  const dataRoot = resolveDataRoot({
    explicit: config.dataRoot,
  });

  logger.info?.(`[bnnbotbox] qqbot 数据根: ${qqbotDataRoot}`);
  logger.info?.(`[bnnbotbox] 插件数据根: ${dataRoot}`);

  // ── ★ 2026-11-25：把权威路径写进 globalThis 桥，供扩展包复用 ──────────────
  //   背景：扩展包（bnn-custom）有一套自己的 pack-paths.mjs 推导，插件这套
  //   shared/paths.js 的发现链更完整（读 settings / 向上查找 / 多候选）。
  //   两套并存会导致同一部署算出不同的根 ⇒ 数据分裂。
  //   现在插件把「权威结论」挂到全局，扩展包优先读它，读不到才回退自己推导。
  //   桥只写一次（幂等），不持有可变状态，纯数据。
  try {
    const KEY = Symbol.for('bnnbotbox.paths.v1');
    const prev = globalThis[KEY];
    if (!prev || typeof prev !== 'object') {
      globalThis[KEY] = Object.freeze({
        qqbotDataRoot: String(qqbotDataRoot || ''),
        pluginDataRoot: String(dataRoot || ''),
        at: Date.now(),
      });
    }
  } catch { /* 桥写入失败不影响启动 */ }

  // ── ⓪ 全新安装时铺一份最小人格（只在缺失时复制，绝不覆盖）──────────────────
  //   为什么在 persona 之前：catalogFor 要能立刻读到这张卡，否则她会"没有名字"。
  //   为什么不能省：空环境下 prompt 注入找不到角色卡，复盘记录也会挂到不存在的人格上。
  try {
    ensureDefaultPersona({ qqbotDataRoot, logger });
  } catch (err) {
    // 铺不上也只是"没有默认人格"，不影响启动
    logger.warn?.(`[bnnbotbox] 默认人格引导跳过: ${err instanceof Error ? err.message : String(err)}`);
  }

  // ── 生活素材目录推导（开源规范：不写死路径）──────────────────────────────
  //   结构：{WORKSPACE}/Bot/事件库/{morning,afternoon,evening,late_night}.md
  //   优先用配置/环境变量；都没给就从 qqbot 数据根反推。
  let eventsDir = String(config.eventsDir ?? '').trim();
  if (!eventsDir) {
    try {
      const ws = workspaceRootOf(qqbotDataRoot);
      eventsDir = `${ws}/Bot/事件库`;
    } catch {
      eventsDir = '';
    }
  }
  logger.info?.(`[bnnbotbox] 事件库目录: ${eventsDir || '(未配置，生活素材降级)'}`);

  // ── ① 先启动 persona（提供 PersonaService）────────────────────────────────
  let personaService = null;
  let personaApplyOk = false;
  try {
    const personaConfig = {
      ...config,
      qqbotDataRoot,
      dataRoot,
      // ★ 把推导好的事件库目录塞进 life_events，避免 r4 自己再去猜
      life_events: {
        ...(config.life_events ?? {}),
        events_dir: eventsDir,
      },
    };
    personaModule.apply(ctx, personaConfig);
    personaApplyOk = true;
    logger.info?.('[bnnbotbox] persona 模块已启动');
  } catch (err) {
    logger.warn?.(
      `[bnnbotbox] persona 模块启动失败（memory 将降级）: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // 从 ctx 拿 PersonaService（persona 模块构造时会注册到 ctx）
  try {
    personaService = ctx.get?.('persona') ?? null;
  } catch {
    personaService = null;
  }
  if (!personaService) {
    logger.warn?.('[bnnbotbox] persona 服务不可用 → memory 的 scope 解析会返回空');
  }

  // ── ② 再启动 memory（依赖 persona 服务，但失败不阻塞）──────────────────────
  try {
    const memoryConfig = {
      ...(config.memory ?? config),
      qqbotDataRoot,
      // ★ 直接把 persona 服务实例传进去（不再依赖 inject 时序）
      personaService,
    };
    memoryModule.apply(ctx, memoryConfig);
    logger.info?.('[bnnbotbox] memory 模块已启动');
  } catch (err) {
    logger.warn?.(
      `[bnnbotbox] memory 模块启动失败: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // ── ⑤ 设置面板端点（GET/POST /api/bnnbotbox/config）────────────────────
  //   设置面板是浏览器里跑的客户端页，改不了宿主配置，必须有一对端点。
  //   写路径走 configEditor.edit()，绝不自己读写 cordis.patch.yml。
  //   没有 webServer（纯 CLI/非 web profile）时静默跳过。
  //    内部用 ctx.inject(['webServer'], ...) 延迟挂载 —— 不能写成 ctx.get('webServer')，
  //    那个在未声明 inject 时会直接抛 cannot get property without inject（实测端点 404 的原因）。
  try {
    installSettingsRoute(ctx, () => resolveConfigFn(rawConfig ?? {}), logger);
  } catch (err) {
    logger.warn?.(`[bnnbotbox] 设置端点未安装（不影响功能）: ${err instanceof Error ? err.message : String(err)}`);
  }

  logger.info?.(`[bnnbotbox] 启动完成（persona=${personaApplyOk ? 'ok' : 'fail'}）`);
}

/*
 * ⚠️ default 导出里必须带 Config（2026-11-24 修）。
 *
 * DSH 的 Loader.unwrapExports() 是这么取的：
 *     exports = exports.default ?? exports;
 * 也就是说**只要模块有 default 导出，就只用 default**，named 导出一律不看。
 * 我们原来 default 只有 { name, inject, apply }，于是宿主：
 *     configOf(plugin) → Reflect.get(plugin, 'Config') → undefined
 *   ⇒ 设置面板拿不到 schema，该条目状态变成 absent（无法在界面上配置）。
 * 把 Config / resolveConfig 一起放进 default 后，状态才会是 schema。
 */
export default { name, inject, Config: ConfigSchema, resolveConfig: resolveConfigFn, apply };