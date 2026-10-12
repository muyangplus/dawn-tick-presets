#!/usr/bin/env node
/**
 * snapshot.mjs —— 把**新作者结构**（合并后的 school.json / system.json）编译成
 * **唯一分发产物** snapshot/presets-<version>.json。
 *
 * 产物（唯一）：
 *   {
 *     version, schemaVersion, generatedAt,
 *     sources: { timetables: [{id,path,sha256}], systems: [{id,path,sha256}], adapters: {name: sha256} },
 *     index: { _generated, version, schemaVersion, generatedAt, schools: [...], systems: [...] },
 *     hash
 *   }
 *
 * - 顶层 `version / schemaVersion / generatedAt / sources / hash` **逐字段保持旧结构**
 *   （主仓库客户端只认这些，客户端会忽略未知键），`index` 是**新增字段**：
 *   它承载原 `presets/index.json` 的全部信息（学校索引 + 系统引用），
 *   本仓库**不再产出** `presets/index.json`。
 * - `sources.timetables[].path` 是**符号路径**（历史契约）：**恒为**
 *   `presets/schools/<校目录>/timetable.json`；`sha256` 是**原始作息 JSON 文本**的哈希。
 *   合并进 school.json 时 timetable 的值**逐字节**保留（只整体缩进一层），
 *   哈希与合并前完全一致（见 schema/snapshot.schema.json 与 README）。
 * - `sources.systems[].path` 同样是历史契约里的**符号路径** `presets/systems/<id>/system.json`，
 *   `sha256` 是 system.json 按旧扁平结构（lib/legacy.mjs）编译出的文本哈希。
 * - `sources.adapters`：系统解析器键名 `<系统id>.js`，学校解析器键名 `<学校id>.js`
 *   （解析器优先级：学校级 `schools/<id>/parse.js` ＞ 系统级 `systems/<sys>/parse.js`）。
 * - `hash`：对「去掉 hash 字段后的**整个快照**」——**包含新增的 index 字段**——做
 *   规范化 JSON（对象键排序、无多余空白）后的 sha256。
 *
 * 可复现性：generatedAt 优先取 --at <ISO>，其次取 SOURCE_DATE_EPOCH（Unix 秒），
 * 都没有才用当前时间。CI 固定取值：重跑后 `git diff --exit-code snapshot` 必须为空。
 *
 * 用法：
 *   node scripts/snapshot.mjs
 *   node scripts/snapshot.mjs --at 2026-01-01T00:00:00.000Z
 *   SOURCE_DATE_EPOCH=1767225600 node scripts/snapshot.mjs
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileSystemConfigText } from './lib/legacy.mjs';
import { buildIndex, readSchools, readSystems, repoRel } from './lib/repo.mjs';

/** 对字符串做 sha256，返回 "sha256:<hex>"。 */
export function sha256(text) {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

/**
 * 规范化 JSON 序列化：对象键排序、数组保持顺序、无多余空白。
 * 同一份数据在任何机器上得到同一个哈希。
 */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

/** 解析固定的生成时间。 */
export function resolveGeneratedAt({ at, sourceDateEpoch } = {}) {
  if (at !== undefined && at !== '') {
    const parsed = new Date(at);
    if (Number.isNaN(parsed.getTime())) throw new Error(`--at 参数不是合法时间：${at}`);
    return parsed.toISOString();
  }
  if (sourceDateEpoch !== undefined && sourceDateEpoch !== '') {
    const seconds = Number(sourceDateEpoch);
    if (!Number.isFinite(seconds)) throw new Error(`SOURCE_DATE_EPOCH 不是数字：${sourceDateEpoch}`);
    return new Date(seconds * 1000).toISOString();
  }
  return new Date().toISOString();
}

function sortById(list) {
  return [...list].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}

function readVersion(root) {
  return JSON.parse(readFileSync(join(root, 'version.json'), 'utf8'));
}

/**
 * 从 school.json 的文件文本里切出内嵌的 `timetable` 值，还原成「独立 timetable.json」的字节。
 *
 * 不能走 JSON.stringify：原作息文件里每个节次是
 * **单行紧凑写法**（periodNo / start / end 三个键挤在一行），
 * 重新排版会改变字节、进而改变 `sources.timetables[].sha256`。
 * 这里只信任原文：切出内嵌片段 → 去掉额外一层缩进 → 补回结尾换行。
 *
 * @param {string} schoolJsonText school.json 的完整文本
 * @returns {string|undefined} 还原后的 timetable.json 文本；切不出来时返回 undefined
 */
export function extractTimetableText(schoolJsonText) {
  const marker = '"timetable"';
  const keyStart = schoolJsonText.indexOf(marker);
  if (keyStart === -1) return undefined;
  const colon = schoolJsonText.indexOf(':', keyStart + marker.length);
  if (colon === -1) return undefined;
  let start = colon + 1;
  while (start < schoolJsonText.length && /\s/.test(schoolJsonText[start])) start += 1;
  if (schoolJsonText[start] !== '{') return undefined;

  // 扫描到与第一个 { 配对的 }
  let depth = 0;
  let inString = false;
  let escaped = false;
  let end = -1;
  for (let cursor = start; cursor < schoolJsonText.length; cursor += 1) {
    const char = schoolJsonText[cursor];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        end = cursor;
        break;
      }
    }
  }
  if (end === -1) return undefined;

  // 内嵌片段整体缩进了一层；两个空格宽时再补上结尾换行。
  const text = schoolJsonText.slice(start, end + 1);
  const indentWidth = 2;
  const dedented = text
    .split('\n')
    .map((line) => (line.startsWith(' '.repeat(indentWidth)) ? line.slice(indentWidth) : line))
    .join('\n');
  return `${dedented}\n`;
}

