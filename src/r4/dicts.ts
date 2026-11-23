/**
 * R4.0 字典加载（阶段一基建）。
 *
 * 图纸 1.1「字典文件说明」：
 *  - 路径均相对 `PERSONA_DATA_ROOT`；格式为字符串数组或分组对象；缺失时 warn 降级。
 *  - 敏感词缺失 → 仅走白名单校验；
 *  - 同义词缺失 → 不做归一化；
 *  - 负面词缺失 → 跳过负面检测；
 *  - 梗词典缺失 → 接梗不计分。
 */

import { readJsonSafe, isPlainObject } from './atomic.js';
import { dictPath } from './paths.js';
import type { Dictionaries, ElysiaConfig } from './types.js';

/** 把「字符串数组 / 分组对象 / 单个字符串」统一成字符串数组。 */
export function flattenToStrings(raw: unknown): string[] {
  const out: string[] = [];
  const push = (v: unknown): void => {
    const s = String(v ?? '').trim();
    if (s) out.push(s);
  };
  if (typeof raw === 'string') {
    push(raw);
    return dedupe(out);
  }
  if (Array.isArray(raw)) {
    for (const item of raw) push(item);
    return dedupe(out);
  }
  if (isPlainObject(raw)) {
    for (const value of Object.values(raw)) {
      if (Array.isArray(value)) for (const item of value) push(item);
      else if (typeof value === 'string') push(value);
      else if (isPlainObject(value)) {
        for (const inner of Object.values(value)) {
          if (Array.isArray(inner)) for (const item of inner) push(item);
          else push(inner);
        }
      }
    }
    return dedupe(out);
  }
  return out;
}

function dedupe(list: string[]): string[] {
  return [...new Set(list)];
}

/**
 * 把同义词字典统一成 `alias -> canonical`。
 * 支持两种写法：
 *  - `{ "喜欢猫图": ["猫图", "猫猫"] }` → alias 到 key
 *  - `{ "猫图": "喜欢猫图" }` → 直接映射
 */
export function flattenSynonyms(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isPlainObject(raw)) return out;
  for (const [key, value] of Object.entries(raw)) {
    const canonical = String(key ?? '').trim();
    if (!canonical) continue;
    out[canonical] = canonical;
    if (typeof value === 'string') {
      const alias = String(value).trim();
      if (alias) out[alias] = canonical;
    } else if (Array.isArray(value)) {
      for (const item of value) {
        const alias = String(item ?? '').trim();
        if (alias) out[alias] = canonical;
      }
    }
  }
  return out;
}

/**
 * 加载全部字典。永不抛错；缺失项进 `missing` 列表。
 * @param config 已合并的配置（用来读四个相对路径）。
 * @param root   数据根。
 */
export function loadDictionaries(config: ElysiaConfig, root: string): Dictionaries {
  const missing: string[] = [];

  const sensitiveRaw = readJsonSafe<unknown>(dictPath(config.sensitive_words_path, root));
  if (sensitiveRaw === undefined) missing.push(config.sensitive_words_path);

  const synonymRaw = readJsonSafe<unknown>(dictPath(config.synonym_dict_path, root));
  if (synonymRaw === undefined) missing.push(config.synonym_dict_path);

  const negativeRaw = readJsonSafe<unknown>(dictPath(config.negative_words_path, root));
  if (negativeRaw === undefined) missing.push(config.negative_words_path);

  const memeRaw = readJsonSafe<unknown>(dictPath(config.meme_dict_path, root));
  if (memeRaw === undefined) missing.push(config.meme_dict_path);

  return {
    sensitiveWords: flattenToStrings(sensitiveRaw),
    synonyms: flattenSynonyms(synonymRaw),
    negativeWords: flattenToStrings(negativeRaw),
    memes: flattenToStrings(memeRaw),
    missing,
  };
}

/** 命中任一敏感词的文本返回命中的词；没有命中返回 null。 */
export function hitWord(text: string, words: string[]): string | null {
  const haystack = String(text ?? '');
  if (!haystack) return null;
  for (const word of words) {
    if (!word) continue;
    if (haystack.includes(word)) return word;
  }
  return null;
}
