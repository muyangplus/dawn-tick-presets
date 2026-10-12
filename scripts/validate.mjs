#!/usr/bin/env node
/**
 * validate.mjs —— 仓库全量校验（CI 必跑）
 *
 * 四大类检查：
 *   A. JSON Schema 校验（scripts/lib/schema.mjs，零依赖子集校验器）
 *   B. 语义校验（作息时间、教务系统字段与正则合法性）
 *   C. 跨文件一致性（systems 的 id 集合 vs SCHOOL_SYSTEM_IDS）
 *   D. 安全扫描（适配器静态禁用检测 + 沙箱运行冒烟）
 *
 * 任一错误 → 非 0 退出。用法：
 *   node scripts/validate.mjs              # 校验默认仓库根（脚本上一级）
 *   node scripts/validate.mjs --root DIR   # 校验指定仓库根（测试用）
 *   node scripts/validate.mjs --scan-only  # 跳过沙箱冒烟，只做静态检查
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, relative, basename, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateSchema, formatPath } from './lib/schema.mjs';
import { runAdapterSandbox, SANDBOX_LIMITS } from './sandbox-run.mjs';

export const SCHOOL_SYSTEM_IDS = ['jwglxt', 'qzdatasource', 'urp', 'other'];
export const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
export const HHMM_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

/**
 * 适配器安全扫描的禁用模式表。
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

/** 适配器唯一允许的导出形式。 */
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
 * 适配器里出现这些词本身就可疑，宁可让贡献者改写法。
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
    // 同名分区复用，避免 checkSystems 与 checkSystemsCrossFile 产生两个同名小节
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

function listJsonFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => join(dir, name));
}

function listAdapterFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.js') && statSync(join(dir, name)).isFile())
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

/** A + B：作息时间表 Schema 与语义。 */
export function checkTimetables(root, report) {
  const dir = join(root, 'presets', 'timetables');
  const section = report.section('A/B. 作息时间表（Schema + 语义）');
  const schemaPath = join(root, 'schema', 'timetables.schema.json');
  if (!existsSync(schemaPath)) {
    section.fail(`缺少 schema 文件：${rel(root, schemaPath)}`);
    return [];
  }
  const schema = readJson(schemaPath);
  const files = listJsonFiles(dir);
  if (files.length === 0) {
    section.fail(`目录为空或不存在：presets/timetables/`);
    return [];
  }
  const docs = [];
  for (const file of files) {
    const name = rel(root, file);
    let data;
    try {
      data = readJson(file);
    } catch (error) {
      section.fail(`${name}：JSON 解析失败（${error.message}）`);
      continue;
    }
    docs.push({ file, name, data });

    const schemaErrors = validateSchema(data, schema);
    if (schemaErrors.length > 0) {
      for (const error of schemaErrors) section.fail(`${name} Schema：${error.path} ${error.message}`);
      continue;
    }
    section.ok(`${name} Schema 通过`);

    const expectedId = basename(file, '.json');
    if (data.id !== expectedId) {
      section.fail(`${name}：文件内 id "${data.id}" 与文件名 "${expectedId}" 不一致`);
    } else {
      section.ok(`${name}：id 与文件名一致（${data.id}）`);
    }

    const periods = data.periods;
    const numbers = periods.map((period) => period.periodNo);
    const uniqueNumbers = new Set(numbers);
    if (uniqueNumbers.size !== numbers.length) {
      const duplicated = numbers.filter((number, index) => numbers.indexOf(number) !== index);
      section.fail(`${name}：periodNo 重复（${[...new Set(duplicated)].join(', ')}）`);
    } else {
      section.ok(`${name}：periodNo 唯一（${numbers.length} 节）`);
    }

    let ascending = true;
    for (let index = 1; index < numbers.length; index += 1) {
      if (numbers[index] <= numbers[index - 1]) {
        ascending = false;
        section.fail(`${name}：periodNo 未严格递增（第 ${index + 1} 项 ${numbers[index]} 不大于前一项 ${numbers[index - 1]}）`);
      }
    }
    const strictlySequential = numbers.every((number, index) => number === index + 1);
    if (ascending && !strictlySequential) {
      section.fail(`${name}：periodNo 应从 1 起连续无跳号，实际为 [${numbers.join(', ')}]`);
    } else if (ascending) {
      section.ok(`${name}：periodNo 严格递增且从 1 起连续`);
    }

    const timeFormatOk = periods.every((period) => HHMM_RE.test(period.start) && HHMM_RE.test(period.end));
    if (!timeFormatOk) {
      const bad = periods.find((period) => !HHMM_RE.test(period.start) || !HHMM_RE.test(period.end));
      section.fail(`${name}：第 ${bad.periodNo} 节时间格式非法（start=${bad.start}、end=${bad.end}），必须是 HH:MM（24 小时制）`);
    } else {
      section.ok(`${name}：全部时间严格符合 HH:MM`);
    }

    let durationOk = true;
    for (const period of periods) {
      if (hhmmToMinutes(period.end) <= hhmmToMinutes(period.start)) {
        durationOk = false;
        section.fail(`${name}：第 ${period.periodNo} 节 end(${period.end}) 必须晚于 start(${period.start})`);
      }
    }
    if (durationOk) section.ok(`${name}：每节 end > start`);

    let overlapOk = true;
    for (let index = 1; index < periods.length; index += 1) {
      const previous = periods[index - 1];
      const current = periods[index];
      if (hhmmToMinutes(current.start) < hhmmToMinutes(previous.end)) {
        overlapOk = false;
        section.fail(
          `${name}：第 ${previous.periodNo} 节（结束 ${previous.end}）与第 ${current.periodNo} 节（开始 ${current.start}）时间重叠`,
        );
      }
    }
    if (overlapOk) section.ok(`${name}：相邻节次不重叠`);
  }
  return docs;
}

