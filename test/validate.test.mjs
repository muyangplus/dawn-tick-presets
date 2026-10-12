/**
 * validate.test.mjs —— 校验器 / 安全扫描 / 沙箱 / 快照的自动化用例（node --test，零第三方依赖）
 *
 * 结构：合并后的 `schools/<id>/school.json`（身份 + 作息 + 覆盖）与
 *       `systems/<id>/system.json`（元数据 + 识别 + 登录），唯一产物是内嵌 `index` 的快照。
 *
 * 覆盖：
 *   1. 合法的新结构仓库通过全部 schema + 语义 + 跨文件校验
 *   2. 非法配置各自报错且信息可读（重复 periodNo / 时间格式错 / end<=start / 未知系统 id /
 *      markers 非法正则 / school.json 未知键 / 快照与目录不一致 …）
 *   3. 硬规则：**学校级与系统级**只要有 parse.js，同目录 fixtures/ 就必须非空
 *   4. 解析器静态安全扫描命中 eval( / require(（含行号）
 *   5. 沙箱拒绝越权适配器并以结构化错误返回；死循环超时；正常解析器可跑
 *   6. 快照可复现（同一时间戳 → 同一哈希），旧字段结构不变 + 新增 index 覆盖在 hash 内
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, cpSync, writeFileSync, rmSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  checkTimetables,
  checkSystems,
  checkConformance,
  checkSnapshot,
  checkParserPriority,
  checkAdapters,
  checkAdapterSandbox,
  checkVersion,
  checkSystemsCrossFile,
  snapshotVersionFromName,
  Report,
  SCHOOL_SYSTEM_IDS,
  SCHOOL_CONFIG_KEYS,
  RETIRED_ARTIFACTS,
} from '../scripts/validate.mjs';
import { runAdapterSandbox, SANDBOX_LIMITS } from '../scripts/sandbox-run.mjs';
import { buildSnapshot, canonicalJson, sha256, extractTimetableText, timetableSourcePath } from '../scripts/snapshot.mjs';
import { compileSystemConfig, compileSystemConfigText, DETECT_KEY_ORDER } from '../scripts/lib/legacy.mjs';
import { buildIndex, listDirs } from '../scripts/lib/repo.mjs';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCHEMA_FILES = ['school.schema.json', 'system.schema.json', 'snapshot.schema.json'];
const AT = '2026-01-01T00:00:00.000Z';
let TMP_ROOT;

function makeRepoFixture(label) {
  const dir = mkdtempSync(join(TMP_ROOT, `${label}-`));
  mkdirSync(join(dir, 'schema'), { recursive: true });
  for (const name of SCHEMA_FILES) cpSync(join(REPO_ROOT, 'schema', name), join(dir, 'schema', name));
  mkdirSync(join(dir, 'presets', 'schools'), { recursive: true });
  mkdirSync(join(dir, 'presets', 'systems'), { recursive: true });
  mkdirSync(join(dir, 'snapshot'), { recursive: true });
  writeFileSync(join(dir, 'version.json'), JSON.stringify({
    version: '0.1.0',
    schemaVersion: 1,
    generatedAt: AT,
    channel: 'stable',
  }, null, 2));
  return dir;
}

const VALID_SYSTEMS = {
  jwglxt: {
    doc: {
      id: 'jwglxt',
      name: '正方教务',
      version: '1.0.0',
      aliases: ['jwglxt'],
      detect: {
        markers: ['jwglxt'],
        timetableTableIds: ['kbtable'],
        timetableTableClasses: ['kb'],
        gridCellIdPatterns: ['\\d{1,2}[-_]\\d{1,2}'],
      },
      login: { entryPath: '/jwglxt/xtgl/login_slogin.html', hint: '提示' },
    },
    parser: [
      'export function parse({ html, url, hints }) {',
      '  const events = [];',
      '  const re = /<td\\b[^>]*\\bid\\s*=\\s*["\']\\s*(\\d{1,2})\\s*[-_]\\s*(\\d{1,2})\\s*["\'][^>]*>([\\s\\S]*?)<\\/td>/gi;',
      '  let match = re.exec(html);',
      '  while (match !== null) {',
      '    events.push({ title: "课时", dayOfWeek: Number(match[2]), periodStart: Number(match[1]) * 2 - 1, periodEnd: Number(match[1]) * 2, room: "", teacher: "", weeks: [] });',
      '    match = re.exec(html);',
      '  }',
      '  return { events };',
      '}',
    ].join('\n'),
    page: '<table id="kbtable"><tr><td id="1-2">高等数学</td></tr></table>',
  },
  qzdatasource: {
    doc: {
      id: 'qzdatasource',
      name: '强智教务',
      detect: { markers: [], timetableTableIds: [], timetableTableClasses: [], gridCellIdPatterns: [] },
      login: { entryPath: '/jsxsd/', hint: '提示' },
    },
    parser: 'export function parse({ html }) { return { events: [] }; }\n',
    page: '<table id="kbtable"><tr><td id="1-2">高等数学</td></tr></table>',
  },
  urp: {
    doc: {
      id: 'urp',
      name: 'URP 教务',
      detect: { markers: ['urp'], timetableTableIds: [], timetableTableClasses: [], gridCellIdPatterns: [] },
      login: { entryPath: '/', hint: '提示' },
    },
    parser: 'export function parse({ html }) { return { events: [] }; }\n',
    page: '<table id="kbtable"><tr><td id="1-2">高等数学</td></tr></table>',
  },
  other: {
    doc: {
      id: 'other',
      name: '其他教务',
      detect: { markers: [], timetableTableIds: [], timetableTableClasses: [], gridCellIdPatterns: [] },
      login: { entryPath: '/', hint: '提示' },
    },
    parser: 'export function parse({ html }) { return { events: [] }; }\n',
    page: '<table id="kbtable"><tr><td id="1-2">高等数学</td></tr></table>',
  },
};

/** 在 fixture 仓库里写一个系统目录（system.json，可选 parse.js + fixtures）。 */
function writeSystem(dir, id, { withParser = false, fixtures = undefined } = {}) {
  const spec = VALID_SYSTEMS[id];
  const systemDir = join(dir, 'presets', 'systems', id);
  mkdirSync(systemDir, { recursive: true });
  writeFileSync(join(systemDir, 'system.json'), JSON.stringify(spec.doc, null, 2));
  if (withParser) writeFileSync(join(systemDir, 'parse.js'), spec.parser);
  if (fixtures !== undefined) {
    const fixturesDir = join(systemDir, 'fixtures');
    mkdirSync(fixturesDir, { recursive: true });
    if (fixtures.page) writeFileSync(join(fixturesDir, 'sample-page.html'), spec.page);
    if (fixtures.events) {
      writeFileSync(join(fixturesDir, 'expected-events.json'), JSON.stringify({
        id: `${id}-sample-page`,
        system: id,
        school: 'usts',
        adapter: 'parse.js',
        fixtures: { page: 'sample-page.html', events: 'expected-events.json' },
        input: { url: 'https://example.edu/', hints: {} },
        expect: { minEvents: 1, events: [{ title: '高等数学', dayOfWeek: 2, periodStart: 1, periodEnd: 2 }] },
      }, null, 2));
    }
  }
  return systemDir;
}

/**
 * 在 fixture 仓库里写一个学校目录（合并后的 school.json，可选 parse.js + fixtures）。
 * 身份字段写在顶层，作息放在 timetable 键，覆盖键（login/params/detect）平铺在顶层。
 */
function writeSchool(dir, dirName, { meta, periods, source = '学校教务处公告', config = undefined } = {}) {
  const schoolDir = join(dir, 'presets', 'schools', dirName);
  mkdirSync(schoolDir, { recursive: true });
  const doc = {
    id: meta.id,
    name: meta.name,
    ...(meta.region === undefined ? {} : { region: meta.region }),
    ...(meta.type === undefined ? {} : { type: meta.type }),
    ...(meta.generic === undefined ? {} : { generic: meta.generic }),
    ...(meta.aliases === undefined ? {} : { aliases: meta.aliases }),
    system: meta.system ?? null,
  };
  if (config !== undefined) for (const [key, value] of Object.entries(config)) doc[key] = value;
  doc.timetable = {
    id: meta.id,
    name: meta.name,
    source,
    periods: periods ?? [
      { periodNo: 1, start: '08:00', end: '08:45' },
      { periodNo: 2, start: '08:55', end: '09:40' },
    ],
  };
  writeFileSync(join(schoolDir, 'school.json'), JSON.stringify(doc, null, 2));
  return schoolDir;
}

/** 一套合法的新结构数据。 */
function writeValidRepo(dir, { withParser = false, fixtures = undefined } = {}) {
  writeSchool(dir, 'usts', {
    meta: { id: 'usts', name: '苏州科技大学', region: '江苏', type: 'university', system: 'jwglxt', aliases: ['苏科大'] },
    periods: [
      { periodNo: 1, start: '08:00', end: '08:45' },
      { periodNo: 2, start: '08:55', end: '09:40' },
      { periodNo: 3, start: '09:55', end: '10:40' },
    ],
  });
  writeSchool(dir, '_default', {
    meta: { id: 'default', name: '通用作息', type: 'generic', generic: true, system: null },
    periods: [{ periodNo: 1, start: '08:00', end: '08:45' }],
    source: '内置默认',
  });
  for (const id of Object.keys(VALID_SYSTEMS)) {
    writeSystem(dir, id, { withParser: id === 'jwglxt' && withParser, fixtures });
  }
  return dir;
}