/** `sources.timetables[].path` 的历史契约：恒为符号路径（真实文件已合并进 school.json）。 */
export function timetableSourcePath(dirName) {
  return `presets/schools/${dirName}/timetable.json`;
}

/**
 * 编译全部学校：返回索引条目、timetable 来源条目与（可选）学校级解析器哈希。
 * @param {string} root
 */
export function compileSchools(root) {
  return readSchools(root).map((school) => {
    const text = readFileSync(school.fullPath, 'utf8');
    const doc = school.doc;
    const timetableText = extractTimetableText(text);
    return {
      ...school,
      text,
      timetableText,
      timetablePath: timetableSourcePath(school.dirName),
      parserText: school.parserFile === undefined ? undefined : readFileSync(school.parserFile, 'utf8'),
      doc,
    };
  });
}

/** 编译全部系统：返回索引条目、system 来源条目与（可选）系统级解析器哈希。 */
export function compileSystems(root) {
  return readSystems(root).map((system) => {
    const doc = system.doc;
    return {
      ...system,
      doc,
      configText: doc === undefined ? undefined : compileSystemConfigText(doc),
      parserText: system.parserFile === undefined ? undefined : readFileSync(system.parserFile, 'utf8'),
    };
  });
}

/**
 * 构建快照的 `sources`。
 * @returns {{ sources: object, adapters: Array<{name: string, sha256: string, kind: string, path: string}> }}
 */
export function buildSources({ schools, systems }) {
  const timetables = sortById(
    schools.map((school) => ({
      id: school.doc.timetable.id,
      path: school.timetablePath,
      sha256: sha256(school.timetableText),
    })),
  );

  const systemSources = sortById(
    systems.map((system) => ({
      id: system.id,
      path: `presets/systems/${system.id}/system.json`,
      sha256: sha256(system.configText),
    })),
  );

  // 解析器哈希：系统解析器键名 <系统id>.js，学校解析器键名 <学校id>.js。
  // 两者的 id 空间不同，正常不会重名；万一重名，系统级优先（学校级解析器仍在 school 目录里、
  // 由 index.schools 记录），并把它作为 info 报出来——绝不静默覆盖任何哈希。
  const adapters = {};
  const adapterDetails = [];
  for (const system of systems) {
    if (system.parserFile === undefined) continue;
    adapters[`${system.id}.js`] = sha256(system.parserText);
    adapterDetails.push({ name: `${system.id}.js`, sha256: adapters[`${system.id}.js`], kind: 'system', path: system.parserPath });
  }
  for (const school of schools) {
    if (school.parserFile === undefined) continue;
    const name = `${school.doc.id}.js`;
    if (adapters[name] !== undefined) continue; // 与已存在的系统解析器重名 → 保留系统级
    adapters[name] = sha256(school.parserText);
    adapterDetails.push({ name, sha256: adapters[name], kind: 'school', path: school.parserPath });
  }

  const sortedAdapters = {};
  for (const key of Object.keys(adapters).sort()) sortedAdapters[key] = adapters[key];

  return {
    sources: { timetables, systems: systemSources, adapters: sortedAdapters },
    adapterDetails: sortById(adapterDetails.map((item) => ({ id: item.name, ...item }))),
  };
}

