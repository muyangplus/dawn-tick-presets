#!/usr/bin/env node
/**
 * validate.mjs —— 仓库全量校验（CI 必跑）
 *
 * 检查项（合并结构：school.json / system.json + 唯一产物 snapshot）：
 *   A. JSON Schema 校验（scripts/lib/schema.mjs，零依赖子集校验器）
 *   B. 语义校验（作息时间、系统字段与正则合法性、学校覆盖语义）
 *   C. 跨文件一致性（schools → systems 引用、快照内嵌 index 与实际目录一致、快照可复现）
 *   D. 夹具硬规则（学校级/系统级只要有 parse.js，同目录 fixtures/ 就必须非空）
 *   E. 安全扫描（**学校级与系统级** parse.js 的静态禁用检测 + 受限沙箱冒烟）
 *   F. 版本一致性（version.json）
 *
 * 解析器优先级：`presets/schools/<id>/parse.js`（学校级）＞ `presets/systems/<sys>/parse.js`（系统级）。
 * 两者都存在时学校级生效，系统级作为其他学校的回退保留。
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
import { compileSystemConfig, compileSystemConfigText } from './lib/legacy.mjs';
import {
  SCHOOL_TOP_KEYS,
  SCHOOL_OVERRIDE_KEYS,
  repoRel,
  schoolLoginOverride,
  schoolSystem,
} from './lib/repo.mjs';
import { buildSnapshot, canonicalJson, sha256 } from './snapshot.mjs';
import { runAdapterSandbox, SANDBOX_LIMITS } from './sandbox-run.mjs';

export const SCHOOL_SYSTEM_IDS = ['jwglxt', 'qzdatasource', 'urp', 'other'];
export const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
export const HHMM_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

/** fixtures/ 里允许出现的扩展名（页面样本、期望事件、说明）。 */
export const FIXTURE_EXTS = ['.html', '.htm', '.json', '.md'];
/**
 * school.json 里「覆盖」语义允许的键白名单（原 config.json 的四个键）。
 * 合并后这些键平铺在 school.json 顶层；出现白名单之外的**覆盖键** → 校验失败。
 */
export const SCHOOL_CONFIG_KEYS = [...SCHOOL_OVERRIDE_KEYS];
/** school.json 顶层允许出现的全部键（身份 + 覆盖 + timetable）。 */
export const SCHOOL_ALLOWED_TOP_KEYS = [...SCHOOL_TOP_KEYS];
/** 已并入快照的旧产物：不应再存在（存在即报错，避免两份真值）。 */
export const RETIRED_ARTIFACTS = ['presets/index.json'];

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

export function listFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => statSync(join(dir, name)).isFile())
    .sort()
    .map((name) => join(dir, name));
}

export function listDirs(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => statSync(join(dir, name)).isDirectory())
    .sort();
}

/** 列出目录下的 `.js` 文件（解析器候选）。 */
function listParsers(dir) {
  return listFiles(dir).filter((file) => file.endsWith('.js'));
}

/** 列出目录下的夹具文件（不存在目录时为空数组）。 */
function listFixtures(dir) {
  return listFiles(dir);
}

/* ------------------------------------------------------------------ */
/* A/B：学校（schools/<dir>/school.json）                               */
/* ------------------------------------------------------------------ */

/**
 * 校验全部学校目录：身份字段 / 覆盖键白名单 / 作息表语义 / 解析器与夹具硬规则。
 * @returns {Array<object>} 解析出的学校文档
 */
