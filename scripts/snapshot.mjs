#!/usr/bin/env node
/**
 * snapshot.mjs —— 生成可复现的内容快照
 *
 * 产物：snapshot/presets-<version>.json
 * 结构：{ version, schemaVersion, generatedAt, sources: { timetables, systems, adapters }, hash }
 *   - sources.timetables / sources.systems：文件清单 + 每个文件的 sha256 内容哈希
 *   - sources.adapters：{ 文件名: sha256 }
 *   - hash：对「去掉 hash 字段后的规范化 JSON」做 sha256
 *
 * 可复现性：generatedAt 优先取 --at <ISO> 参数，其次取环境变量 SOURCE_DATE_EPOCH
 * （Unix 秒，遵循可复现构建惯例），都没有才用当前时间。CI 里固定取值，
 * 因此 `git diff --exit-code snapshot` 能稳定通过。
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

function listFiles(dir, extension) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(extension) && statSync(join(dir, name)).isFile())
    .sort()
    .map((name) => join(dir, name));
}

/** 构建快照对象（不含 hash）。 */
export function buildSnapshot({ root, generatedAt }) {
  const versionFile = join(root, 'version.json');
  const versionData = JSON.parse(readFileSync(versionFile, 'utf8'));

  const timetables = listFiles(join(root, 'presets', 'timetables'), '.json').map((file) => ({
    id: basename(file, '.json'),
    path: relative(root, file).split(sep).join('/'),
    sha256: sha256(readFileSync(file, 'utf8')),
  }));
  const systems = listFiles(join(root, 'presets', 'systems'), '.json').map((file) => ({
    id: basename(file, '.json'),
    path: relative(root, file).split(sep).join('/'),
    sha256: sha256(readFileSync(file, 'utf8')),
  }));
  const adapters = {};
  for (const file of listFiles(join(root, 'presets', 'adapters'), '.js')) {
    adapters[basename(file)] = sha256(readFileSync(file, 'utf8'));
  }

  const unsigned = {
    version: versionData.version,
    schemaVersion: versionData.schemaVersion,
    generatedAt,
    sources: { timetables, systems, adapters },
  };
  return { ...unsigned, hash: sha256(canonicalJson(unsigned)) };
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
  const snapshot = buildSnapshot({ root, generatedAt });
  const outPath = join(root, 'snapshot', `presets-${snapshot.version}.json`);

  if (options.dryRun !== true) {
    mkdirSync(join(root, 'snapshot'), { recursive: true });
    writeFileSync(outPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  }

  process.stdout.write('=== 快照生成 ===\n');
  process.stdout.write(`  版本：${snapshot.version}（schemaVersion ${snapshot.schemaVersion}）\n`);
  process.stdout.write(`  生成时间：${snapshot.generatedAt}（--at 优先，其次 SOURCE_DATE_EPOCH）\n`);
  process.stdout.write(`  作息表：${snapshot.sources.timetables.length} 个 → ${snapshot.sources.timetables.map((item) => item.id).join(', ')}\n`);
  process.stdout.write(`  教务系统：${snapshot.sources.systems.length} 个 → ${snapshot.sources.systems.map((item) => item.id).join(', ')}\n`);
  process.stdout.write(`  适配器：${Object.keys(snapshot.sources.adapters).length} 个 → ${Object.keys(snapshot.sources.adapters).join(', ')}\n`);
  process.stdout.write(`  内容哈希：${snapshot.hash}\n`);
  process.stdout.write(`  输出：${relative(root, outPath).split(sep).join('/')}${options.dryRun === true ? '（dry-run，未写入）' : ''}\n`);
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
