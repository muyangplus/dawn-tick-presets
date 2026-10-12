/**
 * legacy.mjs —— 把新目录结构（systems/<id>/meta.json + login.json）编译成
 * **旧扁平结构**的系统配置对象。
 *
 * 为什么需要它：分发格式（`snapshot/presets-<version>.json`）必须保持不变，
 * 主仓库客户端只认 `sources.systems` 里那种「一个系统一份扁平 JSON」的形状：
 *
 *   { id, name, entryPath, hint, detect: { markers, timetableTableIds,
 *     timetableTableClasses, gridCellIdPatterns } }
 *
 * 作者结构把「系统元数据」与「登录入口」拆成了两个文件，编译期再把它们合并回来，
 * 合并规则固定为 **meta 在前、login 在后**，键序固定为旧文件的历史顺序，
 * 因此对未改动的系统，编译产物与旧文件**逐字节一致、sha256 也一致**。
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
 * 把 meta.json + login.json 编译成旧扁平结构对象（键序按 LEGACY_SYSTEM_KEY_ORDER）。
 * @param {{ meta: object, login: object }} input
 */
export function compileSystemConfig({ meta, login }) {
  const detect = {};
  for (const key of DETECT_KEY_ORDER) detect[key] = meta.detect?.[key] ?? [];
  return {
    id: meta.id,
    name: meta.name,
    entryPath: login.entryPath,
    hint: login.hint,
    detect,
  };
}

/**
 * 编译成「旧文件文本」，用于计算与旧快照完全一致的内容哈希。
 * @param {{ meta: object, login: object }} input
 */
export function compileSystemConfigText({ meta, login }) {
  const value = compileSystemConfig({ meta, login });
  const ordered = {};
  for (const key of LEGACY_SYSTEM_KEY_ORDER) ordered[key] = value[key];
  return `${stringifyLegacy(ordered)}\n`;
}

/**
 * 直接从仓库读一个系统并编译。
 * @param {string} root 仓库根
 * @param {string} id 系统 id（= presets/systems/<id>/ 目录名）
 */
export function compileSystemFromRepo(root, id) {
  const dir = join(root, 'presets', 'systems', id);
  const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'));
  const login = JSON.parse(readFileSync(join(dir, 'login.json'), 'utf8'));
  return { value: compileSystemConfig({ meta, login }), text: compileSystemConfigText({ meta, login }) };
}

/**
 * `sources.systems[]` 里的 path 是**符号路径**：新结构下不再存在「一个系统一个 .json」的
 * 真实文件，这一项代表的是编译产物。这样做是为了在目录结构变化的同时，
 * 保证 snapshot 的字段结构（`{ id, path, sha256 }`）与语义对客户端完全不变。
 */
export function systemSourcePath(id) {
  return `presets/systems/${id}/system.json`;
}