export function checkTimetables(root, report) {
  const dir = join(root, 'presets', 'schools');
  const section = report.section('A/B/D. 学校目录（school.json / parse.js / fixtures）');
  const schoolSchema = loadSchema(root, report, section, 'school');
  const dirs = listDirs(dir);
  if (dirs.length === 0) {
    section.fail('目录为空或不存在：presets/schools/');
    return [];
  }
  const docs = [];
  const seenIds = new Map();
  for (const dirName of dirs) {
    const schoolDir = join(dir, dirName);
    const schoolFile = join(schoolDir, 'school.json');
    const prefix = `presets/schools/${dirName}`;
    if (!existsSync(schoolFile)) {
      section.fail(`${prefix}/：缺少 school.json（身份 + 作息 + 覆盖都在这个文件里）`);
      continue;
    }

    let doc;
    try {
      doc = readJson(schoolFile);
    } catch (error) {
      section.fail(`${prefix}/school.json：JSON 解析失败（${error.message}）`);
      continue;
    }
    if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
      section.fail(`${prefix}/school.json：顶层必须是对象`);
      continue;
    }

    const parsers = listParsers(schoolDir);
    const fixturesDir = join(schoolDir, 'fixtures');
    const fixtureFiles = listFixtures(fixturesDir);
    const school = {
      dirName,
      prefix,
      doc,
      meta: doc,
      file: schoolFile,
      schoolFile,
      parserFiles: parsers,
      parserFile: existsSync(join(schoolDir, 'parse.js')) ? join(schoolDir, 'parse.js') : undefined,
      fixturesDir,
      fixtureFiles,
      xml: undefined,
    };
    docs.push(school);

    // --- 顶层键白名单 + 覆盖键白名单 ---
    // 身份键（id/name/region/…）与 timetable 不算「覆盖」；覆盖语义只允许 system/login/params/detect。
    const unknown = Object.keys(doc).filter((key) => !SCHOOL_ALLOWED_TOP_KEYS.includes(key));
    if (unknown.length > 0) {
      section.fail(
        `${prefix}/school.json：未知键 ${unknown.join(', ')}` +
        `（只允许 ${SCHOOL_ALLOWED_TOP_KEYS.join(' / ')}；原 config.json 的键已平铺进来）`,
      );
    } else {
      section.ok(`${prefix}/school.json：顶层键全部在白名单内`);
    }
    const overrideUnknown = unknown.filter((key) => !['timetable'].includes(key));
    if (overrideUnknown.length > 0) {
      section.fail(
        `${prefix}/school.json：覆盖语义只允许 ${SCHOOL_CONFIG_KEYS.join(' / ')} 四个键，未知键 ${overrideUnknown.join(', ')}`,
      );
    }

    // --- Schema ---
    const schemaErrors = validateSchema(doc, schoolSchema);
    if (schemaErrors.length > 0) {
      for (const error of schemaErrors) section.fail(`${prefix}/school.json Schema：${error.path} ${error.message}`);
    } else {
      section.ok(`${prefix}/school.json Schema 通过（id=${doc.id}、name=${doc.name}）`);
    }

    if (doc.id !== undefined) {
      if (seenIds.has(doc.id)) {
        section.fail(`${prefix}/school.json：学校 id "${doc.id}" 与 ${seenIds.get(doc.id)} 重复`);
      } else {
        seenIds.set(doc.id, `${prefix}/school.json`);
      }
      const expectedId = dirName === '_default' ? 'default' : dirName;
      if (doc.id !== expectedId) {
        section.warn(`${prefix}/school.json：id "${doc.id}" 与目录名 "${dirName}" 不同（_default 目录约定 id 为 default）`);
      }
    }

    const timetable = doc.timetable;
    if (timetable === undefined) {
      section.fail(`${prefix}/school.json：缺少 timetable（作息表已并入 school.json，不再是独立的 timetable.json）`);
      continue;
    }

    // --- 作息表：id / generic 语义 ---
    if (doc.generic === true && timetable.id !== 'default') {
      section.fail(`${prefix}/school.json：generic 为 true 时 timetable.id 必须是 "default"，实际是 "${timetable.id}"`);
    }
    if (typeof timetable.id === 'string' && typeof doc.id === 'string' && timetable.id !== doc.id) {
      section.warn(`${prefix}/school.json：timetable.id "${timetable.id}" 与学校 id "${doc.id}" 不同`);
    }
    if (typeof timetable.name === 'string' && typeof doc.name === 'string' && timetable.name !== doc.name) {
      section.warn(`${prefix}/school.json：timetable.name "${timetable.name}" 与学校 name "${doc.name}" 不同`);
    }

    const periods = Array.isArray(timetable.periods) ? timetable.periods : [];
    const numbers = periods.map((period) => period.periodNo);
    const uniqueNumbers = new Set(numbers);
    if (uniqueNumbers.size !== numbers.length) {
      const duplicated = numbers.filter((number, index) => numbers.indexOf(number) !== index);
      section.fail(`${prefix}/school.json：timetable.periods 里 periodNo 重复（${[...new Set(duplicated)].join(', ')}）`);
    } else if (numbers.length > 0) {
      section.ok(`${prefix}/school.json：timetable periodNo 唯一（${numbers.length} 节）`);
    }

    let ascending = true;
    for (let index = 1; index < numbers.length; index += 1) {
      if (numbers[index] <= numbers[index - 1]) {
        ascending = false;
        section.fail(`${prefix}/school.json：periodNo 未严格递增（第 ${index + 1} 项 ${numbers[index]} 不大于前一项 ${numbers[index - 1]}）`);
      }
    }
    const strictlySequential = numbers.every((number, index) => number === index + 1);
    if (ascending && numbers.length > 0 && !strictlySequential) {
      section.fail(`${prefix}/school.json：periodNo 应从 1 起连续无跳号，实际为 [${numbers.join(', ')}]`);
    } else if (ascending && numbers.length > 0) {
      section.ok(`${prefix}/school.json：periodNo 严格递增且从 1 起连续`);
    }

    if (periods.length > 0) {
      const timeFormatOk = periods.every((period) => HHMM_RE.test(period.start) && HHMM_RE.test(period.end));
      if (!timeFormatOk) {
        const bad = periods.find((period) => !HHMM_RE.test(period.start) || !HHMM_RE.test(period.end));
        section.fail(`${prefix}/school.json：第 ${bad.periodNo} 节时间格式非法（start=${bad.start}、end=${bad.end}），必须是 HH:MM（24 小时制）`);
      } else {
        section.ok(`${prefix}/school.json：全部时间严格符合 HH:MM`);
      }

      let durationOk = true;
      for (const period of periods) {
        if (hhmmToMinutes(period.end) <= hhmmToMinutes(period.start)) {
          durationOk = false;
          section.fail(`${prefix}/school.json：第 ${period.periodNo} 节 end(${period.end}) 必须晚于 start(${period.start})`);
        }
      }
      if (durationOk) section.ok(`${prefix}/school.json：每节 end > start`);

      let overlapOk = true;
      for (let index = 1; index < periods.length; index += 1) {
        const previous = periods[index - 1];
        const current = periods[index];
        if (hhmmToMinutes(current.start) < hhmmToMinutes(previous.end)) {
          overlapOk = false;
          section.fail(
            `${prefix}/school.json：第 ${previous.periodNo} 节（结束 ${previous.end}）与第 ${current.periodNo} 节（开始 ${current.start}）时间重叠`,
          );
        }
      }
      if (overlapOk) section.ok(`${prefix}/school.json：相邻节次不重叠`);
    }

    // --- 覆盖语义：login / params / detect ---
    const loginOverride = schoolLoginOverride(doc);
    if (Object.keys(loginOverride).length > 0) {
      if (loginOverride.entryPath !== undefined) {
        const value = loginOverride.entryPath;
        if (!value.startsWith('/')) {
          section.fail(`${prefix}/school.json：login.entryPath "${value}" 必须以 / 开头`);
        } else if (/^\/\//.test(value) || /^[a-z]+:\/\//i.test(value)) {
          section.fail(`${prefix}/school.json：login.entryPath "${value}" 只能是路径，不能含协议或域名`);
        } else {
          section.ok(`${prefix}/school.json：login.entryPath 以 / 开头（${value}）`);
        }
      }
    }
    if (doc.detect !== undefined) {
      // detect 只做并集：这里只能追加，不能写 gridCellIdPatterns、也不能删系统级特征
      const additions = Object.entries(doc.detect)
        .map(([key, value]) => `${key}+${Array.isArray(value) ? value.length : 0}`)
        .join('、');
      section.ok(`${prefix}/school.json：detect 只做追加（${additions || '空'}），系统级特征不可删除`);
    }
    if (doc.params !== undefined) {
      section.ok(`${prefix}/school.json：params ${Object.keys(doc.params).length} 项（附加到登录入口 query）`);
    }
    if (doc.system !== undefined && doc.system !== null && !SCHOOL_SYSTEM_IDS.includes(doc.system)) {
      section.fail(`${prefix}/school.json：system "${doc.system}" 不在允许的系统 id（${SCHOOL_SYSTEM_IDS.join('/')}）内`);
    }

    // --- D：解析器与夹具的硬规则（学校级解析器同样适用）---
    checkParserAndFixtures({ root, section, prefix, parsers, parserFile: school.parserFile, fixturesDir, fixtureFiles });
  }
  return docs;
}

