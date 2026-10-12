#!/usr/bin/env node
/**
 * validate.mjs —— 仓库全量校验（CI 必跑）
 *
 * 检查项：
 *   A. JSON Schema 校验（scripts/lib/schema.mjs，零依赖子集校验器）
 *   B. 语义校验（作息时间、教务系统字段与正则合法性、学校覆盖语义）
 *   C. 跨文件一致性（schools → systems 引用、index.json 与实际目录一致）
 *   D. 夹具硬规则（有 parse.js 就必须有非空 fixtures/，且 ≤1 个解析器）
 *   E. 安全扫描（systems/<id>/parse.js 静态禁用检测 + 沙箱运行冒烟）
 *   F. 版本一致性（version.json）
 *
 * 任一错误 → 非 0 退出。用法：
 *   node scripts/validate.mjs              # 校验默认仓库根（脚本上一级）
 *   node scripts/validate.mjs --root DIR   # 校验指定仓库根（测试用）
 *   node scripts/validate.mjs --scan-only  # 跳过沙箱冒烟，只做静态检查
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, relative, basename, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { validateSchema, formatPath } from './lib/schema.mjs';
import { compileSystemConfig } from './lib/legacy.mjs';
import { runAdapterSandbox, SANDBOX_LIMITS } from './sandbox-run.mjs';

export const SCHOOL_SYSTEM_IDS = ['jwglxt', 'qzdatasource', 'urp', 'other'];
export const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
export const HHMM_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

/** fixtures/ 里允许出现的扩展名（页面样本、期望事件、说明）。 */
export const FIXTURE_EXTS = ['.html', '.htm', '.json', '.md'];
/** school-config.json 允许的键（写死语义，见 README 与 schema/school-config.schema.json）。 */
export const SCHOOL_CONFIG_KEYS = ['system', 'login', 'params', 'detect'];

/**
 * 解析器安全扫描的禁用模式表。
 * 每条：{ id, re, label }，re 命中即报错并给出文件与行号。
 * 注意：静态扫描覆盖源码文本；运行期约束由 scripts/sandbox-run.mjs 的受限子进程施加。
 */
