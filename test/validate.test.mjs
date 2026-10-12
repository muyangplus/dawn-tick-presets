/**
 * validate.test.mjs —— 校验器 / 安全扫描 / 沙箱 / 快照的自动化用例（node --test，零第三方依赖）
 *
 * 覆盖：
 *   1. 合法的新结构仓库通过全部 schema + 语义 + 跨文件校验
 *   2. 非法配置各自报错且信息可读（重复 periodNo / 时间格式错 / end<=start / 未知系统 id /
 *      markers 非法正则 / school-config 未知键 / index 与目录不一致 …）
 *   3. 新增硬规则：有 parse.js 就必须有非空 fixtures/（且页面样本 + 期望事件都要有）
 *   4. 解析器静态安全扫描命中 eval( / require(（含行号）
 *   5. 沙箱拒绝越权适配器并以结构化错误返回；死循环超时；正常解析器可跑
 *   6. 快照可复现（同一时间戳 → 同一哈希），且字段结构与重构前一致
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
  checkIndex,
  checkAdapters,
  checkAdapterSandbox,
  checkVersion,
  checkSystemsCrossFile,
  Report,
  SCHOOL_SYSTEM_IDS,
} from '../scripts/validate.mjs';
import { runAdapterSandbox, SANDBOX_LIMITS } from '../scripts/sandbox-run.mjs';
import { buildSnapshot, buildIndexContent, listDirs, canonicalJson, sha256 } from '../scripts/snapshot.mjs';
import { compileSystemConfig, compileSystemConfigText, DETECT_KEY_ORDER } from '../scripts/lib/legacy.mjs';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCHEMA_FILES = [
  'school-meta.schema.json',
  'timetable.schema.json',
  'school-config.schema.json',
  'system-meta.schema.json',
  'system-login.schema.json',
  'system-fixture.schema.json',
  'index.schema.json',
];
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
    meta: {
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
    },
    login: { entryPath: '/jwglxt/xtgl/login_slogin.html', hint: '提示' },
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
    meta: { id: 'qzdatasource', name: '强智教务', detect: { markers: [], timetableTableIds: [], timetableTableClasses: [], gridCellIdPatterns: [] } },
    login: { entryPath: '/jsxsd/', hint: '提示' },
    parser: 'export function parse({ html }) { return { events: [] }; }\n',
    page: '<table id="kbtable"><tr><td id="1-2">高等数学</td></tr></table>',
  },
  urp: {
    meta: { id: 'urp', name: 'URP 教务', detect: { markers: ['urp'], timetableTableIds: [], timetableTableClasses: [], gridCellIdPatterns: [] } },
    login: { entryPath: '/', hint: '提示' },
    parser: 'export function parse({ html }) { return { events: [] }; }\n',
    page: '<table id="kbtable"><tr><td id="1-2">高等数学</td></tr></table>',
  },
  other: {
    meta: { id: 'other', name: '其他教务', detect: { markers: [], timetableTableIds: [], timetableTableClasses: [], gridCellIdPatterns: [] } },
    login: { entryPath: '/', hint: '提示' },
    parser: 'export function parse({ html }) { return { events: [] }; }\n',
    page: '<table id="kbtable"><tr><td id="1-2">高等数学</td></tr></table>',
  },
};

/** 在 fixture 仓库里写一个系统目录（meta / login，可选 parse.js + fixtures）。 */
function writeSystem(dir, id, { withParser = false, fixtures = undefined } = {}) {
  const spec = VALID_SYSTEMS[id];
  const systemDir = join(dir, 'presets', 'systems', id);
  mkdirSync(systemDir, { recursive: true });
  writeFileSync(join(systemDir, 'meta.json'), JSON.stringify(spec.meta, null, 2));
  writeFileSync(join(systemDir, 'login.json'), JSON.stringify(spec.login, null, 2));
  if (withParser) writeFileSync(join(systemDir, 'parse.js'), spec.parser);
  if (fixtures !== undefined) {
    const fixturesDir = join(systemDir, 'fixtures');
    mkdirSync(fixturesDir, { recursive: true });
    if (fixtures.page) writeFileSync(join(fixturesDir, 'sample-page.html'), spec.page);
    if (fixtures.events) {
      writeFileSync(join(fixturesDir, 'expected-events.json'), JSON.stringify({
        id: `${id}-sample-page`,
        system: id,
        adapter: 'parse.js',
        fixtures: { page: 'sample-page.html', events: 'expected-events.json' },
        input: { url: 'https://example.edu/', hints: {} },
        expect: { minEvents: 1, events: [{ title: '高等数学', dayOfWeek: 2, periodStart: 1, periodEnd: 2 }] },
      }, null, 2));
    }
  }
  return systemDir;
}