/**
 * D：某个目录（学校或系统）里解析器与夹具的硬规则。
 * 有 parse.js 就必须有非空 fixtures/（≥1 页面样本 + ≥1 期望事件），且最多一个 .js。
 */
function checkParserAndFixtures({ root, section, prefix, parsers, parserFile, fixturesDir, fixtureFiles }) {
  if (parsers.length > 1) {
    section.fail(`${prefix}/：只允许一个解析器 parse.js，实际发现 ${parsers.map((file) => basename(file)).join(', ')}`);
  }
  if (parserFile === undefined) {
    if (fixtureFiles.length > 0) {
      section.info(`${prefix}/：没有 parse.js（夹具可选，${fixtureFiles.length} 个文件）`);
    } else {
      section.info(`${prefix}/：没有 parse.js（夹具可选；有解析器时才是必填）`);
    }
    return;
  }
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
}

/* ------------------------------------------------------------------ */
/* A/B/C：教务系统（systems/<id>/system.json）                          */
/* ------------------------------------------------------------------ */

/**
 * 跨文件一致性 + other 语义：systems 的 id 集合必须与 SCHOOL_SYSTEM_IDS 一致。
 * @param {Array<{name: string, data: object}>} docs 已解析的系统文档
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
    const detect = other.data.detect ?? {};
    const arrays = [detect.markers, detect.timetableTableIds, detect.timetableTableClasses, detect.gridCellIdPatterns];
    const hasAny = arrays.some((value) => Array.isArray(value) && value.length > 0);
    if (hasAny) {
      section.fail(`${other.name}：id 为 other 的系统不得参与识别，detect 各项必须为空数组`);
    } else {
      section.ok(`${other.name}：other 不参与识别（detect 全为空）`);
    }
  }
  return seen;
}

/**
 * 读取并校验系统目录（system.json + parse.js + fixtures）。
 * @returns {Array<object>} 系统文档
 */
