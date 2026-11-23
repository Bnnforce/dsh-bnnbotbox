/**
 * own-time — 「她自己的时间」静默唤醒（2026-11-16，P1）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 解决什么问题
 *
 * 实测发现：她的生活是「随机抽卡」而不是「过日子」——
 *   · 每天抽 4 条生活事件，明天全部换新，互不相关
 *   · 心跳只在「群冷场 + 有人说过话」时触发（heartbeat.ts:389 前置跳过 5 条）
 *   · **没有任何东西叫她「自己待一会儿」**
 *
 * 参考方案（ai-companion-kit《她自己的生活-定时静默唤醒》）：
 *   「给她一个每 2.5 小时响一次的闹钟，响了不跟人说话，只提醒她『现在是你的时间』。」
 *
 * ── 本模块做什么 ───────────────────────────────────────────────────────────
 *   定时检查 → 满足条件 → 生成一条**只进上下文、不产出群消息**的提示。
 *   她拿到提示后干什么由她自己决定（可能想想前两天的事，可能什么都不干）。
 *
 * ── ⚠️ 唯一增加成本的功能（必须严格受控）────────────────────────────────────
 *   每次唤醒 = 1 次 LLM 调用。所以四道闸门：
 *     ① 默认关闭（config.features.ownTime = false）
 *     ② 时段限制（02:00-06:00 装死窗口不叫）
 *     ③ 日上限（默认 4 次）
 *     ④ 间隔下限（默认 2.5h，且受日上限约束）
 *   断电续得上：lastAt/count 落盘，重启不补发（避免一开机连发一堆）。
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** 配置（全部有默认值，缺省即"保守"）。 */
export interface OwnTimeConfig {
  enabled: boolean;
  /** 两次唤醒最小间隔（分钟）。 */
  intervalMin: number;
  /** 每日上限（次）。 */
  dailyMax: number;
  /** 不打扰的时段（小时，左闭右开）。 */
  quietFromHour: number;
  quietToHour: number;
}

export const DEFAULT_OWN_TIME_CONFIG: OwnTimeConfig = {
  enabled: false,        // ★ 默认关闭（唯一产生成本的功能）
  intervalMin: 150,      // 2.5 小时
  dailyMax: 4,
  quietFromHour: 2,      // 02:00
  quietToHour: 6,        // 06:00
};

/** 落盘状态。 */
export interface OwnTimeState {
  /** 最近一次唤醒时刻。 */
  lastAt: number;
  /** 当日已唤醒次数。 */
  count: number;
  /** count 对应的日期（YYYY-MM-DD），跨天自动清零。 */
  day: string;
}

export const EMPTY_OWN_TIME_STATE: OwnTimeState = { lastAt: 0, count: 0, day: '' };

export interface OwnTimeTickInput {
  now: number;
  /** 当前小时（0-23，由调用方按她的时区算）。 */
  hour: number;
  /** 今天（YYYY-MM-DD，她的时区）。 */
  today: string;
  state: OwnTimeState | undefined;
  config?: Partial<OwnTimeConfig>;
}

export interface OwnTimeDecision {
  /** 是否应该唤醒。 */
  fire: boolean;
  /** 不唤醒的原因（诊断用）。 */
  reason: string;
  /** 下一个应检查的时刻（毫秒；仅 fire=false 时有意义）。 */
  nextAt?: number;
  /** 本次唤醒后的新状态（fire=true 时调用方应落盘）。 */
  nextState?: OwnTimeState;
}

/** 是否处于安静时段（支持跨零点区间）。 */
export function inQuietHours(hour: number, cfg: OwnTimeConfig): boolean {
  const from = cfg.quietFromHour;
  const to = cfg.quietToHour;
  if (from === to) return false;                    // 空区间
  if (from < to) return hour >= from && hour < to;  // 同日
  return hour >= from || hour < to;                 // 跨零点
}

/**
 * 判断这一 tick 是否该唤醒。**纯函数**（不读盘、不写盘、不算随机数）。
 */