/** 生成快照（与 snapshot.mjs 完全同一套代码路径）。 */
function writeSnapshot(dir, generatedAt = AT) {
  const { snapshot } = buildSnapshot({ root: dir, generatedAt });
  writeFileSync(join(dir, 'snapshot', `presets-${snapshot.version}.json`), JSON.stringify(snapshot, null, 2));
  return snapshot;
}

/** 跑一次校验并返回 { passed, errors, text, docs }。 */
function runChecks(dir, options = {}) {
  const report = new Report();
  const schools = options.schools === false ? [] : checkTimetables(dir, report);
  const systems = options.systems === false ? [] : checkSystems(dir, report);
  const cases = options.conformance === false ? [] : checkConformance(dir, report);
  const adapters = options.adapters === false || options.systems === false
    ? []
    : checkAdapters(dir, report, systems, schools);
  if (options.snapshot === true) checkSnapshot(dir, report, { schools, systems });
  if (options.version !== false) checkVersion(dir, report);
  return { passed: report.passed, errors: report.errors, text: report.toText(), schools, systems, cases, adapters };
}

function errorsText(errors) {
  return errors.join('\n');
}

before(() => {
  TMP_ROOT = mkdtempSync(join(tmpdir(), 'dawntick-presets-test-'));
});

after(() => {
  if (TMP_ROOT !== undefined) rmSync(TMP_ROOT, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */
/* 1. 合法配置                                                          */
/* ------------------------------------------------------------------ */

describe('合法配置', () => {
  test('完整的新结构仓库通过全部 schema + 语义 + 跨文件校验', () => {
    const dir = writeValidRepo(makeRepoFixture('valid'), { withParser: true, fixtures: { page: true, events: true } });
    writeSnapshot(dir);
    const result = runChecks(dir, { snapshot: true });
    assert.equal(result.passed, true, `预期通过，实际错误：\n${errorsText(result.errors)}`);
    assert.match(result.text, /school\.json Schema 通过/);
    assert.match(result.text, /夹具齐全/);
    assert.match(result.text, /跨文件一致性：systems 的 id 集合与 SCHOOL_SYSTEM_IDS 完全一致/);
    assert.match(result.text, /other 不参与识别/);
  });

  test('真实仓库根目录本身通过校验（含快照复现，不含沙箱冒烟）', () => {
    const result = runChecks(REPO_ROOT, { snapshot: true });
    assert.equal(result.passed, true, `真实仓库应通过：\n${errorsText(result.errors)}`);
    assert.equal(result.schools.length, 2, '真实仓库应有 2 个学校目录（usts + _default）');
    assert.equal(result.systems.length, 4, '真实仓库应有 4 个系统目录');
  });

  test('SCHOOL_SYSTEM_IDS 与主项目约定一致', () => {
    assert.deepEqual(SCHOOL_SYSTEM_IDS, ['jwglxt', 'qzdatasource', 'urp', 'other']);
  });

  test('学校目录名与作息 id 可以不同（_default → default），generic 必须配 default 作息', () => {
    const dir = writeValidRepo(makeRepoFixture('valid-generic'));
    const result = runChecks(dir, { systems: false });
    assert.equal(result.passed, true, errorsText(result.errors));
    const def = result.schools.find((school) => school.dirName === '_default');
    assert.equal(def.doc.id, 'default');
    assert.equal(def.doc.generic, true);
    assert.equal(def.doc.timetable.id, 'default');
    assert.match(result.text, /presets\/schools\/_default\/school\.json Schema 通过/);

    // 反例：generic 为 true 但 timetable.id 不是 default → 报错
    const schoolDir = writeSchool(dir, '_default', {
      meta: { id: 'default', name: '通用作息', generic: true, system: null },
      periods: [{ periodNo: 1, start: '08:00', end: '08:45' }],
    });
    const file = join(schoolDir, 'school.json');
    const doc = JSON.parse(readFileSync(file, 'utf8'));
    doc.timetable.id = 'generic';
    writeFileSync(file, JSON.stringify(doc, null, 2));
    const broken = runChecks(dir, { systems: false, version: false });
    assert.equal(broken.passed, false);
    assert.match(errorsText(broken.errors), /generic 为 true 时 timetable\.id 必须是 "default"/);
  });
});

/* ------------------------------------------------------------------ */
/* 2. 作息表非法配置（school.json 的 timetable 键）                       */
/* ------------------------------------------------------------------ */

describe('作息表非法配置', () => {
  function withPeriods(periods) {
    const dir = writeValidRepo(makeRepoFixture('t-invalid'));
    writeSchool(dir, 'usts', {
      meta: { id: 'usts', name: '苏州科技大学', system: 'jwglxt' },
      periods,
    });
    return dir;
  }

  test('重复 periodNo 报错', () => {
    const dir = withPeriods([
      { periodNo: 1, start: '08:00', end: '08:45' },
      { periodNo: 1, start: '08:55', end: '09:40' },
    ]);
    const result = runChecks(dir, { systems: false, version: false });
    assert.equal(result.passed, false);
    assert.match(errorsText(result.errors), /periodNo 重复/);
  });

  test('时间格式错误（8:00 缺少前导零）报错', () => {
    const dir = withPeriods([
      { periodNo: 1, start: '8:00', end: '08:45' },
      { periodNo: 2, start: '08:55', end: '09:40' },
    ]);
    const result = runChecks(dir, { systems: false, version: false });
    assert.equal(result.passed, false);
    assert.match(errorsText(result.errors), /Schema/);
    assert.match(errorsText(result.errors), /不匹配模式|时间格式非法/);
  });

  test('end <= start 报错', () => {
    const dir = withPeriods([{ periodNo: 1, start: '09:00', end: '08:45' }]);
    const result = runChecks(dir, { systems: false, version: false });
    assert.equal(result.passed, false);
    assert.match(errorsText(result.errors), /end\(08:45\) 必须晚于 start\(09:00\)/);
  });

  test('相邻节次重叠报错', () => {
    const dir = withPeriods([
      { periodNo: 1, start: '08:00', end: '08:50' },
      { periodNo: 2, start: '08:45', end: '09:30' },
    ]);
    const result = runChecks(dir, { systems: false, version: false });
    assert.equal(result.passed, false);
    assert.match(errorsText(result.errors), /时间重叠/);
  });

  test('periodNo 从 1 起跳号报错', () => {
    const dir = withPeriods([
      { periodNo: 2, start: '08:00', end: '08:45' },
      { periodNo: 3, start: '08:55', end: '09:40' },
    ]);
    const result = runChecks(dir, { systems: false, version: false });
    assert.equal(result.passed, false);
    assert.match(errorsText(result.errors), /从 1 起连续无跳号/);
  });

  test('缺少 school.json 报错（合并后不再是 meta.json + timetable.json）', () => {
    const dir = writeValidRepo(makeRepoFixture('t-missing'));
    rmSync(join(dir, 'presets', 'schools', 'usts', 'school.json'));
    const result = runChecks(dir, { systems: false, version: false });
    assert.equal(result.passed, false);
    assert.match(errorsText(result.errors), /presets\/schools\/usts\/：缺少 school\.json/);
  });

  test('school.json 里缺少 timetable 键报错', () => {
    const dir = writeValidRepo(makeRepoFixture('t-notimetable'));
    const file = join(dir, 'presets', 'schools', 'usts', 'school.json');
    const doc = JSON.parse(readFileSync(file, 'utf8'));
    delete doc.timetable;
    writeFileSync(file, JSON.stringify(doc, null, 2));
    const result = runChecks(dir, { systems: false, version: false });
    assert.equal(result.passed, false);
    assert.match(errorsText(result.errors), /缺少 timetable/);
  });

  test('学校 system 字段缺失报错（schema 必填）', () => {
    const dir = writeValidRepo(makeRepoFixture('t-nosys'));
    const file = join(dir, 'presets', 'schools', 'usts', 'school.json');
    const doc = JSON.parse(readFileSync(file, 'utf8'));
    delete doc.system;
    writeFileSync(file, JSON.stringify(doc, null, 2));
    const result = runChecks(dir, { systems: false, version: false });
    assert.equal(result.passed, false);
    assert.match(errorsText(result.errors), /缺少必填字段 "system"/);
  });
});

/* ------------------------------------------------------------------ */
/* 3. 教务系统非法配置                                                   */
/* ------------------------------------------------------------------ */

describe('教务系统非法配置', () => {
  test('未知系统 id 报错（schema pattern + 跨文件一致性）', () => {
    const dir = writeValidRepo(makeRepoFixture('s-id'));
    writeSystem(dir, 'urp');
    const systemDir = join(dir, 'presets', 'systems', 'unknown');
    mkdirSync(systemDir, { recursive: true });
    writeFileSync(join(systemDir, 'system.json'), JSON.stringify({
      id: 'unknown',
      name: '未知教务',
      detect: { markers: [], timetableTableIds: [], timetableTableClasses: [], gridCellIdPatterns: [] },
      login: { entryPath: '/unknown/', hint: '提示' },
    }, null, 2));
    const result = runChecks(dir, { version: false });
    assert.equal(result.passed, false);
    const text = errorsText(result.errors);
    assert.match(text, /未知系统 id "unknown"/);
    assert.match(text, /不在 SCHOOL_SYSTEM_IDS/);
  });

  test('未知系统 id 在语义层同样被拦（跳过 schema 校验时）', () => {
    const report = new Report();
    checkSystemsCrossFile(
      [{ name: 'presets/systems/hijack/system.json', data: { id: 'hijack', detect: { markers: [], timetableTableIds: [], timetableTableClasses: [], gridCellIdPatterns: [] } } }],
      ['jwglxt', 'qzdatasource', 'urp', 'other'],
      report,
    );
    assert.equal(report.passed, false);
    assert.match(errorsText(report.errors), /未知系统 id "hijack"/);
    assert.match(errorsText(report.errors), /不在 SCHOOL_SYSTEM_IDS/);
  });

  test('目录名与 system.json 的 id 不一致报错', () => {
    const dir = writeValidRepo(makeRepoFixture('s-dirname'));
    writeSystem(dir, 'urp');
    const systemDir = join(dir, 'presets', 'systems', 'sust');
    mkdirSync(systemDir, { recursive: true });
    writeFileSync(join(systemDir, 'system.json'), JSON.stringify(VALID_SYSTEMS.urp.doc, null, 2));
    const result = runChecks(dir, { version: false });
    assert.equal(result.passed, false);
    assert.match(errorsText(result.errors), /文件内 id "urp" 与目录名 "sust" 不一致/);
  });

  test('schools/<dir>/school.json 引用的系统不存在时报错', () => {
    const dir = writeValidRepo(makeRepoFixture('s-ref'));
    writeSchool(dir, 'njupt', {
      meta: { id: 'njupt', name: '南京邮电大学', system: 'nosuch' },
      periods: [{ periodNo: 1, start: '08:00', end: '08:45' }],
    });
    writeSnapshot(dir);
    const report = new Report();
    const schools = checkTimetables(dir, report);
    const systems = checkSystems(dir, report);
    checkSnapshot(dir, report, { schools, systems });
    assert.equal(report.passed, false);
    assert.match(errorsText(report.errors), /index 里学校 "njupt" 引用的系统 "nosuch" 不在 index\.systems 里/);
    assert.match(errorsText(report.errors), /引用的系统 "nosuch" 在 presets\/systems\/ 下不存在/);
  });

  test('markers 非法正则报错', () => {
    const dir = writeValidRepo(makeRepoFixture('s-re'));
    const file = join(dir, 'presets', 'systems', 'jwglxt', 'system.json');
    const data = JSON.parse(readFileSync(file, 'utf8'));
    data.detect.markers = ['jwglxt', '([unclosed'];
    writeFileSync(file, JSON.stringify(data, null, 2));
    const result = runChecks(dir, { schools: false, version: false });
    assert.equal(result.passed, false);
    assert.match(errorsText(result.errors), /不是合法正则/);
  });

  test('gridCellIdPatterns 非法正则报错', () => {
    const dir = writeValidRepo(makeRepoFixture('s-re2'));
    const file = join(dir, 'presets', 'systems', 'jwglxt', 'system.json');
    const data = JSON.parse(readFileSync(file, 'utf8'));
    data.detect.gridCellIdPatterns = ['*bad'];
    writeFileSync(file, JSON.stringify(data, null, 2));
    const result = runChecks(dir, { schools: false, version: false });
    assert.equal(result.passed, false);
    assert.match(errorsText(result.errors), /gridCellIdPatterns 中的 "\*bad" 不是合法正则/);
  });

  test('login.entryPath 不以 / 开头报错（schema 层拦截）', () => {
    const dir = writeValidRepo(makeRepoFixture('s-entry'));
    const file = join(dir, 'presets', 'systems', 'jwglxt', 'system.json');
    const data = JSON.parse(readFileSync(file, 'utf8'));
    data.login.entryPath = 'jwglxt/xtgl/login_slogin.html';
    writeFileSync(file, JSON.stringify(data, null, 2));
    const result = runChecks(dir, { schools: false, version: false });
    assert.equal(result.passed, false);
    assert.match(errorsText(result.errors), /不匹配模式/);
  });

  test('login.entryPath 含域名报错', () => {
    const dir = writeValidRepo(makeRepoFixture('s-domain'));
    const file = join(dir, 'presets', 'systems', 'jwglxt', 'system.json');
    const data = JSON.parse(readFileSync(file, 'utf8'));
    data.login.entryPath = '//jwgl.usts.edu.cn/jwglxt/';
    writeFileSync(file, JSON.stringify(data, null, 2));
    const report = new Report();
    checkSystems(dir, report);
    assert.equal(report.passed, false);
    assert.match(errorsText(report.errors), /不能含协议或域名/);
  });

  test('缺少某个系统目录时报跨文件一致性错误', () => {
    const dir = writeValidRepo(makeRepoFixture('s-missing'));
    rmSync(join(dir, 'presets', 'systems', 'urp'), { recursive: true, force: true });
    const result = runChecks(dir, { schools: false, version: false });
    assert.equal(result.passed, false);
    assert.match(errorsText(result.errors), /缺少系统配置 urp/);
  });

  test('other 参与识别时报错', () => {
    const dir = writeValidRepo(makeRepoFixture('s-other'));
    const file = join(dir, 'presets', 'systems', 'other', 'system.json');
    const data = JSON.parse(readFileSync(file, 'utf8'));
    data.detect.markers = ['something'];
    writeFileSync(file, JSON.stringify(data, null, 2));
    const result = runChecks(dir, { schools: false, version: false });
    assert.equal(result.passed, false);
    assert.match(errorsText(result.errors), /other 的系统不得参与识别/);
  });
});

/* ------------------------------------------------------------------ */
/* 4. 夹具硬规则（系统级 + 学校级）                                      */
/* ------------------------------------------------------------------ */

describe('解析器夹具硬规则', () => {
  test('系统级：有 parse.js 但 fixtures/ 为空 → 校验失败（反例）', () => {
    const dir = makeRepoFixture('f-empty');
    writeValidRepo(dir);
    const systemDir = writeSystem(dir, 'jwglxt', { withParser: true });
    mkdirSync(join(systemDir, 'fixtures'), { recursive: true });
    const result = runChecks(dir, { schools: false, version: false });
    assert.equal(result.passed, false);
    assert.match(
      errorsText(result.errors),
      /presets\/systems\/jwglxt\/：存在 parse\.js 但 fixtures\/ 为空或不存在/,
    );
    assert.match(result.text, /有解析器就必须有夹具/);
  });

  test('系统级：有 parse.js 但 fixtures/ 目录不存在 → 校验失败', () => {
    const dir = makeRepoFixture('f-nodir');
    writeValidRepo(dir);
    writeSystem(dir, 'jwglxt', { withParser: true });
    const result = runChecks(dir, { schools: false, version: false });
    assert.equal(result.passed, false);
    assert.match(errorsText(result.errors), /fixtures\/ 为空或不存在/);
  });

  test('系统级：fixtures/ 只有期望事件、缺页面样本 → 校验失败', () => {
    const dir = makeRepoFixture('f-nopage');
    writeValidRepo(dir);
    writeSystem(dir, 'jwglxt', { withParser: true, fixtures: { events: true } });
    const result = runChecks(dir, { schools: false, version: false });
    assert.equal(result.passed, false);
    assert.match(errorsText(result.errors), /缺少页面样本/);
  });

  test('系统级：fixtures/ 只有页面样本、缺期望事件 → 校验失败', () => {
    const dir = makeRepoFixture('f-noevents');
    writeValidRepo(dir);
    writeSystem(dir, 'jwglxt', { withParser: true, fixtures: { page: true } });
    const result = runChecks(dir, { schools: false, version: false });
    assert.equal(result.passed, false);
    assert.match(errorsText(result.errors), /缺少期望事件文件/);
  });

  test('没有 parse.js 的系统不需要夹具（不报错）', () => {
    const dir = makeRepoFixture('f-optional');
    writeValidRepo(dir);
    const result = runChecks(dir, { schools: false, version: false });
    assert.equal(result.passed, true, errorsText(result.errors));
    assert.match(result.text, /没有 parse\.js（夹具可选/);
  });

  test('一个系统目录里出现多个解析器 → 校验失败', () => {
    const dir = makeRepoFixture('f-two');
    writeValidRepo(dir);
    const systemDir = writeSystem(dir, 'jwglxt', { withParser: true, fixtures: { page: true, events: true } });
    writeFileSync(join(systemDir, 'parse-extra.js'), 'export function parse() { return { events: [] }; }\n');
    const result = runChecks(dir, { schools: false, version: false });
    assert.equal(result.passed, false);
    assert.match(errorsText(result.errors), /只允许一个解析器 parse\.js/);
  });

  test('学校级：有 parse.js 但 fixtures/ 为空 → 校验失败（新增硬规则）', () => {
    const dir = makeRepoFixture('f-school-empty');
    writeValidRepo(dir);
    const schoolDir = join(dir, 'presets', 'schools', 'usts');
    writeFileSync(join(schoolDir, 'parse.js'), 'export function parse({ html }) { return { events: [] }; }\n');
    mkdirSync(join(schoolDir, 'fixtures'), { recursive: true });
    const result = runChecks(dir, { version: false });
    assert.equal(result.passed, false);
    assert.match(
      errorsText(result.errors),
      /presets\/schools\/usts\/：存在 parse\.js 但 fixtures\/ 为空或不存在/,
    );
  });

  test('学校级：fixtures/ 缺少页面样本或期望事件都报错', () => {
    const dir = makeRepoFixture('f-school-partial');
    writeValidRepo(dir);
    const schoolDir = join(dir, 'presets', 'schools', 'usts');
    writeFileSync(join(schoolDir, 'parse.js'), 'export function parse({ html }) { return { events: [] }; }\n');
    mkdirSync(join(schoolDir, 'fixtures'), { recursive: true });
    writeFileSync(join(schoolDir, 'fixtures', 'expected-events.json'), JSON.stringify({
      id: 'usts-case',
      system: 'jwglxt',
      adapter: 'parse.js',
      fixtures: { page: 'sample-page.html', events: 'expected-events.json' },
      input: { url: 'https://example.edu/', hints: {} },
      expect: { minEvents: 0, events: [] },
    }, null, 2));
    const onlyEvents = runChecks(dir, { version: false });
    assert.equal(onlyEvents.passed, false);
    assert.match(errorsText(onlyEvents.errors), /缺少页面样本/);

    writeFileSync(join(schoolDir, 'fixtures', 'sample-page.html'), '<html></html>');
    rmSync(join(schoolDir, 'fixtures', 'expected-events.json'));
    const onlyPage = runChecks(dir, { version: false });
    assert.equal(onlyPage.passed, false);
    assert.match(errorsText(onlyPage.errors), /缺少期望事件文件/);
  });

  test('学校级解析器齐全的夹具 → 通过，且学校级解析器同样被静态扫描', () => {
    const dir = makeRepoFixture('f-school-ok');
    writeValidRepo(dir);
    const schoolDir = join(dir, 'presets', 'schools', 'usts');
    writeFileSync(join(schoolDir, 'parse.js'), 'export function parse({ html }) { return { events: [] }; }\n');
    mkdirSync(join(schoolDir, 'fixtures'), { recursive: true });
    writeFileSync(join(schoolDir, 'fixtures', 'sample-page.html'), '<html></html>');
    writeFileSync(join(schoolDir, 'fixtures', 'expected-events.json'), JSON.stringify({
      id: 'usts-case',
      system: 'jwglxt',
      adapter: 'parse.js',
      fixtures: { page: 'sample-page.html', events: 'expected-events.json' },
      input: { url: 'https://example.edu/', hints: {} },
      expect: { minEvents: 0, events: [] },
    }, null, 2));
    const result = runChecks(dir, { version: false });
    assert.equal(result.passed, true, errorsText(result.errors));
    assert.match(result.text, /presets\/schools\/usts\/：夹具齐全/);
    assert.match(result.text, /schools\/usts\/parse\.js：未命中任何禁用模式/);
  });

  test('一致性用例的 system 必须与所在系统目录一致', () => {
    const dir = makeRepoFixture('f-wrongsys');
    writeValidRepo(dir);
    writeSystem(dir, 'jwglxt', { withParser: true, fixtures: { page: true, events: true } });
    const caseFile = join(dir, 'presets', 'systems', 'jwglxt', 'fixtures', 'expected-events.json');
    const data = JSON.parse(readFileSync(caseFile, 'utf8'));
    data.system = 'urp';
    writeFileSync(caseFile, JSON.stringify(data, null, 2));
    const result = runChecks(dir, { schools: false, version: false });
    assert.equal(result.passed, false);
    assert.match(errorsText(result.errors), /与所在目录 "systems\/jwglxt\/" 不一致/);
  });

  test('一致性用例引用的页面样本必须存在', () => {
    const dir = makeRepoFixture('f-nofile');
    writeValidRepo(dir);
    writeSystem(dir, 'jwglxt', { withParser: true, fixtures: { page: true, events: true } });
    rmSync(join(dir, 'presets', 'systems', 'jwglxt', 'fixtures', 'sample-page.html'));
    const result = runChecks(dir, { schools: false, version: false });
    assert.equal(result.passed, false);
    assert.match(errorsText(result.errors), /fixtures\.page 指向的页面样本不存在/);
  });

  test('期望事件文件必须与用例内联的 expect 一致', () => {
    const dir = makeRepoFixture('f-mismatch');
    writeValidRepo(dir);
    writeSystem(dir, 'jwglxt', { withParser: true, fixtures: { page: true, events: true } });
    const caseFile = join(dir, 'presets', 'systems', 'jwglxt', 'fixtures', 'expected-events.json');
    const events = JSON.parse(readFileSync(caseFile, 'utf8'));
    events.expect.minEvents = 99;
    writeFileSync(caseFile, JSON.stringify(events, null, 2));
    const result = runChecks(dir, { schools: false, version: false });
    assert.equal(result.passed, false, result.text.replace(/\u001b\[\d+m/g, ''));
    assert.match(errorsText(result.errors), /大于 expected-events\.json 里声明的期望事件数 1/);
  });

  test('期望事件文件的 id 必须与用例一致，minEvents 不能没有依据', () => {
    const dir = makeRepoFixture('f-idmismatch');
    writeValidRepo(dir);
    writeSystem(dir, 'jwglxt', { withParser: true, fixtures: { page: true, events: true } });
    const fixturesDir = join(dir, 'presets', 'systems', 'jwglxt', 'fixtures');
    const eventsFile = join(fixturesDir, 'expected-events.json');
    const events = JSON.parse(readFileSync(eventsFile, 'utf8'));

    // 反例一：期望事件文件的 id 与用例不一致（用例另存为 case.json，events 指向它）
    const caseFile = join(fixturesDir, 'case.json');
    writeFileSync(caseFile, JSON.stringify({
      ...events,
      id: 'jwglxt-case',
      fixtures: { page: 'sample-page.html', events: 'events.json' },
    }, null, 2));
    writeFileSync(join(fixturesDir, 'events.json'), JSON.stringify({ ...events, id: 'another-case' }, null, 2));
    const mismatched = new Report();
    checkConformance(dir, mismatched);
    assert.equal(mismatched.passed, false);
    assert.match(errorsText(mismatched.errors), /id "another-case" 与用例/);

    // 反例二：id 一致但把期望事件清空，minEvents 就不再有依据
    writeFileSync(join(fixturesDir, 'events.json'), JSON.stringify({ ...events, id: 'jwglxt-case', expect: { minEvents: 1, events: [] } }, null, 2));
    const broken = new Report();
    checkConformance(dir, broken);
    assert.equal(broken.passed, false);
    assert.match(errorsText(broken.errors), /expect\.minEvents=1 大于 events\.json 里声明的期望事件数 0/);
  });

  test('沙箱产出必须与夹具里的期望事件逐条一致（真实仓库通过）', async () => {
    const report = new Report();
    const schools = checkTimetables(REPO_ROOT, report);
    const systems = checkSystems(REPO_ROOT, report);
    const cases = checkConformance(REPO_ROOT, report);
    const files = checkAdapters(REPO_ROOT, report, systems, schools);
    assert.equal(report.passed, true, errorsText(report.errors));
    await checkAdapterSandbox(REPO_ROOT, report, systems, cases, files, schools);
    assert.equal(report.passed, true, errorsText(report.errors));
    assert.match(report.toText(), /与夹具逐条一致/);
  });
});

/* ------------------------------------------------------------------ */
/* 5. school.json 的覆盖语义（原 config.json 的四个键）                   */
/* ------------------------------------------------------------------ */

describe('school.json 覆盖语义', () => {
  test('只写身份 + 作息（没有覆盖键）就通过', () => {
    const dir = writeValidRepo(makeRepoFixture('c-min'));
    const result = runChecks(dir, { version: false });
    assert.equal(result.passed, true, errorsText(result.errors));
    assert.match(result.text, /school\.json Schema 通过/);
  });

  test('未知键 → 校验失败', () => {
    const dir = writeValidRepo(makeRepoFixture('c-unknown'));
    const file = join(dir, 'presets', 'schools', 'usts', 'school.json');
    const doc = JSON.parse(readFileSync(file, 'utf8'));
    doc.whatever = true;
    writeFileSync(file, JSON.stringify(doc, null, 2));
    const result = runChecks(dir, { systems: false, version: false });
    assert.equal(result.passed, false);
    const text = errorsText(result.errors);
    assert.match(text, /未知键 whatever/);
    assert.match(text, /不允许的额外字段 "whatever"/);
  });

  test('覆盖键白名单仍是 system / login / params / detect', () => {
    assert.deepEqual(SCHOOL_CONFIG_KEYS, ['system', 'login', 'params', 'detect']);
  });

  test('login 覆盖生效：entryPath 以 / 开头被接受', () => {
    const dir = writeValidRepo(makeRepoFixture('c-login-ok'));
    writeSchool(dir, 'usts', {
      meta: { id: 'usts', name: '苏州科技大学', system: 'jwglxt' },
      config: { login: { entryPath: '/jwglxt/xtgl/login_slogin.html', hint: '课表在「信息查询」' } },
    });
    const result = runChecks(dir, { systems: false, version: false });
    assert.equal(result.passed, true, errorsText(result.errors));
    assert.match(result.text, /login\.entryPath 以 \/ 开头/);
  });

  test('login 覆盖含域名报错', () => {
    const dir = writeValidRepo(makeRepoFixture('c-login'));
    writeSchool(dir, 'usts', {
      meta: { id: 'usts', name: '苏州科技大学', system: 'jwglxt' },
      config: { login: { entryPath: 'https://jwgl.usts.edu.cn/x/' } },
    });
    const result = runChecks(dir, { systems: false, version: false });
    assert.equal(result.passed, false);
    assert.match(errorsText(result.errors), /login\.entryPath .*不匹配模式/);
  });

  test('detect 只允许追加 markers / timetableTableIds / timetableTableClasses', () => {
    const dir = writeValidRepo(makeRepoFixture('c-detect'));
    writeSchool(dir, 'usts', {
      meta: { id: 'usts', name: '苏州科技大学', system: 'jwglxt' },
      config: { detect: { markers: ['usts-jwglxt'], gridCellIdPatterns: ['x'] } },
    });
    const result = runChecks(dir, { systems: false, version: false });
    assert.equal(result.passed, false);
    assert.match(errorsText(result.errors), /不允许的额外字段 "gridCellIdPatterns"/);
  });

  test('detect 只做并集：追加 markers 通过且提示不可删除系统级特征', () => {
    const dir = writeValidRepo(makeRepoFixture('c-detect-ok'));
    writeSchool(dir, 'usts', {
      meta: { id: 'usts', name: '苏州科技大学', system: 'jwglxt' },
      config: { detect: { markers: ['usts-jwglxt'], timetableTableIds: ['kbtable-usts'] } },
    });
    const result = runChecks(dir, { systems: false, version: false });
    assert.equal(result.passed, true, errorsText(result.errors));
    assert.match(result.text, /detect 只做追加.*系统级特征不可删除/);
  });

  test('params 只允许字符串值', () => {
    const dir = writeValidRepo(makeRepoFixture('c-params'));
    writeSchool(dir, 'usts', {
      meta: { id: 'usts', name: '苏州科技大学', system: 'jwglxt' },
      config: { params: { gnmkdm: 2151 } },
    });
    const result = runChecks(dir, { systems: false, version: false });
    assert.equal(result.passed, false);
    assert.match(errorsText(result.errors), /类型应为 string/);
  });

  test('params 为字符串键值时通过', () => {
    const dir = writeValidRepo(makeRepoFixture('c-params-ok'));
    writeSchool(dir, 'usts', {
      meta: { id: 'usts', name: '苏州科技大学', system: 'jwglxt' },
      config: { params: { gnmkdm: 'N2151' } },
    });
    const result = runChecks(dir, { systems: false, version: false });
    assert.equal(result.passed, true, errorsText(result.errors));
    assert.match(result.text, /params 1 项/);
  });

  test('system 覆盖 meta.system 时给出提示（快照 index 以 school.json 的 system 为准）', () => {
    const dir = writeValidRepo(makeRepoFixture('c-override'));
    writeSchool(dir, 'usts', {
      meta: { id: 'usts', name: '苏州科技大学', system: 'urp' },
      config: { system: 'jwglxt' },
    });
    writeSnapshot(dir);
    const { snapshot } = buildSnapshot({ root: dir, generatedAt: AT });
    const entry = snapshot.index.schools.find((school) => school.id === 'usts');
    assert.equal(entry.system, 'jwglxt', '合并后 school.json 的 system 是唯一真值');
  });

  test('system 不在允许集合内时报错', () => {
    const dir = writeValidRepo(makeRepoFixture('c-system-bad'));
    writeSchool(dir, 'usts', {
      meta: { id: 'usts', name: '苏州科技大学', system: 'nosuch' },
    });
    const result = runChecks(dir, { systems: false, version: false });
    assert.equal(result.passed, false);
    assert.match(errorsText(result.errors), /不在允许的系统 id/);
  });
});

/* ------------------------------------------------------------------ */
/* 6. 快照（唯一产物 + 内嵌 index）                                      */
/* ------------------------------------------------------------------ */

describe('快照与内嵌索引', () => {
  test('快照与目录一致时通过（含内嵌 index）', () => {
    const dir = writeValidRepo(makeRepoFixture('i-ok'), { withParser: true, fixtures: { page: true, events: true } });
    writeSnapshot(dir);
    const result = runChecks(dir, { snapshot: true });
    assert.equal(result.passed, true, errorsText(result.errors));
    assert.match(result.text, /index\.schools 的学校 id 集合与目录一致（default, usts）/);
    assert.match(result.text, /index\.systems 的 detect \/ entryPath \/ hint \/ hasParser 与源文件一致/);
  });

  test('缺少快照报错（唯一生成物）', () => {
    const dir = writeValidRepo(makeRepoFixture('i-missing'));
    const result = runChecks(dir, { snapshot: true, adapters: false });
    assert.equal(result.passed, false);
    assert.match(errorsText(result.errors), /缺少 snapshot\/presets-<version>\.json/);
  });

  test('缺少某个学校 → 报 index.schools 缺少', () => {
    const dir = writeValidRepo(makeRepoFixture('i-noschool'));
    writeSnapshot(dir);
    writeSchool(dir, 'njupt', {
      meta: { id: 'njupt', name: '南京邮电大学', system: 'jwglxt' },
      periods: [{ periodNo: 1, start: '08:00', end: '08:45' }],
    });
    const result = runChecks(dir, { snapshot: true, adapters: false });
    assert.equal(result.passed, false);
    assert.match(errorsText(result.errors), /index\.schools 缺少学校 njupt/);
  });

  test('索引里多出学校（目录里没有）→ 报 index.schools 多余', () => {
    const dir = writeValidRepo(makeRepoFixture('i-extra'));
    const snapshot = writeSnapshot(dir);
    snapshot.index.schools.push({ ...snapshot.index.schools[0], id: 'ghost', name: '幽灵大学' });
    writeFileSync(join(dir, 'snapshot', 'presets-0.1.0.json'), JSON.stringify(snapshot, null, 2));
    const result = runChecks(dir, { snapshot: true, adapters: false });
    assert.equal(result.passed, false);
    assert.match(errorsText(result.errors), /index\.schools 多余学校 ghost/);
  });

  test('手改内嵌 index 里的 detect → hash 不符 + 与编译结果不一致', () => {
    const dir = writeValidRepo(makeRepoFixture('i-tamper'));
    const snapshot = writeSnapshot(dir);
    snapshot.index.systems.find((system) => system.id === 'jwglxt').detect.markers = ['hacked'];
    writeFileSync(join(dir, 'snapshot', 'presets-0.1.0.json'), JSON.stringify(snapshot, null, 2));
    const result = runChecks(dir, { snapshot: true, adapters: false });
    assert.equal(result.passed, false);
    const text = errorsText(result.errors);
    assert.match(text, /hash 与内容不一致/);
    assert.match(text, /detect 与 system\.json 编译结果不一致/);
  });

  test('手改顶层 sha256 → 报与源文件复算不一致', () => {
    const dir = writeValidRepo(makeRepoFixture('i-sha'));
    const snapshot = writeSnapshot(dir);
    snapshot.sources.timetables[0].sha256 = `sha256:${'0'.repeat(64)}`;
    writeFileSync(join(dir, 'snapshot', 'presets-0.1.0.json'), JSON.stringify(snapshot, null, 2));
    const result = runChecks(dir, { snapshot: true, adapters: false });
    assert.equal(result.passed, false);
    assert.match(errorsText(result.errors), /hash 与内容不一致/);
  });

  test('快照 version 与 version.json 不一致 → 报错', () => {
    const dir = writeValidRepo(makeRepoFixture('i-version'));
    const snapshot = writeSnapshot(dir);
    snapshot.version = '9.9.9';
    writeFileSync(join(dir, 'snapshot', 'presets-9.9.9.json'), JSON.stringify(snapshot, null, 2));
    rmSync(join(dir, 'snapshot', 'presets-0.1.0.json'));
    const result = runChecks(dir, { snapshot: true, adapters: false });
    assert.equal(result.passed, false);
    assert.match(errorsText(result.errors), /version "9\.9\.9" 与 version\.json 的 "0\.1\.0" 不一致/);
  });

  test('index._generated 必须为 true', () => {
    const dir = writeValidRepo(makeRepoFixture('i-generated'));
    const snapshot = writeSnapshot(dir);
    snapshot.index._generated = false;
    writeFileSync(join(dir, 'snapshot', 'presets-0.1.0.json'), JSON.stringify(snapshot, null, 2));
    const report = new Report();
    const schools = checkTimetables(dir, new Report());
    const systems = checkSystems(dir, new Report());
    checkSnapshot(dir, report, { schools, systems });
    assert.equal(report.passed, false);
    assert.match(errorsText(report.errors), /必须恒等于 true/);
  });

  test('presets/index.json 已取消：存在即报错', () => {
    assert.deepEqual(RETIRED_ARTIFACTS, ['presets/index.json']);
    const dir = writeValidRepo(makeRepoFixture('i-retired'));
    writeSnapshot(dir);
    writeFileSync(join(dir, 'presets', 'index.json'), '{}');
    const result = runChecks(dir, { snapshot: true, adapters: false });
    assert.equal(result.passed, false);
    assert.match(errorsText(result.errors), /presets\/index\.json 已取消/);
  });

  test('快照文件名版本可从名字推出', () => {
    assert.equal(snapshotVersionFromName('presets-0.1.0.json'), '0.1.0');
    assert.equal(snapshotVersionFromName('presets-1.2.3-rc.1.json'), '1.2.3-rc.1');
    assert.equal(snapshotVersionFromName('other.json'), undefined);
  });
});

/* ------------------------------------------------------------------ */
/* 7. 版本非法配置                                                       */
/* ------------------------------------------------------------------ */

describe('版本非法配置', () => {
  test('version 不是合法 SemVer 报错', () => {
    const dir = makeRepoFixture('v-semver');
    writeFileSync(join(dir, 'version.json'), JSON.stringify({ version: 'v1.0', schemaVersion: 1, generatedAt: AT, channel: 'stable' }));
    const result = runChecks(dir, { schools: false, systems: false, conformance: false, adapters: false });
    assert.equal(result.passed, false);
    assert.match(errorsText(result.errors), /不是合法 SemVer/);
  });

  test('schemaVersion 不是正整数报错', () => {
    const dir = makeRepoFixture('v-schema');
    writeFileSync(join(dir, 'version.json'), JSON.stringify({ version: '0.1.0', schemaVersion: 0, generatedAt: AT, channel: 'stable' }));
    const result = runChecks(dir, { schools: false, systems: false, conformance: false, adapters: false });
    assert.equal(result.passed, false);
    assert.match(errorsText(result.errors), /schemaVersion 必须是正整数/);
  });

  test('channel 非法报错', () => {
    const dir = makeRepoFixture('v-channel');
    writeFileSync(join(dir, 'version.json'), JSON.stringify({ version: '0.1.0', schemaVersion: 1, generatedAt: AT, channel: 'nightly' }));
    const result = runChecks(dir, { schools: false, systems: false, conformance: false, adapters: false });
    assert.equal(result.passed, false);
    assert.match(errorsText(result.errors), /channel 只能是 stable 或 beta/);
  });
});

/* ------------------------------------------------------------------ */
/* 8. 解析器静态安全扫描（系统级 + 学校级）                               */
/* ------------------------------------------------------------------ */

describe('解析器静态安全扫描', () => {
  function scanSource(source, { school = false } = {}) {
    const dir = writeValidRepo(makeRepoFixture('scan'), { withParser: true, fixtures: { page: true, events: true } });
    const target = school
      ? join(dir, 'presets', 'schools', 'usts', 'parse.js')
      : join(dir, 'presets', 'systems', 'jwglxt', 'parse.js');
    writeFileSync(target, source);
    const report = new Report();
    const schools = checkTimetables(dir, report);
    const systems = checkSystems(dir, report);
    checkAdapters(dir, report, systems, schools);
    return report;
  }

  test('命中 eval( 并给出行号', () => {
    const report = scanSource([
      '// 第一行注释',
      'export function parse({ html }) {',
      '  return eval("({ events: [] })");',
      '}',
    ].join('\n'));
    assert.equal(report.passed, false);
    assert.match(errorsText(report.errors), /parse\.js:3 命中禁用模式 eval\(/);
  });

  test('命中 require( 并给出行号', () => {
    const report = scanSource([
      'export function parse({ html }) {',
      '  const fs = require("node:fs");',
      '  return { events: [] };',
      '}',
    ].join('\n'));
    assert.equal(report.passed, false);
    assert.match(errorsText(report.errors), /parse\.js:2 命中禁用模式 require\(/);
  });

  test('命中 fetch( / process / while(true) / setInterval(', () => {
    const report = scanSource([
      'export function parse({ html }) {',
      '  process.env.SECRET;',
      '  fetch("https://example.com");',
      '  while (true) {}',
      '  setInterval(() => {}, 1);',
      '  return { events: [] };',
      '}',
    ].join('\n'));
    assert.equal(report.passed, false);
    const text = errorsText(report.errors);
    assert.match(text, /命中禁用模式 process/);
    assert.match(text, /命中禁用模式 fetch\(/);
    assert.match(text, /命中禁用模式 while\(true\)/);
    assert.match(text, /命中禁用模式 setInterval\(/);
  });

  test('中文注释里的禁用词不误报，但代码里的 fs/import 仍会命中', () => {
    const clean = scanSource([
      '/** 说明：本解析器禁止任何 IO / 外部请求 / 子进程操作（net、fs、fetch）。 */',
      '// fetch( 与 fs 调用一律不允许',
      'export function parse({ html }) {',
      '  return { events: [] };',
      '}',
    ].join('\n'));
    assert.equal(clean.passed, true, `注释不应误报：\n${errorsText(clean.errors)}`);

    const dirty = scanSource([
      'export function parse({ html }) {',
      '  const text = fs.readFileSync("a.txt");',
      '  return { events: [] };',
      '}',
    ].join('\n'));
    assert.equal(dirty.passed, false);
    assert.match(errorsText(dirty.errors), /命中禁用模式 fs/);
  });

  test('导出形式不符合契约时报错', () => {
    const report = scanSource([
      'export function parse(html) {',
      '  return { events: [] };',
      '}',
    ].join('\n'));
    assert.equal(report.passed, false);
    assert.match(errorsText(report.errors), /必须以 `export function parse\(\{ html, url, hints \}\) \{` 形式导出/);
  });

  test('额外导出 / CommonJS 导出时报错', () => {
    const extra = scanSource([
      'export function parse({ html }) { return { events: [] }; }',
      'export const helper = 1;',
    ].join('\n'));
    assert.equal(extra.passed, false);
    assert.match(errorsText(extra.errors), /只允许导出 parse/);

    const cjs = scanSource([
      'export function parse({ html }) { return { events: [] }; }',
      'module.exports = { parse };',
    ].join('\n'));
    assert.equal(cjs.passed, false);
    assert.match(errorsText(cjs.errors), /禁止 CommonJS 导出/);
  });

  test('学校级解析器同样被扫描（命中 eval 即失败）', () => {
    const report = scanSource([
      'export function parse({ html }) {',
      '  return eval("({ events: [] })");',
      '}',
    ].join('\n'), { school: true });
    assert.equal(report.passed, false);
    assert.match(errorsText(report.errors), /schools\/usts\/parse\.js:2 命中禁用模式 eval\(/);
  });

  test('真实仓库的 systems/jwglxt/parse.js 扫描通过', () => {
    const report = new Report();
    const schools = checkTimetables(REPO_ROOT, report);
    const systems = checkSystems(REPO_ROOT, report);
    checkAdapters(REPO_ROOT, report, systems, schools);
    assert.equal(report.passed, true, `真实解析器不应命中禁用模式：\n${errorsText(report.errors)}`);
  });
});

/* ------------------------------------------------------------------ */
/* 9. 沙箱行为                                                          */
/* ------------------------------------------------------------------ */

describe('沙箱运行器', () => {
  const REAL_PARSER = join(REPO_ROOT, 'presets', 'systems', 'jwglxt', 'parse.js');
  const REAL_PAGE = join(REPO_ROOT, 'presets', 'systems', 'jwglxt', 'fixtures', 'sample-page.html');

  test('正常解析器在受限子进程中跑通并返回事件', async () => {
    const html = readFileSync(REAL_PAGE, 'utf8');
    const result = await runAdapterSandbox({
      adapterPath: REAL_PARSER,
      input: { html, url: 'https://jwgl.usts.edu.cn/jwglxt/xskb/query', hints: {} },
    });
    assert.equal(result.ok, true, `预期成功，实际：${JSON.stringify(result.error)}`);
    assert.ok(result.events.length >= 2, `至少 2 条事件，实际 ${result.events.length}`);
    assert.equal(result.events[0].title, '高等数学');
    assert.equal(result.events[0].dayOfWeek, 2);
    assert.deepEqual(
      [result.events[0].periodStart, result.events[0].periodEnd],
      [1, 2],
      'id="1-2" 应映射为第 1-2 节（行 n → 2n-1 ~ 2n 节）',
    );
    assert.equal(result.meta.permissionFlag, '--permission');
  });

  test('越权写文件的适配器被拒绝，且以结构化错误返回（不抛异常）', async () => {
    const probe = join(REPO_ROOT, 'sandbox-escape-probe.txt');
    const result = await runAdapterSandbox({
      adapterPath: join(REPO_ROOT, 'test', 'fixtures', 'evil-adapter.js'),
      input: { html: '<html></html>', url: 'https://example.invalid/', hints: {} },
    });
    assert.equal(result.ok, false, '越权适配器必须失败');
    assert.equal(typeof result.error.code, 'string');
    assert.equal(typeof result.error.message, 'string');
    assert.notEqual(result.error.message.length, 0);
    assert.equal(result.error.code, 'SANDBOX_PERMISSION_DENIED', `实际错误：${JSON.stringify(result.error)}`);
    assert.equal(existsSync(probe), false, '越权适配器不得真的写出文件');
  });

  test('eval / new Function 被 --disallow-code-generation-from-strings 拒绝', async () => {
    const result = await runAdapterSandbox({
      adapterPath: join(REPO_ROOT, 'test', 'fixtures', 'codegen-adapter.js'),
      input: { html: '<html></html>', url: 'https://example.invalid/', hints: {} },
    });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'SANDBOX_PERMISSION_DENIED', JSON.stringify(result.error));
  });

  test('读取只读白名单之外的文件被拒绝', async () => {
    const dir = makeRepoFixture('sandbox-read');
    const systemDir = writeSystem(dir, 'jwglxt', {});
    const adapter = join(systemDir, 'parse.js');
    const outsidePath = process.platform === 'win32' ? 'C:\\Windows\\win.ini' : '/etc/hostname';
    writeFileSync(adapter, [
      "import { readFileSync } from 'node:fs';",
      'export function parse() {',
      `  readFileSync(${JSON.stringify(outsidePath)}, 'utf8');`,
      '  return { events: [] };',
      '}',
    ].join('\n'));
    const result = await runAdapterSandbox({ adapterPath: adapter, input: { html: '', url: '', hints: {} } });
    assert.equal(result.ok, false, '白名单外的读取必须失败');
    assert.equal(result.error.code, 'SANDBOX_PERMISSION_DENIED', JSON.stringify(result.error));
    assert.match(result.error.message, /ERR_ACCESS_DENIED|restricted|denied/i);
  });

  test('死循环适配器被墙钟超时终止并以结构化错误返回', async () => {
    const result = await runAdapterSandbox({
      adapterPath: join(REPO_ROOT, 'test', 'fixtures', 'hang-adapter.js'),
      input: { html: '<html></html>', url: 'https://example.invalid/', hints: {} },
      timeoutMs: 1500,
    });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'SANDBOX_TIMEOUT', JSON.stringify(result.error));
    assert.ok(result.meta.durationMs >= 1400, `耗时应接近上限，实际 ${result.meta.durationMs}ms`);
  });

  test('适配器文件不存在时返回结构化错误而非抛异常', async () => {
    const result = await runAdapterSandbox({
      adapterPath: join(REPO_ROOT, 'test', 'fixtures', 'not-exist.js'),
      input: { html: '', url: '', hints: {} },
    });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'ADAPTER_NOT_FOUND');
  });

  test('没有 parse 导出时返回 ADAPTER_NO_PARSE', async () => {
    const dir = makeRepoFixture('sandbox-noparse');
    const systemDir = writeSystem(dir, 'jwglxt', {});
    const adapter = join(systemDir, 'parse.js');
    writeFileSync(adapter, 'export function other({ html }) { return { events: [] }; }\n');
    const result = await runAdapterSandbox({ adapterPath: adapter, input: { html: '', url: '', hints: {} } });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'ADAPTER_NO_PARSE');
  });

  test('沙箱限制常量已声明（超时、堆上限、stdio、禁写、禁动态代码生成、env 白名单）', () => {
    assert.equal(SANDBOX_LIMITS.timeoutMs, 5000);
    assert.equal(SANDBOX_LIMITS.maxOldSpaceSizeMb, 64);
    assert.equal(SANDBOX_LIMITS.stdio, 'pipe');
    assert.equal(SANDBOX_LIMITS.fsWrite, false);
    assert.equal(SANDBOX_LIMITS.childProcess, false);
    assert.equal(SANDBOX_LIMITS.worker, false);
    assert.equal(SANDBOX_LIMITS.addons, false);
    assert.equal(SANDBOX_LIMITS.codeGenerationFromStrings, false);
    assert.deepEqual(SANDBOX_LIMITS.envAllowlist, ['PATH', 'SystemRoot', 'windir', 'TEMP', 'TMP', 'LANG', 'LC_ALL']);
  });
});

/* ------------------------------------------------------------------ */
/* 10. 快照：可复现 + 结构 + 哈希语义                                     */
/* ------------------------------------------------------------------ */

describe('快照与索引生成', () => {
  test('同一时间戳生成同一内容哈希（可复现）', () => {
    const first = buildSnapshot({ root: REPO_ROOT, generatedAt: AT }).snapshot;
    const second = buildSnapshot({ root: REPO_ROOT, generatedAt: AT }).snapshot;
    assert.equal(canonicalJson(first), canonicalJson(second));
    assert.equal(first.hash, second.hash);
    assert.match(first.hash, /^sha256:[0-9a-f]{64}$/);
  });

  test('旧字段结构不变，index 是新增字段', () => {
    const { snapshot } = buildSnapshot({ root: REPO_ROOT, generatedAt: AT });
    assert.deepEqual(Object.keys(snapshot), ['version', 'schemaVersion', 'generatedAt', 'sources', 'index', 'hash']);
    for (const key of ['version', 'schemaVersion', 'generatedAt', 'sources', 'hash']) {
      assert.ok(Object.keys(snapshot).includes(key), `旧字段 ${key} 必须保留`);
    }
    assert.deepEqual(Object.keys(snapshot.sources), ['timetables', 'systems', 'adapters']);
    assert.equal(snapshot.version, '0.1.0');
    assert.equal(snapshot.schemaVersion, 1);
    for (const item of snapshot.sources.timetables) {
      assert.deepEqual(Object.keys(item), ['id', 'path', 'sha256']);
    }
    for (const item of snapshot.sources.systems) {
      assert.deepEqual(Object.keys(item), ['id', 'path', 'sha256']);
    }
    assert.deepEqual(snapshot.sources.timetables.map((item) => item.id), ['default', 'usts']);
    assert.deepEqual(snapshot.sources.systems.map((item) => item.id), ['jwglxt', 'other', 'qzdatasource', 'urp']);
    assert.deepEqual(Object.keys(snapshot.sources.adapters), ['jwglxt.js']);
  });

  test('hash 覆盖范围包含 index（改 index 必然改 hash）', () => {
    const { snapshot } = buildSnapshot({ root: REPO_ROOT, generatedAt: AT });
    const { hash, ...unsigned } = snapshot;
    assert.equal(hash, sha256(canonicalJson(unsigned)));
    const tampered = { ...unsigned, index: { ...unsigned.index, version: '9.9.9' } };
    assert.notEqual(sha256(canonicalJson(tampered)), hash);
  });

  test('作息表哈希来自 school.json 里内嵌的原始文本，且 path 是历史符号路径', () => {
    const { snapshot, schools } = buildSnapshot({ root: REPO_ROOT, generatedAt: AT });
    for (const school of schools) {
      const entry = snapshot.sources.timetables.find((item) => item.id === school.doc.timetable.id);
      assert.equal(entry.path, timetableSourcePath(school.dirName));
      assert.equal(entry.path, `presets/schools/${school.dirName}/timetable.json`, '符号路径形状不变');
      const restored = extractTimetableText(readFileSync(school.fullPath, 'utf8'));
      assert.equal(entry.sha256, sha256(restored), '哈希必须来自 school.json 内嵌的 timetable 原文');
      // 还原出来的文本必须是合法 JSON，且与 school.json 里的 timetable 对象等价
      assert.deepEqual(JSON.parse(restored), school.doc.timetable);
    }
  });

  test('系统哈希等于 system.json 按旧扁平结构编译出的文本哈希', () => {
    const { snapshot } = buildSnapshot({ root: REPO_ROOT, generatedAt: AT });
    for (const item of snapshot.sources.systems) {
      const doc = JSON.parse(readFileSync(join(REPO_ROOT, 'presets', 'systems', item.id, 'system.json'), 'utf8'));
      assert.equal(item.sha256, sha256(compileSystemConfigText(doc)));
    }
  });

  test('系统编译产物保持旧扁平结构（id/name/entryPath/hint/detect）', () => {
    const doc = JSON.parse(readFileSync(join(REPO_ROOT, 'presets', 'systems', 'jwglxt', 'system.json'), 'utf8'));
    const config = compileSystemConfig(doc);
    assert.deepEqual(Object.keys(config), ['id', 'name', 'entryPath', 'hint', 'detect']);
    assert.deepEqual(Object.keys(config.detect), DETECT_KEY_ORDER);
    assert.equal(config.id, 'jwglxt');
    assert.equal(config.entryPath, '/jwglxt/xtgl/login_slogin.html');
    assert.deepEqual(config.detect.markers, ['jwglxt', 'xskb_list', 'timetable_con', 'kbgrid_table']);
    assert.equal(config.detect.timetableTableIds[0], 'kbtable');
  });

  test('适配器哈希就是 parse.js 的文件哈希，系统解析器键名保持 <系统id>.js', () => {
    const { snapshot } = buildSnapshot({ root: REPO_ROOT, generatedAt: AT });
    assert.equal(
      snapshot.sources.adapters['jwglxt.js'],
      sha256(readFileSync(join(REPO_ROOT, 'presets', 'systems', 'jwglxt', 'parse.js'), 'utf8')),
    );
  });

  test('学校解析器用 <学校id>.js 作为键名，同名系统解析器条目保持不变', () => {
    const dir = writeValidRepo(makeRepoFixture('adapter-school'), { withParser: true, fixtures: { page: true, events: true } });
    const schoolDir = join(dir, 'presets', 'schools', 'usts');
    writeFileSync(join(schoolDir, 'parse.js'), 'export function parse({ html }) { return { events: [] }; }\n');
    mkdirSync(join(schoolDir, 'fixtures'), { recursive: true });
    writeFileSync(join(schoolDir, 'fixtures', 'sample-page.html'), '<html></html>');
    writeFileSync(join(schoolDir, 'fixtures', 'expected-events.json'), JSON.stringify({
      id: 'usts-case',
      system: 'jwglxt',
      adapter: 'parse.js',
      fixtures: { page: 'sample-page.html', events: 'expected-events.json' },
      input: { url: 'https://example.edu/', hints: {} },
      expect: { minEvents: 0, events: [] },
    }, null, 2));
    const { snapshot } = buildSnapshot({ root: dir, generatedAt: AT });
    assert.deepEqual(Object.keys(snapshot.sources.adapters), ['jwglxt.js', 'usts.js']);
    assert.equal(
      snapshot.sources.adapters['usts.js'],
      sha256(readFileSync(join(schoolDir, 'parse.js'), 'utf8')),
    );
  });

  test('内容变化会改变哈希（哈希确实覆盖内容）', () => {
    const base = buildSnapshot({ root: REPO_ROOT, generatedAt: AT }).snapshot;
    const tampered = { ...base, sources: { ...base.sources } };
    tampered.sources.systems = base.sources.systems.map((item) => (
      item.id === 'urp' ? { ...item, sha256: `sha256:${'0'.repeat(64)}` } : item
    ));
    assert.notEqual(sha256(canonicalJson({ ...tampered, hash: undefined })), base.hash);
  });

  test('内嵌 index 内容可从目录复现，且只包含真实存在的路径', () => {
    const { index } = buildSnapshot({ root: REPO_ROOT, generatedAt: AT });
    assert.equal(index._generated, true);
    assert.equal(index.version, '0.1.0');
    assert.equal(index.schemaVersion, 1);
    assert.deepEqual(index.schools.map((school) => school.id), ['default', 'usts']);
    assert.deepEqual(index.systems.map((system) => system.id), ['jwglxt', 'other', 'qzdatasource', 'urp']);
    for (const school of index.schools) {
      assert.equal(existsSync(join(REPO_ROOT, school.timetablePath)), true, `${school.timetablePath} 应存在`);
      if (school.configPath !== null) {
        assert.equal(existsSync(join(REPO_ROOT, school.configPath)), true, `${school.configPath} 应存在`);
      }
    }
    const generic = index.schools.find((school) => school.id === 'default');
    assert.equal(generic.generic, true);
    assert.equal(generic.default, true);
    assert.equal(generic.system, null);
  });

  test('内嵌 index 是生成物：重跑生成结果稳定，且与 buildIndex 一致', () => {
    const first = buildSnapshot({ root: REPO_ROOT, generatedAt: AT });
    const second = buildSnapshot({ root: REPO_ROOT, generatedAt: AT });
    assert.equal(canonicalJson(first.index), canonicalJson(second.index));
    const { index } = first;
    const rebuilt = buildIndex({
      schools: first.schools,
      systems: first.systems,
      versionData: { version: index.version, schemaVersion: index.schemaVersion },
      generatedAt: AT,
    });
    assert.equal(canonicalJson(rebuilt), canonicalJson(index));
  });

  test('学校级解析器优先级高于系统级（校验器会声明这一点）', () => {
    const report = new Report();
    checkParserPriority(
      report,
      [{ doc: { id: 'jwglxt' }, parserFile: 'systems/jwglxt/parse.js' }],
      [{ dirName: 'usts', doc: { id: 'usts', system: 'jwglxt' }, parserFile: 'schools/usts/parse.js' }],
    );
    assert.equal(report.passed, true);
    assert.match(report.toText(), /schools\/usts\/parse\.js 生效，覆盖 systems\/jwglxt\/parse\.js/);
  });

  test('没有学校级解析器时回退到系统级', () => {
    const report = new Report();
    checkParserPriority(
      report,
      [{ doc: { id: 'jwglxt' }, parserFile: 'systems/jwglxt/parse.js' }],
      [{ dirName: 'usts', doc: { id: 'usts', system: 'jwglxt' } }],
    );
    assert.match(report.toText(), /没有学校级解析器，使用 systems\/jwglxt\/parse\.js/);
  });

  test('school.json 内嵌的 timetable 文本可原样还原（哈希不变的关键）', () => {
    const text = readFileSync(join(REPO_ROOT, 'presets', 'schools', 'usts', 'school.json'), 'utf8');
    const restored = extractTimetableText(text);
    assert.equal(typeof restored, 'string');
    assert.ok(restored.endsWith('\n'));
    assert.equal(restored.includes('\n    "periodNo"'), false, '还原后不应残留额外的 4 空格缩进');
    const parsed = JSON.parse(restored);
    assert.equal(parsed.id, 'usts');
    assert.equal(parsed.periods.length, 14);
  });
});

/* ------------------------------------------------------------------ */
/* 11. 仓库目录结构                                                      */
/* ------------------------------------------------------------------ */

describe('仓库目录结构', () => {
  test('旧目录与旧产物已删除（timetables / adapters / index.json / systems/*.json 散文件）', () => {
    assert.equal(existsSync(join(REPO_ROOT, 'presets', 'timetables')), false);
    assert.equal(existsSync(join(REPO_ROOT, 'presets', 'adapters')), false);
    assert.equal(existsSync(join(REPO_ROOT, 'presets', 'index.json')), false);
    assert.deepEqual(
      readdirSync(join(REPO_ROOT, 'presets', 'systems')).filter((name) => name.endsWith('.json')),
      [],
    );
    assert.deepEqual(
      readdirSync(join(REPO_ROOT, 'presets', 'schools')).filter((name) => name.endsWith('.json')),
      [],
    );
  });

  test('学校目录只有 school.json（没有 meta.json / timetable.json / config.json）', () => {
    for (const dirName of listDirs(join(REPO_ROOT, 'presets', 'schools'))) {
      const files = readdirSync(join(REPO_ROOT, 'presets', 'schools', dirName));
      assert.ok(files.includes('school.json'), `${dirName} 必须有 school.json`);
      for (const gone of ['meta.json', 'timetable.json', 'config.json']) {
        assert.equal(files.includes(gone), false, `${dirName} 不应再有 ${gone}`);
      }
    }
  });

  test('每个系统目录只有 system.json（没有 meta.json / login.json），最多一个 parse.js', () => {
    const systemsDir = join(REPO_ROOT, 'presets', 'systems');
    let withParser = 0;
    for (const id of listDirs(systemsDir)) {
      const files = readdirSync(join(systemsDir, id));
      assert.ok(files.includes('system.json'), `${id} 必须有 system.json`);
      for (const gone of ['meta.json', 'login.json']) {
        assert.equal(files.includes(gone), false, `${id} 不应再有 ${gone}`);
      }
      assert.ok(files.filter((name) => name.endsWith('.js')).length <= 1, `${id} 最多一个 .js`);
      if (!files.includes('parse.js')) {
        assert.equal(existsSync(join(systemsDir, id, 'fixtures')), false, `${id} 没有 parse.js 就不该有 fixtures/`);
      } else {
        withParser += 1;
      }
    }
    assert.ok(withParser >= 1, '真实仓库至少要有一个带 parse.js 的系统');
  });

  test('test/fixtures 只剩沙箱测试夹具（系统夹具已迁走）', () => {
    const files = readdirSync(join(REPO_ROOT, 'test', 'fixtures')).sort();
    assert.deepEqual(files, ['codegen-adapter.js', 'evil-adapter.js', 'hang-adapter.js']);
  });

  test('schema/ 只剩三个 schema（school / system / snapshot）', () => {
    const files = readdirSync(join(REPO_ROOT, 'schema')).sort();
    assert.deepEqual(files, ['school.schema.json', 'snapshot.schema.json', 'system.schema.json']);
  });
});
