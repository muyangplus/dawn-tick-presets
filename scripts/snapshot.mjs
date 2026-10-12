#!/usr/bin/env node
/**
 * snapshot.mjs —— 从**新作者结构**编译出**旧字段结构**的分发产物 + 生成 index.json
 *
 * 产物一：snapshot/presets-<version>.json（主仓库客户端只认这个，字段结构必须不变）
 *   { version, schemaVersion, generatedAt, sources: { timetables, systems, adapters }, hash }
 *   - sources.timetables：真实文件 presets/schools/<dir>/timetable.json 的路径 + sha256
 *   - sources.systems：每个系统一项。新结构下不再存在「一个系统一个 .json」的真实文件，
 *     因此 path 是**符号路径** presets/systems/<id>/system.json，sha256 是
 *     meta.json + login.json 按旧扁平结构（lib/legacy.mjs）编译出来的**文本哈希**。
 *     对未改动的系统，这个哈希与重构前 presets/systems/<id>.json 的哈希完全相同。
 *   - sources.adapters：{ 文件名: sha256 }，取自 systems/<id>/parse.js
 *
 * 产物二：presets/index.json（生成物，禁止手改，见 README）
 *   学校索引 + 系统引用 + 版本 + generatedAt。
 *
 * 可复现性：generatedAt 优先取 --at <ISO>，其次取 SOURCE_DATE_EPOCH（Unix 秒），
 * 都没有才用当前时间。CI 固定取值，因此重跑后 `git diff --exit-code` 必须为空。
 *
 * 用法：
 *   node scripts/snapshot.mjs
 *   node scripts/snapshot.mjs --at 2026-01-01T00:00:00.000Z
 *   SOURCE_DATE_EPOCH=1767225600 node scripts/snapshot.mjs
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync, mkdirSync } from 'node:fs';
import { join, basename, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileSystemFromRepo, systemSourcePath } from './lib/legacy.mjs';

/** 对字符串做 sha256，返回 "sha256:<hex>"。 */
export function sha256(text) {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

/**
 * 规范化 JSON 序列化：对象键排序、数组保持顺序、无多余空白。
 * 这保证同一份数据在任何机器上都得到同一个哈希。
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

function repoRel(root, file) {
  return relative(root, file).split(sep).join('/');
}

/** 列出目录下的子目录名（排序）。 */
export function listDirs(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => statSync(join(dir, name)).isDirectory())
    .sort();
}

/** 列出目录下的文件（可过滤扩展名），排序。 */
export function listFiles(dir, extension) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => statSync(join(dir, name)).isFile())
    .filter((name) => (extension === undefined ? true : name.endsWith(extension)))
    .sort();
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

/**
 * 编译系统：返回 index.json / snapshot 需要的全部信息。
 * @param {string} root
 */
export function compileSystems(root) {
  const dir = join(root, 'presets', 'systems');
  return listDirs(dir).map((id) => {
    const systemDir = join(dir, id);
    const metaPath = join(systemDir, 'meta.json');
    const loginPath = join(systemDir, 'login.json');
    const parserPath = join(systemDir, 'parse.js');
    if (!existsSync(metaPath) || !existsSync(loginPath)) {
      throw new Error(`系统 ${id} 缺少 meta.json 或 login.json（${repoRel(root, systemDir)}/）`);
    }
    const meta = readJson(metaPath);
    const login = readJson(loginPath);
    const { value: config, text: configText } = compileSystemFromRepo(root, id);
    return {
      id,
      meta,
      login,
      config,
      configText,
      hasParser: existsSync(parserPath),
      parserPath: existsSync(parserPath) ? repoRel(root, parserPath) : undefined,
      metaPath: repoRel(root, metaPath),
      loginPath: repoRel(root, loginPath),
    };
  });
}

/**
 * 编译学校：目录名与作息 id 可以不同（_default 目录 → default 作息）。
 * @param {string} root
 */
export function compileSchools(root) {
  const dir = join(root, 'presets', 'schools');
  return listDirs(dir).map((dirName) => {
    const schoolDir = join(dir, dirName);
    const metaFile = join(schoolDir, 'meta.json');
    const timetableFile = join(schoolDir, 'timetable.json');
    const configFile = join(schoolDir, 'config.json');
    if (!existsSync(metaFile) || !existsSync(timetableFile)) {
      throw new Error(`学校目录 ${dirName} 缺少 meta.json 或 timetable.json`);
    }
    const meta = readJson(metaFile);
    const timetable = readJson(timetableFile);
    const config = existsSync(configFile) ? readJson(configFile) : undefined;
    return {
      dirName,
      meta,
      timetable,
      timetableRaw: readFileSync(timetableFile, 'utf8'),
      config,
      timetablePath: repoRel(root, timetableFile),
      configPath: existsSync(configFile) ? repoRel(root, configFile) : undefined,
    };
  });
}