export function checkSystems(root, report) {
  const dir = join(root, 'presets', 'systems');
  const section = report.section('A/B/C. 教务系统（system.json / parse.js / fixtures）');
  const systemSchema = loadSchema(root, report, section, 'system');
  const dirs = listDirs(dir);
  if (dirs.length === 0) {
    section.fail('目录为空或不存在：presets/systems/');
    return [];
  }
  const systems = [];
  const seenIds = new Map();
  for (const dirName of dirs) {
    const systemDir = join(dir, dirName);
    const systemFile = join(systemDir, 'system.json');
    const prefix = `presets/systems/${dirName}`;
    if (!existsSync(systemFile)) {
      section.fail(`${prefix}/：缺少 system.json（元数据 + 识别特征 + 登录入口都在这个文件里）`);
      continue;
    }

    let doc;
    try {
      doc = readJson(systemFile);
    } catch (error) {
      section.fail(`${prefix}/system.json：JSON 解析失败（${error.message}）`);
      continue;
    }
    if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
      section.fail(`${prefix}/system.json：顶层必须是对象`);
      continue;
    }

    const parsers = listParsers(systemDir);
    const fixturesDir = join(systemDir, 'fixtures');
    const fixtureFiles = listFixtures(fixturesDir);
    const system = {
      dirName,
      prefix,
      doc,
      meta: doc,
      login: doc.login,
      file: systemFile,
      systemFile,
      parserFiles: parsers,
      parserFile: existsSync(join(systemDir, 'parse.js')) ? join(systemDir, 'parse.js') : undefined,
      fixturesDir,
      fixtureFiles,
    };
    systems.push(system);

    // --- Schema ---
    const schemaErrors = validateSchema(doc, systemSchema);
    if (schemaErrors.length > 0) {
      for (const error of schemaErrors) section.fail(`${prefix}/system.json Schema：${error.path} ${error.message}`);
    } else {
      section.ok(`${prefix}/system.json Schema 通过（id=${doc.id}）`);
    }
    if (doc.id !== dirName) {
      section.fail(`${prefix}/system.json：文件内 id "${doc.id}" 与目录名 "${dirName}" 不一致`);
    }
    if (seenIds.has(doc.id)) {
      section.fail(`${prefix}/system.json：系统 id "${doc.id}" 与 ${seenIds.get(doc.id)} 重复`);
    } else {
      seenIds.set(doc.id, `${prefix}/system.json`);
      section.ok(`${prefix}/system.json：id 唯一（${doc.id}）`);
    }
    if (!SCHOOL_SYSTEM_IDS.includes(doc.id)) {
      section.fail(`${prefix}/system.json：未知系统 id "${doc.id}"，不在 SCHOOL_SYSTEM_IDS（${SCHOOL_SYSTEM_IDS.join('/')}）内`);
    }

    // --- login 语义 ---
    const login = doc.login ?? {};
    if (typeof login.entryPath === 'string') {
      if (!login.entryPath.startsWith('/')) {
        section.fail(`${prefix}/system.json：login.entryPath "${login.entryPath}" 必须以 / 开头`);
      } else if (/^\/\//.test(login.entryPath) || /^[a-z]+:\/\//i.test(login.entryPath)) {
        section.fail(`${prefix}/system.json：login.entryPath "${login.entryPath}" 只能是路径，不能含协议或域名`);
      } else {
        section.ok(`${prefix}/system.json：login.entryPath 以 / 开头（${login.entryPath}）`);
      }
    }

    // --- detect 语义 ---
    const detect = doc.detect ?? {};
    for (const key of ['timetableTableIds', 'timetableTableClasses']) {
      const value = detect[key];
      if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
        section.fail(`${prefix}/system.json：detect.${key} 必须是字符串数组`);
      }
    }
    if (Array.isArray(detect.timetableTableIds) && Array.isArray(detect.timetableTableClasses)) {
      section.ok(`${prefix}/system.json：timetableTableIds / timetableTableClasses 均为字符串数组`);
    }
    for (const key of ['markers', 'gridCellIdPatterns']) {
      const value = detect[key];
      if (!Array.isArray(value)) {
        section.fail(`${prefix}/system.json：detect.${key} 必须是数组`);
        continue;
      }
      let allCompile = true;
      for (const pattern of value) {
        try {
          new RegExp(pattern);
        } catch (error) {
          allCompile = false;
          section.fail(`${prefix}/system.json：detect.${key} 中的 "${pattern}" 不是合法正则（${error.message}）`);
        }
      }
      if (allCompile) section.ok(`${prefix}/system.json：detect.${key} 全部可由 new RegExp 编译（${value.length} 条）`);
    }

    // --- D：解析器与夹具的硬规则 ---
    checkParserAndFixtures({
      root,
      section,
      prefix,
      parsers,
      parserFile: system.parserFile,
      fixturesDir,
      fixtureFiles,
    });
  }

  checkSystemsCrossFile(
    systems.map((system) => ({ name: `${system.prefix}/system.json`, data: system.doc })),
    SCHOOL_SYSTEM_IDS,
    report,
  );
  return systems;
}

/* ------------------------------------------------------------------ */
/* A：一致性用例                                                        */
/* ------------------------------------------------------------------ */

/**
 * 一致性用例的内联 JSON Schema（原 schema/system-fixture.schema.json）。
 *
 * schema/ 已从 7 个收敛到 3 个（school / system / snapshot），用例形状随校验器一起版本化，
 * 改用例形状 = 改校验器，评审时看同一个文件即可。
 */