/**
 * A：适配器自检用例（test/conformance/*.json）必须符合 conformance schema，
 * 且引用的适配器文件必须真实存在。
 */
export function checkConformance(root, report) {
  const dir = join(root, 'test', 'conformance');
  const section = report.section('A. 适配器自检用例（Schema）');
  const schemaPath = join(root, 'schema', 'conformance.schema.json');
  if (!existsSync(schemaPath)) {
    section.fail(`缺少 schema 文件：${rel(root, schemaPath)}`);
    return [];
  }
  const schema = readJson(schemaPath);
  const files = listJsonFiles(dir);
  if (files.length === 0) {
    section.warn('test/conformance/ 下没有自检用例');
    return [];
  }
  const cases = [];
  for (const file of files) {
    const name = rel(root, file);
    let data;
    try {
      data = readJson(file);
    } catch (error) {
      section.fail(`${name}：JSON 解析失败（${error.message}）`);
      continue;
    }
    const schemaErrors = validateSchema(data, schema);
    if (schemaErrors.length > 0) {
      for (const error of schemaErrors) section.fail(`${name} Schema：${error.path} ${error.message}`);
      continue;
    }
    section.ok(`${name} Schema 通过（system=${data.system}、adapter=${data.adapter}、minEvents=${data.expect.minEvents}）`);
    const adapterPath = join(root, 'presets', 'adapters', data.adapter);
    if (!existsSync(adapterPath)) {
      section.fail(`${name}：引用的适配器不存在 presets/adapters/${data.adapter}`);
    } else {
      section.ok(`${name}：引用的适配器存在（presets/adapters/${data.adapter}）`);
    }
    cases.push({ file, name, data });
  }
  return cases;
}

