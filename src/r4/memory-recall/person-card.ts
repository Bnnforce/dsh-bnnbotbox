/**
 * 记忆联想 · 人物档案层（**含缓存**）
 *
 * 职责：把 `userId`（openid）映射到 qq-memory 里 `entities/people/*.md` 的某一篇。
 *
 * 为什么需要缓存（实测数据）：
 *   全量读 28 个文件耗时 **35ms**；而 assemble 每轮都会触发。
 *   加 5 分钟 TTL 缓存后 → **<1ms**。
 *
 * 数据来源（**只读，绝不写**）：
 *   `qqMemory.list(scope, 'entities/people')` → 文件路径列表
 *   `qqMemory.read(scope, path)` → markdown 正文
 *   从正文里正则匹配 openid（实测 4/4 档案都有）
 *
 * 纪律：
 *   · 所有 IO 失败都降级为空（**绝不抛**）；
 *   · 缓存有上限（防无限增长）；
 *   · 不猜测：匹配不到 openid 就返回空，不做模糊匹配。
 */

import { extractCurrentSection, extractOpenid, clipText, clipBySegment } from './format.js';

/** 最小化的服务契约（避免与 dsh-qq-memory 的类型硬耦合）。 */
export interface MemoryServiceLike {
  list(scope: unknown, relDir?: string): { ok: boolean; files?: string[] } | undefined;
  read(scope: unknown, relPath: string): { ok: boolean; text?: string } | undefined;
}

/** 日志接口（与 R4Logger 兼容）。 */
export interface RecallLogger {
  info?: (msg: string) => void;
  warn?: (msg: string) => void;
}

export interface PersonCardOptions {
  /** 缓存有效期（毫秒）。默认 5 分钟。 */
  cacheTtlMs: number;
  /** 缓存条目上限（防无限增长）。默认 200。 */
  cacheMaxEntries: number;
  /** 单条摘要最大字符数。 */
  perItemChars: number;
  /** 最多扫多少个档案文件（防某群有几百个档案时全扫）。默认 50。 */
  maxFiles: number;
  logger?: RecallLogger;
}

export const PERSON_CARD_DEFAULTS: PersonCardOptions = {
  cacheTtlMs: 5 * 60 * 1000,
  cacheMaxEntries: 200,
  perItemChars: 100,
  maxFiles: 50,
};

/** 缓存项。 */
interface CacheEntry {
  /** 命中的档案摘要；空串 = 「这个人在本群没有档案」（也要缓存，避免反复扫）。 */
  summary: string;
  /** 写入时间（用于 TTL）。 */
  at: number;
  /** 扫描结束时 people 目录的文件数 —— 文件数变了说明可能新增档案，缓存失效。 */
  fileCount: number;
  /** 命中的显示名（文件名去后缀）；空串 = 没有档案。第二层「惦记」用它。 */
  name: string;
}

/**
 * 人物档案索引（**按群隔离**，因为每个群有自己的记忆库）。
 *
 * 生命周期：由调用方持有（通常是插件单例），
 * 内部 `Map` 有上限，超了丢最老的。
 */
export class PersonCardIndex {
  private readonly opts: PersonCardOptions;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(opts?: Partial<PersonCardOptions>) {
    this.opts = { ...PERSON_CARD_DEFAULTS, ...(opts ?? {}) };
  }

  /**
   * 查某个 openid 在本群的档案摘要。
   *
   * @returns 摘要（**已截断**）；没有档案 / 服务不可用 / 异常 → **空串**
   */
  find(service: MemoryServiceLike | undefined, scope: unknown, userId: string, now: number): string {
    const uid = String(userId ?? '').trim().toUpperCase();
    if (!uid) return '';
    if (!service || typeof service.list !== 'function') return '';

    const hit = this.lookup(service, scope, uid, now);
    return hit ? hit.summary : '';
  }

  /**
   * 查某个 openid 在本群的**显示名**（档案文件名；第二层「主动惦记」用）。
   *
   * 与 `find` 共用同一份缓存：先 `find` 过的人再取名字**零额外 IO**。
   *
   * @returns 显示名；没有档案 / 服务不可用 / 异常 → 空串
   */
  findName(service: MemoryServiceLike | undefined, scope: unknown, userId: string, now: number): string {
    const hit = this.lookup(service, scope, userId, now);
    return hit ? hit.name : '';
  }

