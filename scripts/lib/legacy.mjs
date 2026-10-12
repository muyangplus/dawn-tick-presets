/**
 * legacy.mjs —— 把作者结构（合并后的 `systems/<id>/system.json`）编译成
 * **旧扁平结构**的系统配置对象。
 *
 * 需要它的原因：分发格式（`snapshot/presets-<version>.json`）保持不变，
 * 主仓库客户端只认 `sources.systems` 里那种「一个系统一份扁平 JSON」的形状：
 *
 *   { id, name, entryPath, hint, detect: { markers, timetableTableIds,
 *     timetableTableClasses, gridCellIdPatterns } }
 *
 * 历史沿革：这份数据最初是一个扁平文件 `presets/systems/<id>.json`，随后被拆成
 * `meta.json` + `login.json` 两个文件，现在又合并成 `system.json` 一个文件。
 * 无论形态怎么变，编译规则固定（键序为旧文件的历史顺序）：
 * 未改动的系统，编译产物与最开始的旧文件**逐字节一致、sha256 也一致**。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** detect 子键的固定顺序（与旧 presets/systems/*.json 一致）。 */
export const DETECT_KEY_ORDER = ['markers', 'timetableTableIds', 'timetableTableClasses', 'gridCellIdPatterns'];

/** 旧扁平系统配置的键序（与旧文件一致）。 */
export const LEGACY_SYSTEM_KEY_ORDER = ['id', 'name', 'entryPath', 'hint', 'detect'];

/**
 * 按旧文件风格序列化：2 空格缩进、数组压成一行、保留结尾换行。
 * 旧 `presets/systems/*.json` 就是这种写法，所以重建结果逐字节一致。
 */
export function stringifyLegacy(value, depth = 0) {
  const pad = '  '.repeat(depth);
  const inner = '  '.repeat(depth + 1);
  if (Array.isArray(value)) return `[${value.map((item) => stringifyLegacy(item, depth + 1)).join(', ')}]`;
  if (value !== null && typeof value === 'object') {
    const lines = Object.keys(value).map(
      (key) => `${inner}${JSON.stringify(key)}: ${stringifyLegacy(value[key], depth + 1)}`,
    );
    return `{\n${lines.join(',\n')}\n${pad}}`;
  }
  return JSON.stringify(value);
}

/**
 * 把合并后的 system.json 文档（{ id, name?, version?, aliases?, detect, login }）
 * 编译成旧扁平结构对象（键序按 LEGACY_SYSTEM_KEY_ORDER）。
 *
 * 合并前这份数据来自 meta.json + login.json 两个文件；合并后来自同一个 system.json，
 * 字段语义不变，编译产物（以及分发给客户端的哈希）逐字节不变。
 * @param {{ id: string, name?: string, detect?: object, login?: object }} doc
 */
export function compileSystemConfig(doc) {
  const detect = {};
  for (const key of DETECT_KEY_ORDER) detect[key] = doc.detect?.[key] ?? [];
  return {
    id: doc.id,
    name: doc.name,
    entryPath: doc.login?.entryPath,
    hint: doc.login?.hint,
    detect,
  };
}

/**
 * 编译成「旧文件文本」，用于计算与旧快照完全一致的内容哈希。
 * @param {{ id: string, name?: string, detect?: object, login?: object }} doc
 */
export function compileSystemConfigText(doc) {
  const value = compileSystemConfig(doc);
  const ordered = {};
  for (const key of LEGACY_SYSTEM_KEY_ORDER) ordered[key] = value[key];
  return `${stringifyLegacy(ordered)}\n`;
}

/**
 * 直接从仓库读一个系统并编译（合并后的 system.json）。
 * @param {string} root 仓库根
 * @param {string} id 系统 id（= presets/systems/<id>/ 目录名）
 */
export function compileSystemFromRepo(root, id) {
  const doc = JSON.parse(readFileSync(join(root, 'presets', 'systems', id, 'system.json'), 'utf8'));
  return { value: compileSystemConfig(doc), text: compileSystemConfigText(doc) };
}

/**
 * `sources.systems[]` 里的 path 是**符号路径**：新结构下不再存在「一个系统一个 .json」的
 * 真实文件，这一项代表的是编译产物。目录结构变化后，snapshot 的字段结构
 * （`{ id, path, sha256 }`）与语义对客户端不变。
 */
export function systemSourcePath(id) {
  return `presets/systems/${id}/system.json`;
}