/** 构建 index.json 的内容（不含 generatedAt 之外的易变信息）。 */
export function buildIndexContent({ root, generatedAt }) {
  const versionData = readJson(join(root, 'version.json'));
  const schools = compileSchools(root)
    .map((school) => ({
      id: school.meta.id,
      name: school.meta.name,
      ...(school.meta.region === undefined ? {} : { region: school.meta.region }),
      ...(school.meta.type === undefined ? {} : { type: school.meta.type }),
      system: school.meta.system ?? null,
      aliases: school.meta.aliases ?? [],
      generic: school.meta.generic === true,
      default: school.meta.generic === true,
      configPath: school.configPath ?? null,
      timetablePath: school.timetablePath,
    }))
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  const systems = compileSystems(root)
    .map((system) => ({
      id: system.id,
      name: system.meta.name,
      ...(system.meta.version === undefined ? {} : { version: system.meta.version }),
      aliases: system.meta.aliases ?? [],
      hasParser: system.hasParser,
      ...(system.hasParser ? { parserPath: system.parserPath } : {}),
      metaPath: system.metaPath,
      loginPath: system.loginPath,
      detect: system.config.detect,
      entryPath: system.config.entryPath,
      hint: system.config.hint,
    }))
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  return {
    _generated: true,
    version: versionData.version,
    schemaVersion: versionData.schemaVersion,
    generatedAt,
    schools,
    systems,
  };
}

/** 构建快照对象（不含 hash）。字段结构与重构前完全一致。 */
export function buildSnapshot({ root, generatedAt }) {
  const versionData = readJson(join(root, 'version.json'));

  const timetables = compileSchools(root)
    .map((school) => ({
      id: school.timetable.id,
      path: school.timetablePath,
      sha256: sha256(school.timetableRaw),
    }))
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));

  const systems = compileSystems(root)
    .map((system) => ({
      id: system.id,
      path: systemSourcePath(system.id),
      sha256: sha256(system.configText),
    }))
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));

  const adapters = {};
  for (const system of compileSystems(root)) {
    if (!system.hasParser) continue;
    adapters[`${system.id}.js`] = sha256(readFileSync(join(root, system.parserPath), 'utf8'));
  }

  const unsigned = {
    version: versionData.version,
    schemaVersion: versionData.schemaVersion,
    generatedAt,
    sources: { timetables, systems, adapters },
  };
  return { ...unsigned, hash: sha256(canonicalJson(unsigned)) };
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
  const index = buildIndexContent({ root, generatedAt });
  const snapshot = buildSnapshot({ root, generatedAt });
  const snapshotPath = join(root, 'snapshot', `presets-${snapshot.version}.json`);
  const indexPath = join(root, 'presets', 'index.json');

  if (options.dryRun !== true) {
    mkdirSync(join(root, 'snapshot'), { recursive: true });
    writeText(snapshotPath, JSON.stringify(snapshot, null, 2));
    writeText(indexPath, JSON.stringify(index, null, 2));
  }

  process.stdout.write('=== 快照生成 ===\n');
  process.stdout.write(`  版本：${snapshot.version}（schemaVersion ${snapshot.schemaVersion}）\n`);
  process.stdout.write(`  生成时间：${snapshot.generatedAt}（--at 优先，其次 SOURCE_DATE_EPOCH）\n`);
  process.stdout.write(`  作息表：${snapshot.sources.timetables.length} 个 → ${snapshot.sources.timetables.map((item) => `${item.id}(${item.path})`).join(', ')}\n`);
  process.stdout.write(`  教务系统：${snapshot.sources.systems.length} 个 → ${snapshot.sources.systems.map((item) => item.id).join(', ')}\n`);
  process.stdout.write(`  适配器：${Object.keys(snapshot.sources.adapters).length} 个 → ${Object.keys(snapshot.sources.adapters).join(', ')}\n`);
  process.stdout.write(`  内容哈希：${snapshot.hash}\n`);
  process.stdout.write(`  输出：${repoRel(root, snapshotPath)}${options.dryRun === true ? '（dry-run，未写入）' : ''}\n`);
  process.stdout.write(`  索引：${repoRel(root, indexPath)}（_generated: true，${index.schools.length} 学校 / ${index.systems.length} 系统）${options.dryRun === true ? '（dry-run，未写入）' : ''}\n`);
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