export function tick(input: OwnTimeTickInput): OwnTimeDecision {
  const cfg: OwnTimeConfig = { ...DEFAULT_OWN_TIME_CONFIG, ...(input.config ?? {}) };
  const now = Number(input.now) || 0;
  const hour = Math.max(0, Math.min(23, Math.floor(Number(input.hour) || 0)));
  const today = String(input.today ?? '');

  // ① 总开关
  if (!cfg.enabled) return { fire: false, reason: 'disabled' };
  // ② 安静时段（她的装死窗口，不打扰）
  if (inQuietHours(hour, cfg)) return { fire: false, reason: 'quiet-hours' };

  // ③ 状态归一（跨天清零）
  const st = input.state && Number.isFinite(input.state.lastAt)
    ? input.state
    : EMPTY_OWN_TIME_STATE;
  const sameDay = st.day === today;
  const count = sameDay ? Math.max(0, Math.floor(Number(st.count) || 0)) : 0;

  // ④ 日上限
  if (count >= cfg.dailyMax) return { fire: false, reason: `daily-max(${count}/${cfg.dailyMax})` };

  // ⑤ 间隔下限（跨天时 lastAt 仍参考，避免刚跨天就立刻叫）
  const gapMs = Math.max(0, Number(cfg.intervalMin) || 0) * 60_000;
  const since = st.lastAt > 0 ? now - st.lastAt : Number.POSITIVE_INFINITY;
  if (since < gapMs) {
    return { fire: false, reason: `interval(${Math.round((gapMs - since) / 60_000)}min left)`, nextAt: st.lastAt + gapMs };
  }

  // ⑥ 通过 → 给新状态
  return {
    fire: true,
    reason: '',
    nextState: { lastAt: now, count: count + 1, day: today },
  };
}

/**
 * 生成注入文本（只进上下文，不产出群消息）。
 *
 * 设计要点：
 *   · 不说"你应该做什么"（那样像任务派发）
 *   · 明确"不用回话、不用汇报"（否则她会为了"有产出"而硬找话说）
 *   · 提一句"前两天的事"（接上 P2 的连续性，让她有自己的线索）
 */
export function ownTimePrompt(recentPast?: string[]): string {
  const lines = [
    '【现在是你自己的时间】没人找你，也不用回谁。',
    '想干嘛干嘛——发会儿呆、想想事情，或者接着前两天那件事继续想。',
    '不用回话，也不用汇报。',
  ];
  const past = (recentPast ?? []).filter((x) => String(x ?? '').trim()).slice(0, 2);
  if (past.length > 0) {
    lines.push('', '你脑子里可能还留着这些：', ...past.map((p) => `- ${p}`));
  }
  return lines.join('\n');
}

/** 状态文件路径。 */
export function ownTimeStatePath(dataRoot: string): string {
  return join(String(dataRoot ?? '').trim(), 'state', 'own-time.json');
}