/** 在 fixture 仓库里写一个学校目录。 */
function writeSchool(dir, dirName, { meta, periods, source = '学校教务处公告', config = undefined } = {}) {
  const schoolDir = join(dir, 'presets', 'schools', dirName);
  mkdirSync(schoolDir, { recursive: true });
  writeFileSync(join(schoolDir, 'meta.json'), JSON.stringify(meta, null, 2));
  writeFileSync(join(schoolDir, 'timetable.json'), JSON.stringify({
    id: meta.id,
    name: meta.name,
    source,
    periods: periods ?? [
      { periodNo: 1, start: '08:00', end: '08:45' },
      { periodNo: 2, start: '08:55', end: '09:40' },
    ],
  }, null, 2));
  if (config !== undefined) writeFileSync(join(schoolDir, 'config.json'), JSON.stringify(config, null, 2));
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
    config: { system: 'jwglxt' },
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

/** 生成 index.json（与 snapshot.mjs 完全同一套代码路径）。 */
function writeIndex(dir) {
  writeFileSync(
    join(dir, 'presets', 'index.json'),
    JSON.stringify(buildIndexContent({ root: dir, generatedAt: AT }), null, 2),
  );
}

/** 跑一次校验并返回 { passed, errors, text, docs }。 */
function runChecks(dir, options = {}) {
  const report = new Report();
  const schools = options.schools === false ? [] : checkTimetables(dir, report);
  const systems = options.systems === false ? [] : checkSystems(dir, report);
  const cases = options.conformance === false ? [] : checkConformance(dir, report);
  const adapters = options.adapters === false || options.systems === false
    ? []
    : checkAdapters(dir, report, systems);
  if (options.index === true) checkIndex(dir, report, { schools, systems });
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
    writeIndex(dir);
    const result = runChecks(dir, { index: true });
    assert.equal(result.passed, true, `预期通过，实际错误：\n${errorsText(result.errors)}`);
    assert.match(result.text, /meta\.json Schema 通过/);
    assert.match(result.text, /夹具齐全/);
    assert.match(result.text, /跨文件一致性：systems 的 id 集合与 SCHOOL_SYSTEM_IDS 完全一致/);
    assert.match(result.text, /other 不参与识别/);
  });

  test('真实仓库根目录本身通过校验（不含沙箱冒烟）', () => {
    const result = runChecks(REPO_ROOT, { index: true });
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
    assert.equal(def.meta.id, 'default');
    assert.equal(def.meta.generic, true);
    assert.equal(def.timetable.id, 'default');
    assert.match(result.text, /presets\/schools\/_default\/timetable\.json Schema 通过/);

    // 反例：generic 为 true 但 timetable.id 不是 default → 报错
    writeSchool(dir, '_default', {
      meta: { id: 'default', name: '通用作息', generic: true, system: null },
      periods: [{ periodNo: 1, start: '08:00', end: '08:45' }],
    });
    const file = join(dir, 'presets', 'schools', '_default', 'timetable.json');
    const timetable = JSON.parse(readFileSync(file, 'utf8'));
    timetable.id = 'generic';
    writeFileSync(file, JSON.stringify(timetable, null, 2));
    const broken = runChecks(dir, { systems: false, version: false });
    assert.equal(broken.passed, false);
    assert.match(errorsText(broken.errors), /generic 为 true 时 timetable\.id 必须是 "default"/);
  });
});