export const FIXTURE_CASE_SCHEMA = {
  type: 'object',
  required: ['id', 'system', 'adapter', 'fixtures', 'input', 'expect'],
  properties: {
    id: { type: 'string', minLength: 1, pattern: '^[a-z][a-z0-9_-]*$' },
    system: {
      type: 'string',
      minLength: 1,
      pattern: '^[a-z][a-z0-9_-]*$',
      description: '所属教务系统 id：系统级用例必须与所在目录一致；学校级用例必须与该校 school.json 的 system 一致。',
    },
    school: {
      type: 'string',
      minLength: 1,
      pattern: '^[a-z][a-z0-9_-]*$',
      description: '页面样本来自哪所学校（可选）。',
    },
    adapter: { type: 'string', pattern: '^[a-z][a-z0-9_-]*\\.js$', description: '解析器文件名，固定为 parse.js。' },
    fixtures: {
      type: 'object',
      required: ['page', 'events'],
      properties: {
        page: { type: 'string', pattern: '^[A-Za-z0-9._-]+\\.html?$' },
        events: { type: 'string', pattern: '^[A-Za-z0-9._-]+\\.json$' },
      },
      additionalProperties: false,
    },
    input: {
      type: 'object',
      required: ['url', 'hints'],
      properties: {
        url: { type: 'string', pattern: '^https?://' },
        hints: { type: 'object' },
      },
      additionalProperties: false,
    },
    expect: {
      type: 'object',
      required: ['minEvents'],
      properties: {
        minEvents: { type: 'integer', minimum: 0 },
        maxEvents: { type: 'integer', minimum: 0 },
        events: {
          type: 'array',
          items: {
            type: 'object',
            required: ['title', 'dayOfWeek', 'periodStart', 'periodEnd'],
            properties: {
              title: { type: 'string', minLength: 1 },
              dayOfWeek: { type: 'integer', minimum: 1, maximum: 7 },
              periodStart: { type: 'integer', minimum: 1, maximum: 24 },
              periodEnd: { type: 'integer', minimum: 1, maximum: 24 },
              room: { type: 'string' },
              teacher: { type: 'string' },
              weeks: { type: 'array', items: { type: 'integer', minimum: 1 } },
            },
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
};

/**
 * A：解析器一致性用例（systems/<id>/fixtures/*.json 与 schools/<dir>/fixtures/*.json）。
 * 每条用例必须符合内联的用例 schema，引用的页面样本必须真实存在。
 * @returns {Array<object>} 用例列表（含 scope: 'system' | 'school'）
 */
export function checkConformance(root, report) {
  const section = report.section('A. 解析器一致性用例（systems/*/fixtures/ 与 schools/*/fixtures/）');
  const schema = FIXTURE_CASE_SCHEMA;
  const cases = [];
  const scopes = [
    { kind: 'system', base: join(root, 'presets', 'systems') },
    { kind: 'school', base: join(root, 'presets', 'schools') },
  ];
  for (const scope of scopes) {
    for (const dirName of listDirs(scope.base)) {
      const ownerDir = join(scope.base, dirName);
      const fixturesDir = join(ownerDir, 'fixtures');
      if (!existsSync(fixturesDir)) continue;
      let ownerDoc;
      if (scope.kind === 'school') {
        const schoolFile = join(ownerDir, 'school.json');
        if (!existsSync(schoolFile)) continue;
        try {
          ownerDoc = readJson(schoolFile);
        } catch {
          ownerDoc = undefined;
        }
      }
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
        const caseScope = scope.kind === 'system' ? 'systems' : 'schools';
        // 目录归属决定作用域：systems/<id>/ 下要求 system 与目录一致；
        // schools/<dir>/ 下 school 字段（若写）必须与目录一致，system 字段（若写）必须与该校 system 一致。
        if (scope.kind === 'system') {
          if (data.system !== dirName) {
            section.fail(`${name}：system "${data.system}" 与所在目录 "systems/${dirName}/" 不一致`);
          }
        } else {
          if (data.school !== undefined && data.school !== dirName) {
            section.fail(`${name}：school "${data.school}" 与所在目录 "schools/${dirName}/" 不一致`);
          }
          if (
            data.system !== undefined
            && ownerDoc !== undefined
            && schoolSystem(ownerDoc) !== null
            && data.system !== schoolSystem(ownerDoc)
          ) {
            section.fail(
              `${name}：system "${data.system}" 与 schools/${dirName}/school.json 的 system "${schoolSystem(ownerDoc)}" 不一致`,
            );
          }
        }
        const pagePath = join(fixturesDir, data.fixtures.page);
        if (!existsSync(pagePath)) {
          section.fail(`${name}：fixtures.page 指向的页面样本不存在（${caseScope}/${dirName}/fixtures/${data.fixtures.page}）`);
        } else {
          section.ok(`${name}：用例合法（minEvents=${data.expect.minEvents}、页面样本 ${data.fixtures.page}）`);
        }

        // 期望事件文件与用例里内联的 expect 必须一致（避免两份期望各说各话）
        const eventsPath = join(fixturesDir, data.fixtures.events);
        if (!existsSync(eventsPath)) {
          section.fail(`${name}：fixtures.events 指向的期望事件文件不存在（${caseScope}/${dirName}/fixtures/${data.fixtures.events}）`);
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
            } else if (events.system !== undefined && data.system !== undefined && events.system !== data.system) {
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
        cases.push({ file, name, dirName, scope: scope.kind, fixturesDir, data });
      }
    }
  }
  if (cases.length === 0) section.warn('没有找到任何一致性用例（systems 或 schools 的 fixtures/*.json）');
  return cases;
}

/* ------------------------------------------------------------------ */
/* C：快照（唯一生成物，含内嵌 index）                                   */
/* ------------------------------------------------------------------ */

/** 由快照文件名推出仓库版本，例如 presets-0.1.0.json → 0.1.0。 */
export function snapshotVersionFromName(file) {
  const match = /^presets-(.+)\.json$/.exec(basename(file));
  return match === null ? undefined : match[1];
}

/**
 * C：snapshot/presets-<version>.json —— 唯一生成物、禁止手改、必须与实际目录一致。
 * 同时校验：
 *   - 顶层字段结构未变（version / schemaVersion / generatedAt / sources / hash）+ 新增 index；
 *   - hash 覆盖范围包含 index（删掉 index 或改一个字节都会导致 hash 不符）；
 *   - 内嵌 index 的学校 / 系统 id 集合与目录一致，detect / entryPath / hint / hasParser 与源文件一致；
 *   - 已取消的 presets/index.json 不再存在。
 */
export function checkSnapshot(root, report, { schools, systems } = {}) {
  const section = report.section('C. 快照唯一产物（snapshot/presets-<version>.json）');
  const snapshotDir = join(root, 'snapshot');
  const snapshotFiles = existsSync(snapshotDir)
    ? listFiles(snapshotDir).filter((file) => /^presets-.+\.json$/.test(basename(file)))
    : [];
  if (snapshotFiles.length === 0) {
    section.fail('缺少 snapshot/presets-<version>.json（唯一生成物；请运行 node scripts/snapshot.mjs）');
    return undefined;
  }
  if (snapshotFiles.length > 1) {
    section.fail(
      `snapshot/ 下只允许一个 presets-<version>.json，实际有 ${snapshotFiles.map((file) => basename(file)).join(', ')}`,
    );
  }
  const file = snapshotFiles[0];
  let snapshot;
  try {
    snapshot = readJson(file);
  } catch (error) {
    section.fail(`${repoRel(root, file)} 解析失败（${error.message}）`);
    return undefined;
  }
  const name = repoRel(root, file);
  const schema = loadSchema(root, report, section, 'snapshot');
  const schemaErrors = validateSchema(snapshot, schema);
  if (schemaErrors.length > 0) {
    for (const error of schemaErrors) section.fail(`${name} Schema：${error.path} ${error.message}`);
    return snapshot;
  }
  section.ok(`${name} Schema 通过（顶层 version / schemaVersion / generatedAt / sources / index / hash）`);

  // --- 顶层结构：旧字段保持 + index 是新增字段 ---
  const topKeys = Object.keys(snapshot);
  const legacyKeys = ['version', 'schemaVersion', 'generatedAt', 'sources', 'hash'];
  const missingLegacy = legacyKeys.filter((key) => !topKeys.includes(key));
  if (missingLegacy.length > 0) {
    section.fail(`${name}：缺少旧结构字段 ${missingLegacy.join(', ')}（分发格式必须保持兼容）`);
  } else {
    section.ok(`${name}：旧字段结构完整（${legacyKeys.join(' / ')}）`);
  }
  if (!topKeys.includes('index')) {
    section.fail(`${name}：缺少 index 字段（原 presets/index.json 的信息必须并入快照）`);
  }
  if (snapshot.index?._generated !== true) {
    section.fail(`${name}：index._generated 必须为 true（生成物，禁止手改）`);
  } else {
    section.ok(`${name}：index._generated === true`);
  }

  // --- hash 覆盖范围：必须包含 index ---
  const { hash, ...unsigned } = snapshot;
  const recomputed = sha256(canonicalJson(unsigned));
  if (recomputed !== hash) {
    section.fail(`${name}：hash 与内容不一致（重算 ${recomputed}，文件里是 ${hash}）`);
  } else {
    section.ok(`${name}：hash 与「去掉 hash 的整个快照（含 index）」一致`);
  }
  const withoutIndex = sha256(canonicalJson({ ...unsigned, index: undefined }));
  if (withoutIndex === hash) {
    section.fail(`${name}：hash 看起来没有覆盖 index 字段`);
  } else {
    section.ok(`${name}：hash 覆盖范围内包含 index（改动 index 必然改变 hash）`);
  }

  // --- 版本一致性 ---
  const versionFromName = snapshotVersionFromName(file);
  if (versionFromName !== snapshot.version) {
    section.fail(`${name}：文件名里的版本 "${versionFromName}" 与文件内 version "${snapshot.version}" 不一致`);
  } else {
    section.ok(`${name}：文件名版本与文件内 version 一致（${snapshot.version}）`);
  }
  const versionFile = join(root, 'version.json');
  if (existsSync(versionFile)) {
    const versionData = readJson(versionFile);
    if (snapshot.version !== versionData.version) {
      section.fail(`${name}：version "${snapshot.version}" 与 version.json 的 "${versionData.version}" 不一致`);
    } else {
      section.ok(`${name}：version 与 version.json 一致（${snapshot.version}）`);
    }
    if (snapshot.schemaVersion !== versionData.schemaVersion) {
      section.fail(`${name}：schemaVersion ${snapshot.schemaVersion} 与 version.json 的 ${versionData.schemaVersion} 不一致`);
    }
    if (snapshot.index?.version !== versionData.version) {
      section.fail(`${name}：index.version "${snapshot.index?.version}" 与 version.json 的 "${versionData.version}" 不一致`);
    }
    if (snapshot.index?.schemaVersion !== versionData.schemaVersion) {
      section.fail(`${name}：index.schemaVersion ${snapshot.index?.schemaVersion} 与 version.json 的 ${versionData.schemaVersion} 不一致`);
    }
  }

  // --- 已取消产物不得存在 ---
  for (const retired of RETIRED_ARTIFACTS) {
    if (existsSync(join(root, retired))) {
      section.fail(`${retired} 已取消（信息并入快照的 index 字段），不应再提交该文件`);
    }
  }

  // --- sources 与实际目录一致 ---
  const schoolDocs = schools ?? [];
  const systemDocs = systems ?? [];
  const expectedTimetableIds = schoolDocs.map((school) => school.doc?.timetable?.id).sort();
  const snapshotTimetableIds = snapshot.sources.timetables.map((item) => item.id).sort();
  const missingTimetable = expectedTimetableIds.filter((id) => !snapshotTimetableIds.includes(id));
  const extraTimetable = snapshotTimetableIds.filter((id) => !expectedTimetableIds.includes(id));
  if (missingTimetable.length > 0) section.fail(`${name}：sources.timetables 缺少 ${missingTimetable.join(', ')}`);
  if (extraTimetable.length > 0) section.fail(`${name}：sources.timetables 多出 ${extraTimetable.join(', ')}`);
  if (missingTimetable.length === 0 && extraTimetable.length === 0) {
    section.ok(`${name}：sources.timetables 与学校目录一致（${snapshotTimetableIds.join(', ')}）`);
  }

  const expectedSystemIds = systemDocs.map((system) => system.doc?.id).sort();
  const snapshotSystemIds = snapshot.sources.systems.map((item) => item.id).sort();
  const missingSystem = expectedSystemIds.filter((id) => !snapshotSystemIds.includes(id));
  const extraSystem = snapshotSystemIds.filter((id) => !expectedSystemIds.includes(id));
  if (missingSystem.length > 0) section.fail(`${name}：sources.systems 缺少 ${missingSystem.join(', ')}`);
  if (extraSystem.length > 0) section.fail(`${name}：sources.systems 多出 ${extraSystem.join(', ')}`);
  if (missingSystem.length === 0 && extraSystem.length === 0) {
    section.ok(`${name}：sources.systems 与系统目录一致（${snapshotSystemIds.join(', ')}）`);
  }

  // --- hash 逐项复算（防止手改 sha256）---
  let sourcesOk = true;
  for (const school of schoolDocs) {
    const id = school.doc?.timetable?.id;
    const entry = snapshot.sources.timetables.find((item) => item.id === id);
    if (entry === undefined) continue;
    if (entry.path !== `presets/schools/${school.dirName}/timetable.json`) {
      sourcesOk = false;
      section.fail(`${name}：作息 ${id} 的 path 应为符号路径 presets/schools/${school.dirName}/timetable.json，实际 ${entry.path}`);
    }
  }
  for (const system of systemDocs) {
    const entry = snapshot.sources.systems.find((item) => item.id === system.doc?.id);
    if (entry === undefined) continue;
    const expectedSha = sha256(compileSystemConfigText(system.doc));
    if (entry.sha256 !== expectedSha) {
      sourcesOk = false;
      section.fail(`${name}：系统 ${system.doc?.id} 的 sha256 与 system.json 编译结果不一致（应为 ${expectedSha}）`);
    }
    if (entry.path !== `presets/systems/${system.doc?.id}/system.json`) {
      sourcesOk = false;
      section.fail(`${name}：系统 ${system.doc?.id} 的 path 应为 presets/systems/${system.doc?.id}/system.json，实际 ${entry.path}`);
    }
  }
  for (const [adapterName, adapterSha] of Object.entries(snapshot.sources.adapters)) {
    const id = adapterName.replace(/\.js$/, '');
    const owner = systemDocs.find((system) => system.doc?.id === id);
    const schoolOwner = schoolDocs.find((school) => school.doc?.id === id);
    const parserFile = owner?.parserFile ?? schoolOwner?.parserFile;
    if (parserFile === undefined) {
      sourcesOk = false;
      section.fail(`${name}：adapters["${adapterName}"] 找不到对应的 parse.js`);
      continue;
    }
    const actualSha = sha256(readFileSync(parserFile, 'utf8'));
    if (actualSha !== adapterSha) {
      sourcesOk = false;
      section.fail(`${name}：adapters["${adapterName}"] 的 sha256 与 parse.js 实际内容不一致`);
    }
  }
  if (sourcesOk) section.ok(`${name}：sources 的 path 与 sha256 全部与源文件复算一致`);

  // --- 内嵌 index 与实际目录一致 ---
  const index = snapshot.index ?? {};
  const expectedSchoolIds = schoolDocs.map((school) => school.doc?.id).sort();
  const indexedSchoolIds = (index.schools ?? []).map((school) => school.id).sort();
  const schoolMissing = expectedSchoolIds.filter((id) => !indexedSchoolIds.includes(id));
  const schoolExtra = indexedSchoolIds.filter((id) => !expectedSchoolIds.includes(id));
  if (schoolMissing.length > 0) section.fail(`${name}：index.schools 缺少学校 ${schoolMissing.join(', ')}`);
  if (schoolExtra.length > 0) section.fail(`${name}：index.schools 多余学校 ${schoolExtra.join(', ')}`);
  if (schoolMissing.length === 0 && schoolExtra.length === 0) {
    section.ok(`${name}：index.schools 的学校 id 集合与目录一致（${indexedSchoolIds.join(', ')}）`);
  }

  const expectedIndexSystemIds = systemDocs.map((system) => system.doc?.id).sort();
  const indexedSystemIds = (index.systems ?? []).map((system) => system.id).sort();
  const systemMissing = expectedIndexSystemIds.filter((id) => !indexedSystemIds.includes(id));
  const systemExtra = indexedSystemIds.filter((id) => !expectedIndexSystemIds.includes(id));
  if (systemMissing.length > 0) section.fail(`${name}：index.systems 缺少系统 ${systemMissing.join(', ')}`);
  if (systemExtra.length > 0) section.fail(`${name}：index.systems 多余系统 ${systemExtra.join(', ')}`);
  if (systemMissing.length === 0 && systemExtra.length === 0) {
    section.ok(`${name}：index.systems 的系统 id 集合与目录一致（${indexedSystemIds.join(', ')}）`);
  }

  for (const entry of index.schools ?? []) {
    if (entry.system === null) continue;
    if (!indexedSystemIds.includes(entry.system)) {
      section.fail(`${name}：index 里学校 "${entry.id}" 引用的系统 "${entry.system}" 不在 index.systems 里`);
    }
    if (!expectedIndexSystemIds.includes(entry.system)) {
      section.fail(`${name}：index 里学校 "${entry.id}" 引用的系统 "${entry.system}" 在 presets/systems/ 下不存在`);
    }
    for (const key of ['configPath', 'timetablePath']) {
      const value = entry[key];
      if (value === null) continue;
      if (!existsSync(join(root, value))) {
        section.fail(`${name}：index 里学校 "${entry.id}" 的 ${key} 不存在（${value}）`);
      }
    }
  }

  // index.systems 的 detect / entryPath / hint / hasParser 必须是源文件的真实编译结果
  for (const entry of index.systems ?? []) {
    const system = systemDocs.find((item) => item.doc?.id === entry.id);
    if (system === undefined) continue;
    const expected = compileSystemConfig(system.doc);
    if (JSON.stringify(entry.detect) !== JSON.stringify(expected.detect)) {
      section.fail(`${name}：index 里系统 "${entry.id}" 的 detect 与 system.json 编译结果不一致`);
    }
    if (entry.entryPath !== expected.entryPath || entry.hint !== expected.hint) {
      section.fail(`${name}：index 里系统 "${entry.id}" 的 entryPath/hint 与 system.json 不一致`);
    }
    if (entry.hasParser !== (system.parserFile !== undefined)) {
      section.fail(`${name}：index 里系统 "${entry.id}" 的 hasParser 与实际文件不一致`);
    }
  }
  section.ok(`${name}：index.systems 的 detect / entryPath / hint / hasParser 与源文件一致`);

  // --- 快照可复现：同一 generatedAt 重算必须逐字节相同（含内嵌 index）---
  try {
    const { snapshot: rebuilt, index: rebuiltIndex } = buildSnapshot({ root, generatedAt: snapshot.generatedAt });
    if (canonicalJson(rebuilt) !== canonicalJson(snapshot)) {
      section.fail(`${name}：用当前目录重算快照与提交内容不一致（改了预设请重跑 node scripts/snapshot.mjs 并提交快照）`);
    } else {
      section.ok(`${name}：可从当前目录完整复现（重算结果逐字节相同）`);
    }
    if (canonicalJson(rebuiltIndex) !== canonicalJson(snapshot.index)) {
      section.fail(`${name}：内嵌 index 与目录重算结果不一致`);
    } else {
      section.ok(`${name}：内嵌 index 可从目录完整复现`);
    }
  } catch (error) {
    section.fail(`${name}：重算快照失败（${error.message}）`);
  }
  return snapshot;
}

/* ------------------------------------------------------------------ */
/* D1：解析器静态安全扫描                                                */
/* ------------------------------------------------------------------ */

/**
 * D1：解析器静态安全扫描（systems/<id>/parse.js 与 schools/<dir>/parse.js）。
 * @param {Array<object>} systems 系统文档
 * @param {Array<object>} [schools] 学校文档（学校级解析器同样受静态扫描约束）
 */
export function checkAdapters(root, report, systems = [], schools = []) {
  const section = report.section('D. 解析器静态安全扫描');
  const parserFiles = [
    ...systems.flatMap((system) => system.parserFiles),
    ...schools.flatMap((school) => school.parserFiles),
  ]
    .filter((file) => file.endsWith('.js'))
    .sort();
  if (parserFiles.length === 0) {
    section.warn('presets/**/parse.js：没有解析器文件');
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
export async function checkAdapterSandbox(root, report, systems, cases, adapterFiles, schools = []) {
  const section = report.section('D2. 解析器沙箱冒烟（受限子进程）');
  if (adapterFiles.length === 0) {
    section.warn('没有解析器可运行');
    return;
  }
  for (const file of adapterFiles) {
    const system = systems.find((item) => item.parserFile === file);
    const school = schools.find((item) => item.parserFile === file);
    if (system === undefined && school === undefined) {
      section.warn(`${rel(root, file)}：没有对应的学校 / 系统目录，跳过沙箱执行`);
      continue;
    }
    // system 文档的 dir 是「presets/systems」下的目录名，school 文档的 dir 是绝对路径
    const ownerDir = system !== undefined ? join(root, 'presets', 'systems', system.dirName) : school.dir;
    const testCase = cases.find((item) => item.fixturesDir === join(ownerDir, 'fixtures'));
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
      const different = expected.findIndex((event, index) => !isDeepStrictEqual(event, expected[index]));
      section.fail(
        `${rel(root, file)} 沙箱产出与夹具 ${testCase.data.fixtures.events} 不一致：` +
        `第 ${(different === -1 ? Math.min(events.length, expected.length) : different) + 1} 条不同（实际 ${events.length} 条、期望 ${expected.length} 条）`,
      );
      continue;
    }
    const kind = school !== undefined ? '学校级' : '系统级';
    section.ok(
      `${rel(root, file)}（${kind}）沙箱执行成功：${events.length} 条事件与夹具逐条一致（用例 ${testCase.data.id}，${result.meta.durationMs}ms，权限参数 ${result.meta.permissionFlag}）`,
    );
  }
}

/* ------------------------------------------------------------------ */
/* D3：解析器优先级                                                     */
/* ------------------------------------------------------------------ */

/**
 * D3：解析器优先级检查 —— 学校级 parse.js 存在时，该校就用学校级（覆盖系统级）。
 * 这里只做「声明 + 提示」，真正的选择在客户端：schools/<id>/parse.js ＞ systems/<sys>/parse.js。
 */
export function checkParserPriority(report, systems = [], schools = []) {
  const section = report.section('D3. 解析器优先级（学校级 > 系统级）');
  const systemWithParser = new Set(systems.filter((system) => system.parserFile !== undefined).map((system) => system.doc?.id));
  for (const school of schools) {
    const systemId = school.doc?.system ?? null;
    if (school.parserFile !== undefined) {
      if (systemId !== null && systemWithParser.has(systemId)) {
        section.ok(
          `schools/${school.dirName}/parse.js 生效，覆盖 systems/${systemId}/parse.js（其余学校仍用系统级）`,
        );
      } else {
        section.ok(`schools/${school.dirName}/parse.js 生效（该校没有系统级解析器可继承）`);
      }
    } else if (systemId !== null) {
      section.info(`schools/${school.dirName}/：没有学校级解析器，使用 systems/${systemId}/parse.js`);
    }
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
  const adapterFiles = checkAdapters(root, report, systems, schools);
  checkParserPriority(report, systems, schools);
  checkSnapshot(root, report, { schools, systems });
  checkVersion(root, report);
  if (options.scanOnly) {
    const section = report.section('D2. 解析器沙箱冒烟（受限子进程）');
    section.info('--scan-only，跳过该步');
  } else {
    await checkAdapterSandbox(root, report, systems, cases, adapterFiles, schools);
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

export { formatPath, repoRel };