/** 构建快照对象（含内嵌 index 与 hash）。 */
export function buildSnapshot({ root, generatedAt }) {
  const versionData = readVersion(root);
  const schools = compileSchools(root);
  const systems = compileSystems(root);
  const { sources, adapterDetails } = buildSources({ schools, systems });
  const index = buildIndex({ schools, systems, versionData, generatedAt });
  const unsigned = {
    version: versionData.version,
    schemaVersion: versionData.schemaVersion,
    generatedAt,
    sources,
    index,
  };
  return { snapshot: { ...unsigned, hash: sha256(canonicalJson(unsigned)) }, index, adapterDetails, schools, systems };
}

/** 写文件（保持 POSIX 换行，内容以换行结尾）。 */
function writeText(file, text) {
  writeFileSync(file, text.endsWith('\n') ? text : `${text}\n`, 'utf8');
}

export function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--at') {
      options.at = argv[index + 1];
      index += 1;
    } else if (argv[index] === '--root') {
      options.root = argv[index + 1];
      index += 1;
    } else if (argv[index] === '--dry-run') {
      options.dryRun = true;
    }
  }
  return options;
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const root = options.root ?? fileURLToPath(new URL('..', import.meta.url));
  const generatedAt = resolveGeneratedAt({ at: options.at, sourceDateEpoch: process.env.SOURCE_DATE_EPOCH });
  const { snapshot, index, adapterDetails } = buildSnapshot({ root, generatedAt });
  const snapshotPath = join(root, 'snapshot', `presets-${snapshot.version}.json`);
  const retiredIndexPath = join(root, 'presets', 'index.json');

  if (options.dryRun !== true) {
    mkdirSync(join(root, 'snapshot'), { recursive: true });
    writeText(snapshotPath, JSON.stringify(snapshot, null, 2));
  }

  process.stdout.write('=== 快照生成（唯一产物）===\n');
  process.stdout.write(`  版本：${snapshot.version}（schemaVersion ${snapshot.schemaVersion}）\n`);
  process.stdout.write(`  生成时间：${snapshot.generatedAt}（--at 优先，其次 SOURCE_DATE_EPOCH）\n`);
  process.stdout.write(`  作息表：${snapshot.sources.timetables.length} 个 → ${snapshot.sources.timetables.map((item) => item.id).join(', ')}\n`);
  process.stdout.write(`  教务系统：${snapshot.sources.systems.length} 个 → ${snapshot.sources.systems.map((item) => item.id).join(', ')}\n`);
  process.stdout.write(`  适配器：${adapterDetails.map((item) => `${item.name}(${item.kind})`).join(', ') || '无'}\n`);
  process.stdout.write(`  内嵌索引：${index.schools.length} 学校 / ${index.systems.length} 系统（_generated: true）\n`);
  process.stdout.write(`  hash 计算范围：去掉 hash 的整个快照，含 sources 与 index\n`);
  process.stdout.write(`  内容哈希：${snapshot.hash}\n`);
  process.stdout.write(`  输出：${repoRel(root, snapshotPath)}${options.dryRun === true ? '（dry-run，未写入）' : ''}\n`);
  if (existsSync(retiredIndexPath)) {
    process.stdout.write(`  提示：presets/index.json 已取消（信息并入快照的 index 字段），可删除 ${repoRel(root, retiredIndexPath)}\n`);
  }
  return 0;
}

const invokedDirectly = process.argv[1] !== undefined
  && fileURLToPath(import.meta.url) === process.argv[1];

if (invokedDirectly) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`快照生成失败：${error?.stack ?? error}\n`);
    process.exitCode = 1;
  }
}