/** 读状态（失败 → 空状态，绝不抛）。 */
export function readOwnTimeState(dataRoot: string): OwnTimeState {
  try {
    const p = ownTimeStatePath(dataRoot);
    if (!existsSync(p)) return { ...EMPTY_OWN_TIME_STATE };
    const raw = JSON.parse(readFileSync(p, 'utf8')) as Partial<OwnTimeState>;
    return {
      lastAt: Number.isFinite(Number(raw?.lastAt)) ? Number(raw.lastAt) : 0,
      count: Number.isFinite(Number(raw?.count)) ? Math.max(0, Math.floor(Number(raw.count))) : 0,
      day: typeof raw?.day === 'string' ? raw.day : '',
    };
  } catch {
    return { ...EMPTY_OWN_TIME_STATE };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 调度器接入（2026-11-16）
//
// 设计：**独立定时器**，不改现有 heartbeat 状态机（那个工作正常，动它风险大）。
// 每 10 分钟检查一次（而不是每 2.5 小时才检查一次 —— 因为要处理"跨天清零"
// 和"安静时段结束"这些边界，粗粒度会漏）。
//
// ⚠️ 定时器必须 unref：不能让一个"她自己的生活"功能阻止进程退出。
// ═══════════════════════════════════════════════════════════════════════════
import { writeFileSync as _w, renameSync as _r, mkdirSync as _m } from 'node:fs';
import { dirname as _d } from 'node:path';

/** 检查间隔（10 分钟）。 */
const CHECK_INTERVAL_MS = 10 * 60_000;

/** 原子写状态。 */
export function writeOwnTimeState(dataRoot: string, state: OwnTimeState): boolean {
  try {
    const p = ownTimeStatePath(dataRoot);
    _m(_d(p), { recursive: true });
    _w(p + '.tmp', JSON.stringify(state), 'utf8');
    _r(p + '.tmp', p);
    return true;
  } catch {
    return false;
  }
}

export interface OwnTimeHooks {
  /** 投递提示（把文本送进她的上下文）。返回 false = 投递失败，不计次。 */
  deliver: (text: string) => Promise<boolean> | boolean;
  /** 取「前两天的事」用于提示（可选）。 */
  recentPast?: () => string[];
  /** 当前时刻（测试注入）。 */
  now?: () => number;
  /** 当前小时（测试注入；缺省按 +08 算）。 */
  hourOf?: (now: number) => number;
  /** 今天日期（测试注入）。 */
  todayOf?: (now: number) => string;
  logger?: { info?: (m: string) => void; warn?: (m: string) => void };
  /** 诊断记录（由 index 注入，避免本模块依赖 feature-diag 造成环）。 */
  onDiag?: (rec: { on: boolean; reason: string; detail?: Record<string, unknown> }) => void;
}

/**
 * 启动「她自己的时间」调度器。返回停止函数。
 *
 * **默认不启动**（config.enabled=false 时立即返回空停止函数，零开销）。
 */
export function startOwnTime(dataRoot: string, cfg: Partial<OwnTimeConfig>, hooks: OwnTimeHooks): () => void {
  const config: OwnTimeConfig = { ...DEFAULT_OWN_TIME_CONFIG, ...cfg };
  if (!config.enabled) {
    hooks.logger?.info?.('[r4] 自己的时间：未启用（默认关闭）');
    return () => { /* noop */ };
  }
  const nowFn = hooks.now ?? (() => Date.now());
  const hourOf = hooks.hourOf ?? ((n: number) => new Date(n + 8 * 3600_000).getUTCHours());
  const todayOf = hooks.todayOf ?? ((n: number) => new Date(n + 8 * 3600_000).toISOString().slice(0, 10));
  let timer: ReturnType<typeof setInterval> | undefined;
  let stopped = false;

  const check = (): void => {
    if (stopped) return;
    try {
      const now = nowFn();
      const state = readOwnTimeState(dataRoot);
      const d = tick({ now, hour: hourOf(now), today: todayOf(now), state, config });
      if (!d.fire) {
        hooks.onDiag?.({ on: false, reason: d.reason });
        return;
      }
      const past = (() => { try { return hooks.recentPast?.() ?? []; } catch { return []; } })();
      const text = ownTimePrompt(past);
      Promise.resolve()
        .then(() => hooks.deliver(text))
        .then((ok) => {
          if (!ok) {
            // 投递失败 → **不记次**（下次还会再试，符合"不丢"约束）
            hooks.onDiag?.({ on: false, reason: 'deliver-failed' });
            return;
          }
          if (d.nextState) writeOwnTimeState(dataRoot, d.nextState);
          hooks.onDiag?.({ on: true, reason: '', detail: { chars: [...text].length, count: d.nextState?.count } });
          hooks.logger?.info?.('[r4] 自己的时间：已投递（今日第 ' + String(d.nextState?.count) + '/' + String(config.dailyMax) + ' 次）');
        })
        .catch((err) => { hooks.onDiag?.({ on: false, reason: 'deliver-error', detail: { err: String(err) } }); });
    } catch (err) {
      hooks.logger?.warn?.('[r4] 自己的时间：检查异常（已跳过）：' + (err instanceof Error ? err.message : String(err)));
    }
  };

  // ★ 2026-11-16 修：setInterval **不会立即执行**第一次，要等满 10 分钟。
  //   原来只 setInterval → 重启后 10 分钟内完全静默，看起来像"功能没生效"。
  //   现在：延迟 5 秒先跑一次（等 agent 装配完成），之后按 10 分钟节律。
  //   30 秒只是为了避开插件初始化竞争，不影响 tick 的 150 分钟间隔判断。
  const startupTimer = setTimeout(() => {
    if (stopped) return;
    // 启动补跑用 onDiag 留痕（证明定时器真的起来了）
    try { hooks.onDiag?.({ on: false, reason: 'startup-check' }); } catch { /* ignore */ }
    check();
  }, 5_000);
  startupTimer.unref?.();
  timer = setInterval(check, CHECK_INTERVAL_MS);
  timer.unref?.();
  hooks.logger?.info?.('[r4] 自己的时间：已启用（间隔 ' + String(config.intervalMin) + 'min，日上限 ' + String(config.dailyMax) + '）');
  return () => { stopped = true; if (startupTimer) clearTimeout(startupTimer); if (timer) clearInterval(timer); timer = undefined; };
}