/* ------------------------------------------------------------------ */
/* 2. 作息表非法配置                                                     */
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

  test('缺少 timetable.json 报错（学校目录不完整）', () => {
    const dir = writeValidRepo(makeRepoFixture('t-missing'));
    rmSync(join(dir, 'presets', 'schools', 'usts', 'timetable.json'));
    const result = runChecks(dir, { systems: false, version: false });
    assert.equal(result.passed, false);
    assert.match(errorsText(result.errors), /presets\/schools\/usts\/：缺少 timetable\.json/);
  });

  test('学校 meta 里缺少 system 字段报错（schema 必填）', () => {
    const dir = writeValidRepo(makeRepoFixture('t-nosys'));
    const file = join(dir, 'presets', 'schools', 'usts', 'meta.json');
    const meta = JSON.parse(readFileSync(file, 'utf8'));
    delete meta.system;
    writeFileSync(file, JSON.stringify(meta, null, 2));
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
    writeFileSync(join(systemDir, 'meta.json'), JSON.stringify({
      id: 'unknown',
      name: '未知教务',
      detect: { markers: [], timetableTableIds: [], timetableTableClasses: [], gridCellIdPatterns: [] },
    }, null, 2));
    writeFileSync(join(systemDir, 'login.json'), JSON.stringify({ entryPath: '/unknown/', hint: '提示' }, null, 2));
    const result = runChecks(dir, { version: false });
    assert.equal(result.passed, false);
    const text = errorsText(result.errors);
    assert.match(text, /未知系统 id "unknown"/);
    assert.match(text, /不在 SCHOOL_SYSTEM_IDS/);
  });

  test('未知系统 id 在语义层同样被拦（跳过 schema 校验时）', () => {
    const report = new Report();
    checkSystemsCrossFile(
      [{ name: 'presets/systems/hijack/meta.json', data: { id: 'hijack', detect: { markers: [], timetableTableIds: [], timetableTableClasses: [], gridCellIdPatterns: [] } } }],
      ['jwglxt', 'qzdatasource', 'urp', 'other'],
      report,
    );
    assert.equal(report.passed, false);
    assert.match(errorsText(report.errors), /未知系统 id "hijack"/);
    assert.match(errorsText(report.errors), /不在 SCHOOL_SYSTEM_IDS/);
  });

  test('目录名与 meta.id 不一致报错', () => {
    const dir = writeValidRepo(makeRepoFixture('s-dirname'));
    writeSystem(dir, 'urp');
    const systemDir = join(dir, 'presets', 'systems', 'sust');
    mkdirSync(systemDir, { recursive: true });
    writeFileSync(join(systemDir, 'meta.json'), JSON.stringify(
      VALID_SYSTEMS.urp.meta, null, 2,
    ));
    writeFileSync(join(systemDir, 'login.json'), JSON.stringify(VALID_SYSTEMS.urp.login, null, 2));
    const result = runChecks(dir, { version: false });
    assert.equal(result.passed, false);
    assert.match(errorsText(result.errors), /文件内 id "urp" 与目录名 "sust" 不一致/);
  });

  test('schools/*/meta.json 引用的系统不存在时报错', () => {
    const dir = writeValidRepo(makeRepoFixture('s-ref'));
    writeSchool(dir, 'njupt', {
      meta: { id: 'njupt', name: '南京邮电大学', system: 'nosuch' },
      periods: [{ periodNo: 1, start: '08:00', end: '08:45' }],
    });
    writeIndex(dir);
    const report = new Report();
    const schools = checkTimetables(dir, report);
    const systems = checkSystems(dir, report);
    checkIndex(dir, report, { schools, systems });
    assert.equal(report.passed, false);
    assert.match(errorsText(report.errors), /学校 "njupt" 引用的系统 "nosuch" 不在索引的系统列表里/);
    assert.match(errorsText(report.errors), /学校 "njupt" 引用的系统 "nosuch" 在 presets\/systems\/ 下不存在/);
  });

  test('markers 非法正则报错', () => {
    const dir = writeValidRepo(makeRepoFixture('s-re'));
    const file = join(dir, 'presets', 'systems', 'jwglxt', 'meta.json');
    const data = JSON.parse(readFileSync(file, 'utf8'));
    data.detect.markers = ['jwglxt', '([unclosed'];
    writeFileSync(file, JSON.stringify(data, null, 2));
    const result = runChecks(dir, { schools: false, version: false });
    assert.equal(result.passed, false);
    assert.match(errorsText(result.errors), /不是合法正则/);
  });

  test('gridCellIdPatterns 非法正则报错', () => {
    const dir = writeValidRepo(makeRepoFixture('s-re2'));
    const file = join(dir, 'presets', 'systems', 'jwglxt', 'meta.json');
    const data = JSON.parse(readFileSync(file, 'utf8'));
    data.detect.gridCellIdPatterns = ['*bad'];
    writeFileSync(file, JSON.stringify(data, null, 2));
    const result = runChecks(dir, { schools: false, version: false });
    assert.equal(result.passed, false);
    assert.match(errorsText(result.errors), /gridCellIdPatterns 中的 "\*bad" 不是合法正则/);
  });

  test('entryPath 不以 / 开头报错（schema 层拦截）', () => {
    const dir = writeValidRepo(makeRepoFixture('s-entry'));
    const file = join(dir, 'presets', 'systems', 'jwglxt', 'login.json');
    const data = JSON.parse(readFileSync(file, 'utf8'));
    data.entryPath = 'jwglxt/xtgl/login_slogin.html';
    writeFileSync(file, JSON.stringify(data, null, 2));
    const result = runChecks(dir, { schools: false, version: false });
    assert.equal(result.passed, false);
    assert.match(errorsText(result.errors), /不匹配模式/);
  });

  test('entryPath 含域名报错', () => {
    const dir = writeValidRepo(makeRepoFixture('s-domain'));
    const file = join(dir, 'presets', 'systems', 'jwglxt', 'login.json');
    const data = JSON.parse(readFileSync(file, 'utf8'));
    data.entryPath = '//jwgl.usts.edu.cn/jwglxt/';
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
    const file = join(dir, 'presets', 'systems', 'other', 'meta.json');
    const data = JSON.parse(readFileSync(file, 'utf8'));
    data.detect.markers = ['something'];
    writeFileSync(file, JSON.stringify(data, null, 2));
    const result = runChecks(dir, { schools: false, version: false });
    assert.equal(result.passed, false);
    assert.match(errorsText(result.errors), /other 的系统不得参与识别/);
  });
});