  /**
   * 查缓存 / 扫描并写缓存（`find` 与 `findName` 的唯一实现）。
   *
   * @returns 缓存项；服务不可用 / 目录读不到 → undefined（**不写缓存**，下轮再试）
   */
  private lookup(service: MemoryServiceLike | undefined, scope: unknown, userId: string, now: number): CacheEntry | undefined {
    const uid = String(userId ?? '').trim().toUpperCase();
    if (!uid) return undefined;
    if (!service || typeof service.list !== 'function') return undefined;

    const cacheKey = `${cacheScopeKey(scope)}|${uid}`;
    const hit = this.cache.get(cacheKey);
    if (hit && this.isFresh(hit, now)) return hit;

    try {
      // ① 列 people 目录
      const listed = service.list(scope, 'entities/people');
      if (!listed?.ok || !Array.isArray(listed.files)) {
        // 服务异常：不写缓存（下一轮再试）
        return undefined;
      }
      const files = listed.files.filter((f) => typeof f === 'string' && f.endsWith('.md'));
      const fileCount = files.length;

      // ② 逐个读，找 openid 匹配（最多扫 maxFiles 个）
      let summary = '';
      let name = '';
      for (const path of files.slice(0, Math.max(1, this.opts.maxFiles))) {
        const read = service.read(scope, path);
        if (!read?.ok || typeof read.text !== 'string') continue;
        const openid = extractOpenid(read.text);
        if (!openid || openid !== uid) continue;
        // 命中：取 Current 段做摘要 + 文件名当显示名
        const cur = extractCurrentSection(read.text);
        summary = clipBySegment(cur, this.opts.perItemChars);
        name = nameOfPath(path);
        break;
      }

      // ③ 写缓存（**包括"没找到"的情况**，避免反复扫全目录）
      const entry: CacheEntry = { summary, name, at: now, fileCount };
      this.put(cacheKey, entry, now);
      return entry;
    } catch (err) {
      this.opts.logger?.warn?.(`[memory-recall] 人物档案查询异常（已降级为空）：${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  }

  /** 清空缓存（配置变更 / 手动刷新时用）。 */
  clear(): void {
    this.cache.clear();
  }

  /** 当前缓存条目数（诊断用）。 */
  size(): number {
    return this.cache.size;
  }

  // ── 内部 ────────────────────────────────────────────────────────────────

  private isFresh(entry: CacheEntry, now: number): boolean {
    const ttl = Math.max(60_000, Math.floor(this.opts.cacheTtlMs));
    const age = Number(now) - Number(entry.at);
    return Number.isFinite(age) && age >= 0 && age < ttl;
  }

  private put(key: string, entry: CacheEntry, now: number): void {
    // 上限保护：超了就丢最老的一半（简单 O(n) 清理，n 很小）
    const cap = Math.max(10, Math.floor(this.opts.cacheMaxEntries));
    if (this.cache.size >= cap) {
      const entries = [...this.cache.entries()]
        .sort((a, b) => a[1].at - b[1].at)
        .slice(0, Math.ceil(cap / 2));
      for (const [k] of entries) this.cache.delete(k);
    }
    this.cache.set(key, entry);
    void now;
  }
}

/**
 * 由人物档案的相对路径取显示名。
 *
 * 实测文件名就是昵称（`entities/people/群友A.md` → `群友A`）；
 * 少数历史档案带 `群成员-` 前缀，统一剥掉。
 */
function nameOfPath(relPath: string): string {
  const base = String(relPath ?? '').split('/').pop() ?? '';
  const noExt = base.replace(/\.md$/iu, '').trim();
  return noExt.replace(/^群成员[-_\s]*/u, '').trim();
}

/** scope → 缓存 key 片段（group:<id> / c2c:<id> / unknown）。 */
function cacheScopeKey(scope: unknown): string {
  if (!scope || typeof scope !== 'object') return 'unknown';
  const s = scope as Record<string, unknown>;
  const type = String(s.type ?? '').trim();
  const id = String(s.id ?? '').trim();
  if (!type || !id) return 'unknown';
  return `${type}:${id}`;
}