/**
 * 跨文件一致性 + other 语义：presets/systems 的 id 集合必须与 SCHOOL_SYSTEM_IDS 一致。
 * 抽成独立函数，便于测试直接调用（跳过 schema 层单独验证语义层）。
 * @param {Array<{name: string, data: object}>} docs 已解析的系统配置
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
    section.ok(`跨文件一致性：presets/systems 的 id 集合与 SCHOOL_SYSTEM_IDS 完全一致（${idSet.join(', ')}）`);
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

/** A + B + C：教务系统配置。 */
export function checkSystems(root, report) {
  const dir = join(root, 'presets', 'systems');
  const section = report.section('A/B/C. 教务系统配置（Schema + 语义 + 跨文件一致性）');
  const schemaPath = join(root, 'schema', 'systems.schema.json');
  if (!existsSync(schemaPath)) {
    section.fail(`缺少 schema 文件：${rel(root, schemaPath)}`);
    return [];
  }
  const schema = readJson(schemaPath);
  const files = listJsonFiles(dir);
  if (files.length === 0) {
    section.fail('目录为空或不存在：presets/systems/');
    return [];
  }
  const docs = [];
  const seenIds = new Map();
  for (const file of files) {
    const name = rel(root, file);
    let data;
    try {
      data = readJson(file);
    } catch (error) {
      section.fail(`${name}：JSON 解析失败（${error.message}）`);
      continue;
    }
    docs.push({ file, name, data });

    const schemaErrors = validateSchema(data, schema);
    if (schemaErrors.length > 0) {
      for (const error of schemaErrors) section.fail(`${name} Schema：${error.path} ${error.message}`);
      continue;
    }
    section.ok(`${name} Schema 通过`);

    const expectedId = basename(file, '.json');
    if (data.id !== expectedId) {
      section.fail(`${name}：文件内 id "${data.id}" 与文件名 "${expectedId}" 不一致`);
    }
    if (seenIds.has(data.id)) {
      section.fail(`${name}：系统 id "${data.id}" 与 ${seenIds.get(data.id)} 重复`);
    } else {
      seenIds.set(data.id, name);
      section.ok(`${name}：id 唯一（${data.id}）`);
    }

    if (!SCHOOL_SYSTEM_IDS.includes(data.id)) {
      section.fail(`${name}：未知系统 id "${data.id}"，不在 SCHOOL_SYSTEM_IDS（${SCHOOL_SYSTEM_IDS.join('/')}）内`);
    }

    if (!data.entryPath.startsWith('/')) {
      section.fail(`${name}：entryPath "${data.entryPath}" 必须以 / 开头`);
    } else if (/^\/\//.test(data.entryPath) || /^[a-z]+:\/\//i.test(data.entryPath)) {
      section.fail(`${name}：entryPath "${data.entryPath}" 只能是路径，不能含协议或域名`);
    } else {
      section.ok(`${name}：entryPath 以 / 开头（${data.entryPath}）`);
    }

    for (const key of ['timetableTableIds', 'timetableTableClasses']) {
      const value = data.detect[key];
      if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
        section.fail(`${name}：detect.${key} 必须是字符串数组`);
      }
    }
    if (Array.isArray(data.detect.timetableTableIds) && Array.isArray(data.detect.timetableTableClasses)) {
      section.ok(`${name}：timetableTableIds / timetableTableClasses 均为字符串数组`);
    }

    for (const key of ['markers', 'gridCellIdPatterns']) {
      const value = data.detect[key];
      if (!Array.isArray(value)) {
        section.fail(`${name}：detect.${key} 必须是数组`);
        continue;
      }
      let allCompile = true;
      for (const pattern of value) {
        try {
          new RegExp(pattern);
        } catch (error) {
          allCompile = false;
          section.fail(`${name}：detect.${key} 中的 "${pattern}" 不是合法正则（${error.message}）`);
        }
      }
      if (allCompile) section.ok(`${name}：detect.${key} 全部可由 new RegExp 编译（${value.length} 条）`);
    }
  }

  checkSystemsCrossFile(docs, SCHOOL_SYSTEM_IDS, report);
  return docs;
}

/** D1：适配器静态安全扫描。 */
export function checkAdapters(root, report) {
  const dir = join(root, 'presets', 'adapters');
  const section = report.section('D1. 适配器静态安全扫描');
  const files = listAdapterFiles(dir);
  if (files.length === 0) {
    section.warn('presets/adapters/ 下没有 .js 适配器文件');
    return [];
  }
  for (const file of files) {
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
  return files;
}

/** D2：在受限沙箱中冒烟运行每个适配器。 */
export async function checkAdapterSandbox(root, report, adapterFiles) {
  const section = report.section('D2. 适配器沙箱冒烟（受限子进程）');
  if (adapterFiles.length === 0) {
    section.warn('没有适配器可运行');
    return;
  }
  const conformanceDir = join(root, 'test', 'conformance');
  const cases = existsSync(conformanceDir)
    ? listJsonFiles(conformanceDir).map((file) => ({ file, data: readJson(file) }))
    : [];
  for (const file of adapterFiles) {
    const name = basename(file);
    const testCase = cases.find((item) => item.data.adapter === name);
    if (testCase === undefined) {
      section.warn(`${rel(root, file)}：没有对应的 test/conformance 用例，跳过沙箱执行`);
      continue;
    }
    const result = await runAdapterSandbox({
      adapterPath: file,
      input: testCase.data.input,
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
    section.ok(
      `${rel(root, file)} 沙箱执行成功：${events.length} 条事件（用例 ${testCase.data.id}，${result.meta.durationMs}ms，权限参数 ${result.meta.permissionFlag}）`,
    );
  }
}

/** E：版本一致性。 */
export function checkVersion(root, report) {
  const section = report.section('E. 版本一致性（version.json）');
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
    section.fail(`version "${data.version}" 不是合法 SemVer（形如 1.0.0 / 1.1.0-rc.1）`);
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

  checkTimetables(root, report);
  checkSystems(root, report);
  checkConformance(root, report);
  const adapterFiles = checkAdapters(root, report);
  checkVersion(root, report);
  if (options.scanOnly) {
    const section = report.section('D2. 适配器沙箱冒烟（受限子进程）');
    section.info('已通过 --scan-only 跳过');
  } else {
    await checkAdapterSandbox(root, report, adapterFiles);
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