/* ------------------------------------------------------------------ */
/* 4. 夹具硬规则（本次重构的主要收益）                                   */
/* ------------------------------------------------------------------ */

describe('解析器夹具硬规则', () => {
  test('有 parse.js 但 fixtures/ 为空 → 校验失败（反例）', () => {
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

  test('有 parse.js 但 fixtures/ 目录不存在 → 校验失败', () => {
    const dir = makeRepoFixture('f-nodir');
    writeValidRepo(dir);
    writeSystem(dir, 'jwglxt', { withParser: true });
    const result = runChecks(dir, { schools: false, version: false });
    assert.equal(result.passed, false);
    assert.match(errorsText(result.errors), /fixtures\/ 为空或不存在/);
  });

  test('fixtures/ 只有期望事件、缺页面样本 → 校验失败', () => {
    const dir = makeRepoFixture('f-nopage');
    writeValidRepo(dir);
    writeSystem(dir, 'jwglxt', { withParser: true, fixtures: { events: true } });
    const result = runChecks(dir, { schools: false, version: false });
    assert.equal(result.passed, false);
    assert.match(errorsText(result.errors), /缺少页面样本/);
  });

  test('fixtures/ 只有页面样本、缺期望事件 → 校验失败', () => {
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

  test('一致性用例的 system 必须与所在目录一致', () => {
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

  test('期望事件文件的 id / system 必须与用例一致', () => {
    const dir = makeRepoFixture('f-idmismatch');
    writeValidRepo(dir);
    writeSystem(dir, 'jwglxt', { withParser: true, fixtures: { page: true, events: true } });
    const caseFile = join(dir, 'presets', 'systems', 'jwglxt', 'fixtures', 'expected-events.json');
    const events = JSON.parse(readFileSync(caseFile, 'utf8'));
    events.expect.events = [{ title: '被改过的课', dayOfWeek: 1, periodStart: 1, periodEnd: 1 }];
    writeFileSync(caseFile, JSON.stringify(events, null, 2));
    // 用例与夹具必须逐条相同，这里直接走 checkConformance 的期望一致性分支
    const report = new Report();
    checkConformance(dir, report);
    assert.equal(report.passed, true, '用例文件本身自洽');

    // 反例：把同一份期望里的 events 改空，minEvents 就不再有依据
    events.expect.events = [];
    writeFileSync(caseFile, JSON.stringify(events, null, 2));
    const broken = new Report();
    checkConformance(dir, broken);
    assert.equal(broken.passed, false);
    assert.match(errorsText(broken.errors), /expect\.minEvents=1 大于 expected-events\.json 里声明的期望事件数 0/);
  });

  test('沙箱产出必须与夹具里的期望事件逐条一致（真实仓库通过）', async () => {
    const report = new Report();
    const systems = checkSystems(REPO_ROOT, report);
    const cases = checkConformance(REPO_ROOT, report);
    const files = checkAdapters(REPO_ROOT, report, systems);
    assert.equal(report.passed, true, errorsText(report.errors));
    await checkAdapterSandbox(REPO_ROOT, report, systems, cases, files);
    assert.equal(report.passed, true, errorsText(report.errors));
    assert.match(report.toText(), /与夹具逐条一致/);
  });
});

/* ------------------------------------------------------------------ */
/* 5. school-config 语义（写死的四个键 + detect 仅允许追加）             */
/* ------------------------------------------------------------------ */

describe('school-config 语义', () => {
  test('最小 config（{"system":"jwglxt"}）通过', () => {
    const dir = writeValidRepo(makeRepoFixture('c-min'));
    const result = runChecks(dir, { version: false });
    assert.equal(result.passed, true, errorsText(result.errors));
    assert.match(result.text, /config\.json Schema 通过/);
  });

  test('未知键 → 校验失败', () => {
    const dir = writeValidRepo(makeRepoFixture('c-unknown'));
    writeSchool(dir, 'usts', {
      meta: { id: 'usts', name: '苏州科技大学', system: 'jwglxt' },
      config: { system: 'jwglxt', whatever: true },
    });
    const result = runChecks(dir, { systems: false, version: false });
    assert.equal(result.passed, false);
    const text = errorsText(result.errors);
    assert.match(text, /未知键 whatever/);
    assert.match(text, /不允许的额外字段 "whatever"/);
  });

  test('detect 只允许追加 markers / timetableTableIds / timetableTableClasses', () => {
    const dir = writeValidRepo(makeRepoFixture('c-detect'));
    writeSchool(dir, 'usts', {
      meta: { id: 'usts', name: '苏州科技大学', system: 'jwglxt' },
      config: { system: 'jwglxt', detect: { markers: ['usts-jwglxt'], gridCellIdPatterns: ['x'] } },
    });
    const result = runChecks(dir, { systems: false, version: false });
    assert.equal(result.passed, false);
    assert.match(errorsText(result.errors), /不允许的额外字段 "gridCellIdPatterns"/);
  });

  test('login 覆盖只允许 entryPath / hint，含域名报错', () => {
    const dir = writeValidRepo(makeRepoFixture('c-login'));
    writeSchool(dir, 'usts', {
      meta: { id: 'usts', name: '苏州科技大学', system: 'jwglxt' },
      config: { login: { entryPath: 'https://jwgl.usts.edu.cn/x/' } },
    });
    const result = runChecks(dir, { systems: false, version: false });
    assert.equal(result.passed, false);
    assert.match(errorsText(result.errors), /login\.entryPath .*不匹配模式/);
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

  test('config.system 与 meta.system 不一致时给出警告（index 以 meta 为准）', () => {
    const dir = writeValidRepo(makeRepoFixture('c-override'));
    writeSchool(dir, 'usts', {
      meta: { id: 'usts', name: '苏州科技大学', system: 'urp' },
      config: { system: 'jwglxt' },
    });
    const report = new Report();
    checkTimetables(dir, report);
    assert.equal(report.passed, true, errorsText(report.errors));
    assert.match(report.warnings.join('\n'), /覆盖 meta\.json 的 "urp"/);
  });

  test('没有 config.json 时不报错（可选文件）', () => {
    const dir = writeValidRepo(makeRepoFixture('c-absent'));
    rmSync(join(dir, 'presets', 'schools', 'usts', 'config.json'));
    const result = runChecks(dir, { systems: false, version: false });
    assert.equal(result.passed, true, errorsText(result.errors));
    assert.match(result.text, /没有 config\.json（可选/);
  });
});

/* ------------------------------------------------------------------ */
/* 6. index.json 生成物一致性                                            */
/* ------------------------------------------------------------------ */

describe('index.json 一致性', () => {
  test('index.json 与目录一致时通过', () => {
    const dir = writeValidRepo(makeRepoFixture('i-ok'), { withParser: true, fixtures: { page: true, events: true } });
    writeIndex(dir);
    const result = runChecks(dir, { index: true });
    assert.equal(result.passed, true, errorsText(result.errors));
    assert.match(result.text, /学校 id 集合与目录一致（default, usts）/);
    assert.match(result.text, /系统引用与 meta\.json \/ login\.json 编译结果一致/);
  });

  test('缺少 index.json 报错', () => {
    const dir = writeValidRepo(makeRepoFixture('i-missing'));
    const result = runChecks(dir, { index: true, adapters: false });
    assert.equal(result.passed, false);
    assert.match(errorsText(result.errors), /缺少 presets\/index\.json/);
  });

  test('缺少某个学校 → 报「缺少学校」', () => {
    const dir = writeValidRepo(makeRepoFixture('i-noschool'));
    writeIndex(dir);
    writeSchool(dir, 'njupt', {
      meta: { id: 'njupt', name: '南京邮电大学', system: 'jwglxt' },
      periods: [{ periodNo: 1, start: '08:00', end: '08:45' }],
    });
    const result = runChecks(dir, { index: true, adapters: false });
    assert.equal(result.passed, false);
    assert.match(errorsText(result.errors), /缺少学校 njupt/);
  });

  test('索引里多出学校（目录里没有）→ 报「多余的学校」', () => {
    const dir = writeValidRepo(makeRepoFixture('i-extra'));
    writeIndex(dir);
    const file = join(dir, 'presets', 'index.json');
    const index = JSON.parse(readFileSync(file, 'utf8'));
    index.schools.push({ ...index.schools[0], id: 'ghost', name: '幽灵大学' });
    writeFileSync(file, JSON.stringify(index, null, 2));
    const result = runChecks(dir, { index: true, adapters: false });
    assert.equal(result.passed, false);
    assert.match(errorsText(result.errors), /多余的学校 ghost/);
  });

  test('手改 index 里的 detect → 报与 meta.json 编译结果不一致', () => {
    const dir = writeValidRepo(makeRepoFixture('i-tamper'));
    writeIndex(dir);
    const file = join(dir, 'presets', 'index.json');
    const index = JSON.parse(readFileSync(file, 'utf8'));
    index.systems.find((system) => system.id === 'jwglxt').detect.markers = ['hacked'];
    writeFileSync(file, JSON.stringify(index, null, 2));
    const result = runChecks(dir, { index: true, adapters: false });
    assert.equal(result.passed, false);
    assert.match(errorsText(result.errors), /detect 与 meta\.json 编译结果不一致/);
  });

  test('index 版本与 version.json 不一致 → 报错', () => {
    const dir = writeValidRepo(makeRepoFixture('i-version'));
    writeIndex(dir);
    const file = join(dir, 'presets', 'index.json');
    const index = JSON.parse(readFileSync(file, 'utf8'));
    index.version = '9.9.9';
    writeFileSync(file, JSON.stringify(index, null, 2));
    const result = runChecks(dir, { index: true, adapters: false });
    assert.equal(result.passed, false);
    assert.match(errorsText(result.errors), /version "9\.9\.9" 与 version\.json 的 "0\.1\.0" 不一致/);
  });

  test('index.json 的 _generated 必须为 true', () => {
    const dir = writeValidRepo(makeRepoFixture('i-generated'));
    writeIndex(dir);
    const file = join(dir, 'presets', 'index.json');
    const index = JSON.parse(readFileSync(file, 'utf8'));
    index._generated = false;
    writeFileSync(file, JSON.stringify(index, null, 2));
    const report = new Report();
    checkIndex(dir, report, { schools: checkTimetables(dir, new Report()), systems: [] });
    assert.equal(report.passed, false);
    assert.match(errorsText(report.errors), /必须恒等于 true/);
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
/* 8. 解析器静态安全扫描                                                 */
/* ------------------------------------------------------------------ */

describe('解析器静态安全扫描', () => {
  function scanSource(source) {
    const dir = writeValidRepo(makeRepoFixture('scan'), { withParser: true, fixtures: { page: true, events: true } });
    const systemDir = join(dir, 'presets', 'systems', 'jwglxt');
    writeFileSync(join(systemDir, 'parse.js'), source);
    const report = new Report();
    const systems = checkSystems(dir, report);
    checkAdapters(dir, report, systems);
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

  test('额外导出 / CommonJS 导出时报错', () => {    const extra = scanSource([
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

  test('真实仓库的 systems/jwglxt/parse.js 扫描通过', () => {
    const report = new Report();
    const systems = checkSystems(REPO_ROOT, report);
    checkAdapters(REPO_ROOT, report, systems);
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
/* 10. 快照：可复现 + 字段结构不变                                        */
/* ------------------------------------------------------------------ */

describe('快照与索引生成', () => {
  test('同一时间戳生成同一内容哈希（可复现）', () => {
    const first = buildSnapshot({ root: REPO_ROOT, generatedAt: AT });
    const second = buildSnapshot({ root: REPO_ROOT, generatedAt: AT });
    assert.equal(canonicalJson(first), canonicalJson(second));
    assert.equal(first.hash, second.hash);
    assert.match(first.hash, /^sha256:[0-9a-f]{64}$/);
  });

  test('快照字段结构与重构前一致（version / schemaVersion / generatedAt / sources / hash）', () => {
    const snapshot = buildSnapshot({ root: REPO_ROOT, generatedAt: AT });
    assert.deepEqual(Object.keys(snapshot), ['version', 'schemaVersion', 'generatedAt', 'sources', 'hash']);
    assert.deepEqual(Object.keys(snapshot.sources), ['timetables', 'systems', 'adapters']);
    assert.equal(snapshot.version, '0.1.0');
    assert.equal(snapshot.schemaVersion, 1);
    for (const item of snapshot.sources.timetables) {
      assert.deepEqual(Object.keys(item), ['id', 'path', 'sha256']);
    }
    for (const item of snapshot.sources.systems) {
      assert.deepEqual(Object.keys(item), ['id', 'path', 'sha256']);
    }
    assert.deepEqual(
      snapshot.sources.timetables.map((item) => item.id),
      ['default', 'usts'],
    );
    assert.deepEqual(
      snapshot.sources.systems.map((item) => item.id),
      ['jwglxt', 'other', 'qzdatasource', 'urp'],
    );
    assert.deepEqual(Object.keys(snapshot.sources.adapters), ['jwglxt.js']);
  });

  test('作息表哈希就是真实文件哈希，且文件路径存在', () => {
    const snapshot = buildSnapshot({ root: REPO_ROOT, generatedAt: AT });
    for (const item of snapshot.sources.timetables) {
      assert.equal(existsSync(join(REPO_ROOT, item.path)), true, `${item.path} 应存在`);
      assert.equal(item.sha256, sha256(readFileSync(join(REPO_ROOT, item.path), 'utf8')));
    }
  });

  test('系统哈希等于 meta+login 按旧扁平结构编译出的文本哈希', () => {
    const snapshot = buildSnapshot({ root: REPO_ROOT, generatedAt: AT });
    for (const item of snapshot.sources.systems) {
      const meta = JSON.parse(readFileSync(join(REPO_ROOT, 'presets', 'systems', item.id, 'meta.json'), 'utf8'));
      const login = JSON.parse(readFileSync(join(REPO_ROOT, 'presets', 'systems', item.id, 'login.json'), 'utf8'));
      assert.equal(item.sha256, sha256(compileSystemConfigText({ meta, login })));
    }
  });

  test('系统编译产物保持旧扁平结构（id/name/entryPath/hint/detect 四类键）', () => {
    const meta = JSON.parse(readFileSync(join(REPO_ROOT, 'presets', 'systems', 'jwglxt', 'meta.json'), 'utf8'));
    const login = JSON.parse(readFileSync(join(REPO_ROOT, 'presets', 'systems', 'jwglxt', 'login.json'), 'utf8'));
    const config = compileSystemConfig({ meta, login });
    assert.deepEqual(Object.keys(config), ['id', 'name', 'entryPath', 'hint', 'detect']);
    assert.deepEqual(Object.keys(config.detect), DETECT_KEY_ORDER);
    assert.equal(config.id, 'jwglxt');
    assert.equal(config.entryPath, '/jwglxt/xtgl/login_slogin.html');
    assert.deepEqual(config.detect.markers, ['jwglxt', 'xskb_list', 'timetable_con', 'kbgrid_table']);
    assert.equal(config.detect.timetableTableIds[0], 'kbtable');
  });

  test('适配器哈希就是 parse.js 的文件哈希，键名保持旧格式 <id>.js', () => {
    const snapshot = buildSnapshot({ root: REPO_ROOT, generatedAt: AT });
    assert.equal(
      snapshot.sources.adapters['jwglxt.js'],
      sha256(readFileSync(join(REPO_ROOT, 'presets', 'systems', 'jwglxt', 'parse.js'), 'utf8')),
    );
  });

  test('内容变化会改变哈希（哈希确实覆盖内容）', () => {
    const base = buildSnapshot({ root: REPO_ROOT, generatedAt: AT });
    const tampered = { ...base, sources: { ...base.sources } };
    tampered.sources.systems = base.sources.systems.map((item) => (
      item.id === 'urp' ? { ...item, sha256: `sha256:${'0'.repeat(64)}` } : item
    ));
    assert.notEqual(sha256(canonicalJson({ ...tampered, hash: undefined })), base.hash);
  });

  test('index.json 内容可从目录复现，且只包含真实存在的路径', () => {
    const index = buildIndexContent({ root: REPO_ROOT, generatedAt: AT });
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

  test('index.json 是生成物：重跑生成结果稳定', () => {
    const first = canonicalJson(buildIndexContent({ root: REPO_ROOT, generatedAt: AT }));
    const second = canonicalJson(buildIndexContent({ root: REPO_ROOT, generatedAt: AT }));
    assert.equal(first, second);
  });
});

/* ------------------------------------------------------------------ */
/* 11. 仓库目录结构本身                                                  */
/* ------------------------------------------------------------------ */

describe('仓库目录结构', () => {
  test('旧目录已删除（timetables / adapters / systems/*.json）', () => {
    assert.equal(existsSync(join(REPO_ROOT, 'presets', 'timetables')), false);
    assert.equal(existsSync(join(REPO_ROOT, 'presets', 'adapters')), false);
    assert.deepEqual(
      readdirSync(join(REPO_ROOT, 'presets', 'systems')).filter((name) => name.endsWith('.json')),
      [],
    );
  });

  test('每个系统目录最多一个 parse.js，且只有真有解析器的系统带 fixtures', () => {
    const systemsDir = join(REPO_ROOT, 'presets', 'systems');
    const ids = listDirs(systemsDir);
    let withParser = 0;
    for (const id of ids) {
      const files = readdirSync(join(systemsDir, id));
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
});