export const FORBIDDEN_PATTERNS = [
  { id: 'require', re: /require\s*\(/, label: 'require(（CommonJS 加载）' },
  { id: 'import-stmt', re: /\bimport\b/, label: 'import（ESM 静态导入）' },
  { id: 'dynamic-import', re: /import\s*\(/, label: 'import(（动态导入）' },
  { id: 'process', re: /\bprocess\b/, label: 'process（宿主进程对象/env 泄漏）' },
  { id: 'child_process', re: /child_process/, label: 'child_process（起子进程）' },
  { id: 'fs', re: /\bfs\b/, label: 'fs（文件系统）' },
  { id: 'net', re: /\bnet\b/, label: 'net（外部请求）' },
  { id: 'http', re: /\bhttp\b/, label: 'http（外部请求）' },
  { id: 'https', re: /\bhttps\b/, label: 'https（外部请求）' },
  { id: 'fetch', re: /fetch\s*\(/, label: 'fetch(（外部请求）' },
  { id: 'xhr', re: /XMLHttpRequest/, label: 'XMLHttpRequest（外部请求）' },
  { id: 'websocket', re: /WebSocket/, label: 'WebSocket（外部连接）' },
  { id: 'eval', re: /\beval\s*\(/, label: 'eval(（动态执行代码）' },
  { id: 'new-function', re: /new\s+Function/, label: 'new Function（动态执行代码）' },
  { id: 'globalThis', re: /globalThis/, label: 'globalThis（逃逸全局作用域）' },
  { id: 'function-ctor', re: /(?:^|[^.\w])Function\s*\(/, label: 'Function(（动态执行代码）' },
  { id: 'proto', re: /__proto__/, label: '__proto__（原型链污染）' },
  { id: 'constructor-index', re: /constructor\s*\[/, label: 'constructor[（原型链逃逸）' },
  { id: 'while-true', re: /while\s*\(\s*true\s*\)/, label: 'while(true)（死循环，会吃满 CPU）' },
  { id: 'set-interval', re: /setInterval\s*\(/, label: 'setInterval(（无限定时器）' },
];

/** 解析器唯一允许的导出形式。 */
export const ADAPTER_EXPORT_RE = /^\s*export\s+function\s+parse\s*\(\s*\{[^}]*\}\s*\)\s*\{/m;
/** 除 parse 外任何 export / module.exports / exports. 都视为越界。 */
export const EXTRA_EXPORT_RE = /^\s*export\b(?!\s+function\s+parse\s*[({])/m;
export const COMMONJS_EXPORT_RE = /\bmodule\.exports\b|\bexports\s*\./;

const DIM = '\u001b[2m';
const RED = '\u001b[31m';
const GREEN = '\u001b[32m';
const YELLOW = '\u001b[33m';
const BOLD = '\u001b[1m';
const RESET = '\u001b[0m';

/**
 * 把注释替换成等量空白（保留行号与列位置），避免中文注释里出现
 * 「net / fs」等词造成误报。字符串字面量不做特殊处理：
 * 解析器里出现这些词本身就可疑，宁可让贡献者改写法。
 */
export function stripComments(source) {
  const blank = (text) => text.replace(/[^\n]/g, ' ');
  return source
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .split(/\r?\n/)
    .map((line) => line.replace(/(^|[^:'"`\\])\/\/.*$/, (match, prefix) => prefix + blank(match.slice(prefix.length))))
    .join('\n');
}

/** 收集校验结果的小工具。 */
export class Report {
  constructor() {
    this.sections = [];
    this.errors = [];
    this.warnings = [];
  }

  section(title) {
    // 同名分区复用，避免多个检查函数产生多个同名小节
    let entry = this.sections.find((item) => item.title === title);
    if (entry === undefined) {
      entry = { title, lines: [] };
      this.sections.push(entry);
    }
    return {
      ok: (message) => entry.lines.push({ level: 'ok', message }),
      fail: (message) => {
        entry.lines.push({ level: 'fail', message });
        this.errors.push(`[${title}] ${message}`);
      },
      warn: (message) => {
        entry.lines.push({ level: 'warn', message });
        this.warnings.push(`[${title}] ${message}`);
      },
      info: (message) => entry.lines.push({ level: 'info', message }),
    };
  }

  get passed() {
    return this.errors.length === 0;
  }

  toText() {
    const out = [];
    out.push(`${BOLD}=== DawnTick presets 校验报告 ===${RESET}`);
    for (const section of this.sections) {
      out.push('');
      out.push(`${BOLD}${section.title}${RESET}`);
      if (section.lines.length === 0) out.push(`  ${DIM}-（无内容）${RESET}`);
      for (const line of section.lines) {
        if (line.level === 'ok') out.push(`  ${GREEN}✓${RESET} ${line.message}`);
        else if (line.level === 'fail') out.push(`  ${RED}✗${RESET} ${line.message}`);
        else if (line.level === 'warn') out.push(`  ${YELLOW}!${RESET} ${line.message}`);
        else out.push(`  ${DIM}·${RESET} ${line.message}`);
      }
    }
    out.push('');
    out.push(`${BOLD}=== 总结 ===${RESET}`);
    out.push(`  错误 ${this.errors.length} 项，警告 ${this.warnings.length} 项`);
    if (this.passed) {
      out.push(`  ${GREEN}${BOLD}全部校验通过${RESET}`);
    } else {
      out.push(`  ${RED}${BOLD}校验失败，请修复上述错误后重试${RESET}`);
      for (const error of this.errors) out.push(`  ${RED}- ${error}${RESET}`);
    }
    return out.join('\n');
  }
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function listJsonFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => join(dir, name));
}

export function listDirs(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => statSync(join(dir, name)).isDirectory())
    .sort();
}

export function listFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => statSync(join(dir, name)).isFile())
    .sort()
    .map((name) => join(dir, name));
}

function rel(root, file) {
  return relative(root, file).split(sep).join('/');
}

function hhmmToMinutes(text) {
  const [hour, minute] = text.split(':').map(Number);
  return hour * 60 + minute;
}

function loadSchema(root, report, section, name) {
  const file = join(root, 'schema', `${name}.schema.json`);
  if (!existsSync(file)) {
    section.fail(`缺少 schema 文件：schema/${name}.schema.json`);
    return undefined;
  }
  try {
    return readJson(file);
  } catch (error) {
    section.fail(`schema/${name}.schema.json 解析失败（${error.message}）`);
    return undefined;
  }
}

/* ------------------------------------------------------------------ */
/* A/B：作息时间表（schools/<dir>/timetable.json）                       */
/* ------------------------------------------------------------------ */

/**
 * 校验全部学校目录：meta.json / timetable.json / config.json。
 * @returns {Array<object>} 解析出的学校文档
 */
export function checkTimetables(root, report) {
  const dir = join(root, 'presets', 'schools');
  const section = report.section('A/B. 学校目录（meta / timetable / config）');
  const metaSchema = loadSchema(root, report, section, 'school-meta');
  const timetableSchema = loadSchema(root, report, section, 'timetable');
  const configSchema = loadSchema(root, report, section, 'school-config');
  const dirs = listDirs(dir);
  if (dirs.length === 0) {
    section.fail('目录为空或不存在：presets/schools/');
    return [];
  }
  const docs = [];
  for (const dirName of dirs) {
    const schoolDir = join(dir, dirName);
    const metaFile = join(schoolDir, 'meta.json');
    const timetableFile = join(schoolDir, 'timetable.json');
    const configFile = join(schoolDir, 'config.json');
    const prefix = `presets/schools/${dirName}`;
    if (!existsSync(metaFile)) {
      section.fail(`${prefix}/：缺少 meta.json`);
      continue;
    }
    if (!existsSync(timetableFile)) {
      section.fail(`${prefix}/：缺少 timetable.json`);
      continue;
    }

    let meta;
    let timetable;
    try {
      meta = readJson(metaFile);
    } catch (error) {
      section.fail(`${prefix}/meta.json：JSON 解析失败（${error.message}）`);
      continue;
    }
    try {
      timetable = readJson(timetableFile);
    } catch (error) {
      section.fail(`${prefix}/timetable.json：JSON 解析失败（${error.message}）`);
      continue;
    }

    const doc = { dirName, prefix, meta, timetable, config: undefined };
    docs.push(doc);

    // --- meta.json ---
    const metaErrors = validateSchema(meta, metaSchema);
    if (metaErrors.length > 0) {
      for (const error of metaErrors) section.fail(`${prefix}/meta.json Schema：${error.path} ${error.message}`);
    } else {
      section.ok(`${prefix}/meta.json Schema 通过（id=${meta.id}、name=${meta.name}）`);
    }
    if (meta.generic === true && timetable.id !== 'default') {
      section.fail(`${prefix}/meta.json：generic 为 true 时 timetable.id 必须是 "default"，实际是 "${timetable.id}"`);
    }

    // --- config.json（语义写死：只允许 system/login/params/detect） ---
    if (existsSync(configFile)) {
      let config;
      try {
        config = readJson(configFile);
      } catch (error) {
        section.fail(`${prefix}/config.json：JSON 解析失败（${error.message}）`);
        config = undefined;
      }
      if (config !== undefined) {
        doc.config = config;
        const unknown = Object.keys(config).filter((key) => !SCHOOL_CONFIG_KEYS.includes(key));
        if (unknown.length > 0) {
          section.fail(`${prefix}/config.json：未知键 ${unknown.join(', ')}（只允许 ${SCHOOL_CONFIG_KEYS.join(' / ')}）`);
        }
        const configErrors = validateSchema(config, configSchema);
        if (configErrors.length > 0) {
          for (const error of configErrors) section.fail(`${prefix}/config.json Schema：${error.path} ${error.message}`);
        } else {
          section.ok(`${prefix}/config.json Schema 通过（键：${Object.keys(config).join(', ') || '无'}）`);
        }
        if (config.system !== undefined && meta.system !== undefined && config.system !== meta.system) {
          section.warn(
            `${prefix}/config.json：system="${config.system}" 覆盖 meta.json 的 "${meta.system}"` +
            '（index.json 以 meta.json 为准，覆盖只影响客户端运行时）',
          );
        }
      }
    } else if (meta.system !== null && meta.system !== undefined) {
      section.info(`${prefix}/：没有 config.json（可选；该校直接沿用 systems/${meta.system}/ 的系统级配置）`);
    }

    // --- timetable.json ---
    const schemaErrors = validateSchema(timetable, timetableSchema);
    if (schemaErrors.length > 0) {
      for (const error of schemaErrors) section.fail(`${prefix}/timetable.json Schema：${error.path} ${error.message}`);
      continue;
    }
    section.ok(`${prefix}/timetable.json Schema 通过`);

    const periods = timetable.periods;
    const numbers = periods.map((period) => period.periodNo);
    const uniqueNumbers = new Set(numbers);
    if (uniqueNumbers.size !== numbers.length) {
      const duplicated = numbers.filter((number, index) => numbers.indexOf(number) !== index);
      section.fail(`${prefix}/timetable.json：periodNo 重复（${[...new Set(duplicated)].join(', ')}）`);
    } else {
      section.ok(`${prefix}/timetable.json：periodNo 唯一（${numbers.length} 节）`);
    }

    let ascending = true;
    for (let index = 1; index < numbers.length; index += 1) {
      if (numbers[index] <= numbers[index - 1]) {
        ascending = false;
        section.fail(`${prefix}/timetable.json：periodNo 未严格递增（第 ${index + 1} 项 ${numbers[index]} 不大于前一项 ${numbers[index - 1]}）`);
      }
    }
    const strictlySequential = numbers.every((number, index) => number === index + 1);
    if (ascending && !strictlySequential) {
      section.fail(`${prefix}/timetable.json：periodNo 应从 1 起连续无跳号，实际为 [${numbers.join(', ')}]`);
    } else if (ascending) {
      section.ok(`${prefix}/timetable.json：periodNo 严格递增且从 1 起连续`);
    }

    const timeFormatOk = periods.every((period) => HHMM_RE.test(period.start) && HHMM_RE.test(period.end));
    if (!timeFormatOk) {
      const bad = periods.find((period) => !HHMM_RE.test(period.start) || !HHMM_RE.test(period.end));
      section.fail(`${prefix}/timetable.json：第 ${bad.periodNo} 节时间格式非法（start=${bad.start}、end=${bad.end}），必须是 HH:MM（24 小时制）`);
    } else {
      section.ok(`${prefix}/timetable.json：全部时间严格符合 HH:MM`);
    }

    let durationOk = true;
    for (const period of periods) {
      if (hhmmToMinutes(period.end) <= hhmmToMinutes(period.start)) {
        durationOk = false;
        section.fail(`${prefix}/timetable.json：第 ${period.periodNo} 节 end(${period.end}) 必须晚于 start(${period.start})`);
      }
    }
    if (durationOk) section.ok(`${prefix}/timetable.json：每节 end > start`);

    let overlapOk = true;
    for (let index = 1; index < periods.length; index += 1) {
      const previous = periods[index - 1];
      const current = periods[index];
      if (hhmmToMinutes(current.start) < hhmmToMinutes(previous.end)) {
        overlapOk = false;
        section.fail(
          `${prefix}/timetable.json：第 ${previous.periodNo} 节（结束 ${previous.end}）与第 ${current.periodNo} 节（开始 ${current.start}）时间重叠`,
        );
      }
    }
    if (overlapOk) section.ok(`${prefix}/timetable.json：相邻节次不重叠`);
  }
  return docs;
}

/* ------------------------------------------------------------------ */
/* A/B/D：教务系统（systems/<id>/）                                     */
/* ------------------------------------------------------------------ */

/**
 * 跨文件一致性 + other 语义：systems 的 id 集合必须与 SCHOOL_SYSTEM_IDS 一致。
 * @param {Array<{name: string, data: object}>} docs 已解析的系统元数据（meta.json）
 * @param {string[]} expectedIds 期望的 id 集合
 * @param {Report} report
 */
export function checkSystemsCrossFile(docs, expectedIds, report) {
  const section = report.section('C. 跨文件一致性（systems id 集合 vs SCHOOL_SYSTEM_IDS）');
  const seen = new Map();
  for (const doc of docs) {
    if (seen.has(doc.data.id)) {
      section.fail(`${doc.name}：系统 id "${doc.data.id}" 与 ${seen.get(doc.data.id)} 重复`);
    } else {
      seen.set(doc.data.id, doc.name);
    }
    if (!expectedIds.includes(doc.data.id)) {
      section.fail(`${doc.name}：未知系统 id "${doc.data.id}"，不在 SCHOOL_SYSTEM_IDS（${expectedIds.join('/')}）内`);
    }
  }
  const idSet = [...seen.keys()].sort();
  const expectedSet = [...expectedIds].sort();
  const missing = expectedSet.filter((id) => !idSet.includes(id));
  const extra = idSet.filter((id) => !expectedSet.includes(id));
  if (missing.length > 0) section.fail(`跨文件一致性：缺少系统配置 ${missing.join(', ')}`);
  if (extra.length > 0) section.fail(`跨文件一致性：存在 SCHOOL_SYSTEM_IDS 之外的系统 ${extra.join(', ')}`);
  if (missing.length === 0 && extra.length === 0) {
    section.ok(`跨文件一致性：systems 的 id 集合与 SCHOOL_SYSTEM_IDS 完全一致（${idSet.join(', ')}）`);
  }

  const other = docs.find((doc) => doc.data.id === 'other');
  if (other !== undefined) {
    const detect = other.data.detect;
    const arrays = [detect.markers, detect.timetableTableIds, detect.timetableTableClasses, detect.gridCellIdPatterns];
    const hasAny = arrays.some((value) => Array.isArray(value) && value.length > 0);
    if (hasAny) {
      section.fail(`${other.name}：id 为 other 的系统不得参与识别，detect 各项必须为空数组`);
    } else {
      section.ok(`${other.name}：other 不参与识别（detect 全为空）`);
    }
  }
}

/**
 * 读取并校验系统目录（meta/login/parse.js/fixtures）。
 * @returns {Array<object>} 系统文档（含 dirName、meta、login、parserFile、fixtureFiles）
 */
export function checkSystems(root, report) {
  const dir = join(root, 'presets', 'systems');
  const section = report.section('A/B/C. 教务系统（meta / login / parse.js / fixtures）');
  const metaSchema = loadSchema(root, report, section, 'system-meta');
  const loginSchema = loadSchema(root, report, section, 'system-login');
  const dirs = listDirs(dir);
  if (dirs.length === 0) {
    section.fail('目录为空或不存在：presets/systems/');
    return [];
  }
  const systems = [];
  const seenIds = new Map();
  for (const dirName of dirs) {
    const systemDir = join(dir, dirName);
    const metaFile = join(systemDir, 'meta.json');
    const loginFile = join(systemDir, 'login.json');
    const parserFile = join(systemDir, 'parse.js');
    const fixturesDir = join(systemDir, 'fixtures');
    const prefix = `presets/systems/${dirName}`;

    if (!existsSync(metaFile)) {
      section.fail(`${prefix}/：缺少 meta.json`);
      continue;
    }
    if (!existsSync(loginFile)) {
      section.fail(`${prefix}/：缺少 login.json`);
      continue;
    }

    let meta;
    let login;
    try {
      meta = readJson(metaFile);
    } catch (error) {
      section.fail(`${prefix}/meta.json：JSON 解析失败（${error.message}）`);
      continue;
    }
    try {
      login = readJson(loginFile);
    } catch (error) {
      section.fail(`${prefix}/login.json：JSON 解析失败（${error.message}）`);
      continue;
    }

    const parserFiles = listFiles(systemDir).filter((file) => file.endsWith('.js'));
    const fixtureFiles = existsSync(fixturesDir) ? listFiles(fixturesDir) : [];
    const system = {
      dirName,
      prefix,
      meta,
      login,
      metaFile,
      loginFile,
      parserFiles,
      parserFile: existsSync(parserFile) ? parserFile : undefined,
      fixturesDir,
      fixtureFiles,
    };
    systems.push(system);

    // --- meta.json ---
    const metaErrors = validateSchema(meta, metaSchema);
    if (metaErrors.length > 0) {
      for (const error of metaErrors) section.fail(`${prefix}/meta.json Schema：${error.path} ${error.message}`);
    } else {
      section.ok(`${prefix}/meta.json Schema 通过（id=${meta.id}）`);
    }
    if (meta.id !== dirName) {
      section.fail(`${prefix}/meta.json：文件内 id "${meta.id}" 与目录名 "${dirName}" 不一致`);
    }
    if (seenIds.has(meta.id)) {
      section.fail(`${prefix}/meta.json：系统 id "${meta.id}" 与 ${seenIds.get(meta.id)} 重复`);
    } else {
      seenIds.set(meta.id, `${prefix}/meta.json`);
      section.ok(`${prefix}/meta.json：id 唯一（${meta.id}）`);
    }
    if (!SCHOOL_SYSTEM_IDS.includes(meta.id)) {
      section.fail(`${prefix}/meta.json：未知系统 id "${meta.id}"，不在 SCHOOL_SYSTEM_IDS（${SCHOOL_SYSTEM_IDS.join('/')}）内`);
    }

    // --- login.json ---
    const loginErrors = validateSchema(login, loginSchema);
    if (loginErrors.length > 0) {
      for (const error of loginErrors) section.fail(`${prefix}/login.json Schema：${error.path} ${error.message}`);
    } else {
      section.ok(`${prefix}/login.json Schema 通过（entryPath=${login.entryPath}）`);
    }
    if (typeof login.entryPath === 'string') {
      if (!login.entryPath.startsWith('/')) {
        section.fail(`${prefix}/login.json：entryPath "${login.entryPath}" 必须以 / 开头`);
      } else if (/^\/\//.test(login.entryPath) || /^[a-z]+:\/\//i.test(login.entryPath)) {
        section.fail(`${prefix}/login.json：entryPath "${login.entryPath}" 只能是路径，不能含协议或域名`);
      } else {
        section.ok(`${prefix}/login.json：entryPath 以 / 开头（${login.entryPath}）`);
      }
    }

    // --- detect 语义 ---
    const detect = meta.detect ?? {};
    for (const key of ['timetableTableIds', 'timetableTableClasses']) {
      const value = detect[key];
      if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
        section.fail(`${prefix}/meta.json：detect.${key} 必须是字符串数组`);
      }
    }
    if (Array.isArray(detect.timetableTableIds) && Array.isArray(detect.timetableTableClasses)) {
      section.ok(`${prefix}/meta.json：timetableTableIds / timetableTableClasses 均为字符串数组`);
    }
    for (const key of ['markers', 'gridCellIdPatterns']) {
      const value = detect[key];
      if (!Array.isArray(value)) {
        section.fail(`${prefix}/meta.json：detect.${key} 必须是数组`);
        continue;
      }
      let allCompile = true;
      for (const pattern of value) {
        try {
          new RegExp(pattern);
        } catch (error) {
          allCompile = false;
          section.fail(`${prefix}/meta.json：detect.${key} 中的 "${pattern}" 不是合法正则（${error.message}）`);
        }
      }
      if (allCompile) section.ok(`${prefix}/meta.json：detect.${key} 全部可由 new RegExp 编译（${value.length} 条）`);
    }

    // --- D：解析器与夹具的硬规则 ---
    if (parserFiles.length > 1) {
      section.fail(
        `${prefix}/：只允许一个解析器 parse.js，实际发现 ${parserFiles.map((file) => basename(file)).join(', ')}`,
      );
    }
    if (existsSync(parserFile)) {
      const pages = fixtureFiles.filter((file) => /\.html?$/.test(file));
      const eventFiles = fixtureFiles.filter((file) => file.endsWith('.json'));
      if (fixtureFiles.length === 0) {
        section.fail(
          `${prefix}/：存在 parse.js 但 fixtures/ 为空或不存在 —— 有解析器就必须有夹具（至少 1 个页面样本 + 1 个期望事件文件）`,
        );
      } else if (pages.length === 0) {
        section.fail(`${prefix}/fixtures/：缺少页面样本（至少 1 个 .html / .htm，用来喂给沙箱跑 parse.js）`);
      } else if (eventFiles.length === 0) {
        section.fail(`${prefix}/fixtures/：缺少期望事件文件（至少 1 个 .json）`);
      } else {
        section.ok(
          `${prefix}/：夹具齐全（页面样本 ${pages.map((file) => basename(file)).join(', ')}；期望事件 ${eventFiles.map((file) => basename(file)).join(', ')}）`,
        );
      }
      const badExt = fixtureFiles.filter((file) => !FIXTURE_EXTS.includes(file.slice(file.lastIndexOf('.')).toLowerCase()));
      for (const file of badExt) {
        section.warn(`${rel(root, file)}：fixtures/ 里出现了非预期扩展名（允许 ${FIXTURE_EXTS.join(' / ')}）`);
      }
    } else if (fixtureFiles.length > 0) {
      section.info(`${prefix}/：没有 parse.js（夹具可选，${fixtureFiles.length} 个文件）`);
    } else {
      section.info(`${prefix}/：没有 parse.js（夹具可选；有解析器时才是必填）`);
    }
  }

  checkSystemsCrossFile(
    systems.map((system) => ({ name: `${system.prefix}/meta.json`, data: system.meta })),
    SCHOOL_SYSTEM_IDS,
    report,
  );
  return systems;
}

/**
 * A：适配器一致性用例（systems/<id>/fixtures/*.json）。
 * 每条用例必须符合 system-fixture schema，引用的页面样本必须真实存在。
 */
export function checkConformance(root, report) {
  const section = report.section('A. 解析器一致性用例（systems/*/fixtures/）');
  const schema = loadSchema(root, report, section, 'system-fixture');
  const cases = [];
  const systemsDir = join(root, 'presets', 'systems');
  for (const dirName of listDirs(systemsDir)) {
    const fixturesDir = join(systemsDir, dirName, 'fixtures');
    if (!existsSync(fixturesDir)) continue;
    for (const file of listFiles(fixturesDir)) {
      if (!file.endsWith('.json')) continue;
      const name = rel(root, file);
      let data;
      try {
        data = readJson(file);
      } catch (error) {
        section.fail(`${name}：JSON 解析失败（${error.message}）`);
        continue;
      }
      // fixtures/ 里允许放任意说明性 JSON：只有带 input/expect 的才算一致性用例
      if (data === null || typeof data !== 'object' || data.input === undefined) {
        section.info(`${name}：不是一致性用例（没有 input 字段），跳过`);
        continue;
      }
      const schemaErrors = validateSchema(data, schema);
      if (schemaErrors.length > 0) {
        for (const error of schemaErrors) section.fail(`${name} Schema：${error.path} ${error.message}`);
        continue;
      }
      if (data.system !== dirName) {
        section.fail(`${name}：system "${data.system}" 与所在目录 "systems/${dirName}/" 不一致`);
      }
      const pagePath = join(fixturesDir, data.fixtures.page);
      if (!existsSync(pagePath)) {
        section.fail(`${name}：fixtures.page 指向的页面样本不存在（systems/${dirName}/fixtures/${data.fixtures.page}）`);
      } else {
        section.ok(`${name}：用例合法（system=${data.system}、minEvents=${data.expect.minEvents}、页面样本 ${data.fixtures.page}）`);
      }

      // 期望事件文件与用例里内联的 expect 必须一致（避免两份期望各说各话）
      const eventsPath = join(fixturesDir, data.fixtures.events);
      if (!existsSync(eventsPath)) {
        section.fail(`${name}：fixtures.events 指向的期望事件文件不存在（systems/${dirName}/fixtures/${data.fixtures.events}）`);
      } else {
        let events;
        try {
          events = readJson(eventsPath);
        } catch (error) {
          section.fail(`${rel(root, eventsPath)}：JSON 解析失败（${error.message}）`);
          events = undefined;
        }
        if (events !== undefined) {
          const eventErrors = validateSchema(events, schema);
          if (eventErrors.length > 0) {
            for (const error of eventErrors) section.fail(`${rel(root, eventsPath)} Schema：${error.path} ${error.message}`);
          } else if (events.id !== data.id) {
            section.fail(`${rel(root, eventsPath)}：id "${events.id}" 与用例 ${rel(root, file)} 的 id "${data.id}" 不一致`);
          } else if (events.system !== data.system) {
            section.fail(`${rel(root, eventsPath)}：system "${events.system}" 与用例 ${rel(root, file)} 的 system "${data.system}" 不一致`);
          } else {
            const expectedList = events.expect.events ?? [];
            if (data.expect.minEvents > expectedList.length) {
              section.fail(
                `${rel(root, file)}：expect.minEvents=${data.expect.minEvents} 大于 ${data.fixtures.events} 里声明的期望事件数 ${expectedList.length}`,
              );
            } else if (!isDeepStrictEqual(data.expect.events ?? [], expectedList)) {
              section.fail(
                `${rel(root, file)}：内联的 expect.events 与 ${data.fixtures.events} 里的期望事件不一致（两份期望必须完全相同）`,
              );
            } else {
              section.ok(
                `${rel(root, eventsPath)}：期望事件与用例一致（minEvents=${data.expect.minEvents}、期望 ${expectedList.length} 条）`,
              );
            }
          }
        }
      }
      cases.push({ file, name, dirName, fixturesDir, data });
    }
  }
  if (cases.length === 0) section.warn('没有找到任何一致性用例（systems/*/fixtures/*.json）');
  return cases;
}

/**
 * C：presets/index.json 必须与实际目录内容一致（生成物，禁止手改）。
 */
export function checkIndex(root, report, { schools, systems } = {}) {
  const section = report.section('C. index.json（生成物一致性）');
  const file = join(root, 'presets', 'index.json');
  if (!existsSync(file)) {
    section.fail('缺少 presets/index.json（生成物；请运行 node scripts/snapshot.mjs）');
    return undefined;
  }
  let index;
  try {
    index = readJson(file);
  } catch (error) {
    section.fail(`presets/index.json 解析失败（${error.message}）`);
    return undefined;
  }
  const schema = loadSchema(root, report, section, 'index');
  const schemaErrors = validateSchema(index, schema);
  if (schemaErrors.length > 0) {
    for (const error of schemaErrors) section.fail(`presets/index.json Schema：${error.path} ${error.message}`);
    return index;
  }
  section.ok('presets/index.json Schema 通过（_generated: true）');
  if (index._generated !== true) {
    section.fail('presets/index.json：_generated 必须为 true（本文件是生成物，禁止手改）');
  }

  const versionFile = join(root, 'version.json');
  if (existsSync(versionFile)) {
    const versionData = readJson(versionFile);
    if (index.version !== versionData.version) {
      section.fail(`presets/index.json：version "${index.version}" 与 version.json 的 "${versionData.version}" 不一致`);
    } else {
      section.ok(`presets/index.json：version 与 version.json 一致（${index.version}）`);
    }
    if (index.schemaVersion !== versionData.schemaVersion) {
      section.fail(`presets/index.json：schemaVersion ${index.schemaVersion} 与 version.json 的 ${versionData.schemaVersion} 不一致`);
    }
  }

  const expectedSchoolIds = (schools ?? []).map((school) => school.meta.id).sort();
  const indexedSchoolIds = index.schools.map((school) => school.id).sort();
  const schoolMissing = expectedSchoolIds.filter((id) => !indexedSchoolIds.includes(id));
  const schoolExtra = indexedSchoolIds.filter((id) => !expectedSchoolIds.includes(id));
  if (schoolMissing.length > 0) section.fail(`presets/index.json：缺少学校 ${schoolMissing.join(', ')}（目录里有但索引里没有）`);
  if (schoolExtra.length > 0) section.fail(`presets/index.json：多余的学校 ${schoolExtra.join(', ')}（索引里有但目录里没有）`);
  if (schoolMissing.length === 0 && schoolExtra.length === 0) {
    section.ok(`presets/index.json：学校 id 集合与目录一致（${indexedSchoolIds.join(', ')}）`);
  }

  const expectedSystemIds = (systems ?? []).map((system) => system.meta.id).sort();
  const indexedSystemIds = index.systems.map((system) => system.id).sort();
  const systemMissing = expectedSystemIds.filter((id) => !indexedSystemIds.includes(id));
  const systemExtra = indexedSystemIds.filter((id) => !expectedSystemIds.includes(id));
  if (systemMissing.length > 0) section.fail(`presets/index.json：缺少系统 ${systemMissing.join(', ')}`);
  if (systemExtra.length > 0) section.fail(`presets/index.json：多余的系统 ${systemExtra.join(', ')}`);
  if (systemMissing.length === 0 && systemExtra.length === 0) {
    section.ok(`presets/index.json：系统 id 集合与目录一致（${indexedSystemIds.join(', ')}）`);
  }

  for (const entry of index.schools) {
    if (entry.system === null) continue;
    if (!indexedSystemIds.includes(entry.system)) {
      section.fail(`presets/index.json：学校 "${entry.id}" 引用的系统 "${entry.system}" 不在索引的系统列表里`);
    }
    if (!expectedSystemIds.includes(entry.system)) {
      section.fail(`presets/index.json：学校 "${entry.id}" 引用的系统 "${entry.system}" 在 presets/systems/ 下不存在`);
    }
    if (entry.configPath !== null && !existsSync(join(root, entry.configPath))) {
      section.fail(`presets/index.json：学校 "${entry.id}" 的 configPath 不存在（${entry.configPath}）`);
    }
    if (!existsSync(join(root, entry.timetablePath))) {
      section.fail(`presets/index.json：学校 "${entry.id}" 的 timetablePath 不存在（${entry.timetablePath}）`);
    }
  }

  // 系统引用必须是 meta + login 的真实编译结果（detect / entryPath / hint 不能凭空写）
  for (const entry of index.systems) {
    const system = (systems ?? []).find((item) => item.meta.id === entry.id);
    if (system === undefined) continue;
    const expected = compileSystemConfig({ meta: system.meta, login: system.login });
    if (JSON.stringify(entry.detect) !== JSON.stringify(expected.detect)) {
      section.fail(`presets/index.json：系统 "${entry.id}" 的 detect 与 meta.json 编译结果不一致`);
    }
    if (entry.entryPath !== expected.entryPath || entry.hint !== expected.hint) {
      section.fail(`presets/index.json：系统 "${entry.id}" 的 entryPath/hint 与 login.json 不一致`);
    }
    if (entry.hasParser !== (system.parserFile !== undefined)) {
      section.fail(`presets/index.json：系统 "${entry.id}" 的 hasParser 与实际文件不一致`);
    }
  }
  section.ok('presets/index.json：系统引用与 meta.json / login.json 编译结果一致');
  return index;
}

/** D1：解析器静态安全扫描（systems/<id>/parse.js）。 */
export function checkAdapters(root, report, systems = []) {
  const section = report.section('D. 解析器静态安全扫描');
  const parserFiles = systems
    .flatMap((system) => system.parserFiles)
    .filter((file) => file.endsWith('.js'))
    .sort();
  if (parserFiles.length === 0) {
    section.warn('presets/systems/*/parse.js：没有解析器文件');
    return [];
  }
  for (const file of parserFiles) {
    const name = rel(root, file);
    const raw = readFileSync(file, 'utf8');
    const source = stripComments(raw);
    const lines = source.split(/\r?\n/);
    let hits = 0;
    lines.forEach((line, index) => {
      for (const rule of FORBIDDEN_PATTERNS) {
        if (rule.re.test(line)) {
          hits += 1;
          section.fail(`${name}:${index + 1} 命中禁用模式 ${rule.label}：${line.trim().slice(0, 100)}`);
        }
      }
    });
    if (hits === 0) section.ok(`${name}：未命中任何禁用模式（0/${FORBIDDEN_PATTERNS.length}，已忽略注释）`);

    if (!ADAPTER_EXPORT_RE.test(source)) {
      section.fail(`${name}：必须以 \`export function parse({ html, url, hints }) {\` 形式导出 parse（唯一允许的导出）`);
    } else {
      section.ok(`${name}：导出形式符合契约 export function parse({...})`);
    }
    if (EXTRA_EXPORT_RE.test(source)) {
      section.fail(`${name}：只允许导出 parse，检测到额外的 export 语句`);
    }
    if (COMMONJS_EXPORT_RE.test(source)) {
      section.fail(`${name}：禁止 CommonJS 导出（module.exports / exports.）`);
    }
  }
  section.info('静态检查覆盖源码文本；运行期约束由 scripts/sandbox-run.mjs（受限子进程）施加。');
  return parserFiles;
}

/** D2：在受限沙箱中冒烟运行每个解析器（用手里的夹具）。 */
export async function checkAdapterSandbox(root, report, systems, cases, adapterFiles) {
  const section = report.section('D2. 解析器沙箱冒烟（受限子进程）');
  if (adapterFiles.length === 0) {
    section.warn('没有解析器可运行');
    return;
  }
  for (const file of adapterFiles) {
    const system = systems.find((item) => item.parserFile === file);
    if (system === undefined) {
      section.warn(`${rel(root, file)}：没有对应的系统目录，跳过沙箱执行`);
      continue;
    }
    const testCase = cases.find((item) => item.dirName === system.dirName);
    if (testCase === undefined) {
      section.warn(`${rel(root, file)}：没有对应的 fixtures 一致性用例，跳过沙箱执行`);
      continue;
    }
    const html = readFileSync(join(testCase.fixturesDir, testCase.data.fixtures.page), 'utf8');
    const result = await runAdapterSandbox({
      adapterPath: file,
      input: { html, url: testCase.data.input.url, hints: testCase.data.input.hints },
      expectedMinEvents: testCase.data.expect?.minEvents,
    });
    if (!result.ok) {
      section.fail(`${rel(root, file)} 沙箱执行失败：${result.error.code} ${result.error.message}`);
      continue;
    }
    const events = result.events ?? [];
    const min = testCase.data.expect?.minEvents ?? 0;
    if (events.length < min) {
      section.fail(`${rel(root, file)} 沙箱执行产出事件不足：期望至少 ${min} 条，实际 ${events.length} 条`);
      continue;
    }
    // 夹具里声明的期望事件必须与真实产出**逐条一致**：这是「适配器 ↔ 页面样本」的一致性用例
    const expectedFile = join(testCase.fixturesDir, testCase.data.fixtures.events);
    const expected = existsSync(expectedFile) ? (readJson(expectedFile).expect?.events ?? []) : [];
    if (expected.length > 0 && !isDeepStrictEqual(events, expected)) {
      const different = expected.findIndex((event, index) => !isDeepStrictEqual(event, events[index]));
      section.fail(
        `${rel(root, file)} 沙箱产出与夹具 ${testCase.data.fixtures.events} 不一致：` +
        `第 ${(different === -1 ? Math.min(events.length, expected.length) : different) + 1} 条不同（实际 ${events.length} 条、期望 ${expected.length} 条）`,
      );
      continue;
    }
    section.ok(
      `${rel(root, file)} 沙箱执行成功：${events.length} 条事件与夹具逐条一致（用例 ${testCase.data.id}，${result.meta.durationMs}ms，权限参数 ${result.meta.permissionFlag}）`,
    );
  }
}

/** F：版本一致性。 */
export function checkVersion(root, report) {
  const section = report.section('F. 版本一致性（version.json）');
  const file = join(root, 'version.json');
  if (!existsSync(file)) {
    section.fail('缺少 version.json');
    return undefined;
  }
  let data;
  try {
    data = readJson(file);
  } catch (error) {
    section.fail(`version.json 解析失败（${error.message}）`);
    return undefined;
  }
  if (typeof data.version !== 'string' || !SEMVER_RE.test(data.version)) {
    section.fail(`version "${data.version}" 不是合法 SemVer（形如 0.1.0 / 1.1.0-rc.1）`);
  } else {
    section.ok(`version 是合法 SemVer：${data.version}`);
  }
  if (!Number.isInteger(data.schemaVersion) || data.schemaVersion <= 0) {
    section.fail(`schemaVersion 必须是正整数，实际是 ${JSON.stringify(data.schemaVersion)}`);
  } else {
    section.ok(`schemaVersion 是正整数：${data.schemaVersion}`);
  }
  if (typeof data.generatedAt !== 'string' || Number.isNaN(Date.parse(data.generatedAt))) {
    section.fail(`generatedAt 必须是可解析的时间字符串，实际是 ${JSON.stringify(data.generatedAt)}`);
  } else {
    section.ok(`generatedAt 可解析：${data.generatedAt}`);
  }
  if (data.channel !== 'stable' && data.channel !== 'beta') {
    section.fail(`channel 只能是 stable 或 beta，实际是 ${JSON.stringify(data.channel)}`);
  } else {
    section.ok(`channel 合法：${data.channel}`);
  }
  return data;
}

export function parseArgs(argv) {
  const options = { root: undefined, scanOnly: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--root') {
      options.root = argv[index + 1];
      index += 1;
    } else if (arg.startsWith('--root=')) {
      options.root = arg.slice('--root='.length);
    } else if (arg === '--scan-only') {
      options.scanOnly = true;
    }
  }
  return options;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const root = options.root ?? fileURLToPath(new URL('..', import.meta.url));
  const report = new Report();

  const schools = checkTimetables(root, report);
  const systems = checkSystems(root, report);
  const cases = checkConformance(root, report);
  const adapterFiles = checkAdapters(root, report, systems);
  checkIndex(root, report, { schools, systems });
  checkVersion(root, report);
  if (options.scanOnly) {
    const section = report.section('D2. 解析器沙箱冒烟（受限子进程）');
    section.info('已通过 --scan-only 跳过');
  } else {
    await checkAdapterSandbox(root, report, systems, cases, adapterFiles);
  }

  process.stdout.write(`${report.toText()}\n`);
  if (report.passed) {
    process.stdout.write(`\n沙箱限制：${JSON.stringify(SANDBOX_LIMITS)}\n`);
  }
  return report.passed ? 0 : 1;
}

const invokedDirectly = process.argv[1] !== undefined
  && fileURLToPath(import.meta.url) === process.argv[1];

if (invokedDirectly) {
  try {
    const code = await main();
    process.exitCode = code;
  } catch (error) {
    process.stderr.write(`${RED}校验脚本自身异常：${error?.stack ?? error}${RESET}\n`);
    process.exitCode = 2;
  }
}

export { formatPath };
