/**
 * validate.test.mjs —— 校验器 / 安全扫描 / 沙箱的自动化用例（node --test，零第三方依赖）
 *
 * 覆盖：
 *   1. 合法配置通过校验
 *   2. 非法配置各自报错且信息可读（重复 periodNo / 时间格式错 / end<=start / 未知系统 id / markers 非法正则）
 *   3. 适配器静态安全扫描命中 eval( / require(（含行号）
 *   4. 沙箱拒绝越权适配器并以结构化错误返回；死循环超时；正常适配器可跑
 *   5. 快照可复现（同一时间戳 → 同一哈希）
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, cpSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  checkTimetables,
  checkSystems,
  checkAdapters,
  checkVersion,
  Report,
  SCHOOL_SYSTEM_IDS,
  checkSystemsCrossFile,
} from '../scripts/validate.mjs';
import { runAdapterSandbox, SANDBOX_LIMITS } from '../scripts/sandbox-run.mjs';
import { buildSnapshot, canonicalJson, sha256 } from '../scripts/snapshot.mjs';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
let TMP_ROOT;

/** 建一个最小仓库副本，只复制 schema 骨架，其余由用例自己写入。 */
function makeRepoFixture(label) {
  const dir = mkdtempSync(join(TMP_ROOT, `${label}-`));
  mkdirSync(join(dir, 'schema'), { recursive: true });
  for (const name of ['timetables.schema.json', 'systems.schema.json', 'conformance.schema.json']) {
    cpSync(join(REPO_ROOT, 'schema', name), join(dir, 'schema', name));
  }
  mkdirSync(join(dir, 'presets', 'timetables'), { recursive: true });
  mkdirSync(join(dir, 'presets', 'systems'), { recursive: true });
  mkdirSync(join(dir, 'presets', 'adapters'), { recursive: true });
  writeFileSync(join(dir, 'version.json'), JSON.stringify({ version: '1.0.0', schemaVersion: 1, generatedAt: '2026-01-01T00:00:00.000Z', channel: 'stable' }, null, 2));
  return dir;
}

/** 一套合法数据（uwrite 到 fixture 目录）。 */
function writeValidRepo(dir) {
  writeFileSync(join(dir, 'presets', 'timetables', 'usts.json'), JSON.stringify({
    id: 'usts',
    name: '苏州科技大学',
    source: '学校教务处公告（用户提供截图）',
    periods: [
      { periodNo: 1, start: '08:00', end: '08:45' },
      { periodNo: 2, start: '08:55', end: '09:40' },
    ],
  }, null, 2));
  writeFileSync(join(dir, 'presets', 'timetables', 'default.json'), JSON.stringify({
    id: 'default',
    name: '通用作息',
    periods: [{ periodNo: 1, start: '08:00', end: '08:45' }],
  }, null, 2));
  const systems = [
    { id: 'jwglxt', name: '正方教务', entryPath: '/jwglxt/xtgl/login_slogin.html', hint: '提示', detect: { markers: ['jwglxt'], timetableTableIds: ['kbtable'], timetableTableClasses: ['kb'], gridCellIdPatterns: ['\\d{1,2}[-_]\\d{1,2}'] } },
    { id: 'qzdatasource', name: '强智教务', entryPath: '/jsxsd/', hint: '提示', detect: { markers: [], timetableTableIds: [], timetableTableClasses: [], gridCellIdPatterns: [] } },
    { id: 'urp', name: 'URP 教务', entryPath: '/', hint: '提示', detect: { markers: ['urp'], timetableTableIds: [], timetableTableClasses: [], gridCellIdPatterns: [] } },
    { id: 'other', name: '其他教务', entryPath: '/', hint: '提示', detect: { markers: [], timetableTableIds: [], timetableTableClasses: [], gridCellIdPatterns: [] } },
  ];
  for (const system of systems) {
    writeFileSync(join(dir, 'presets', 'systems', `${system.id}.json`), JSON.stringify(system, null, 2));
  }
  return dir;
}

/** 跑一次校验并返回 { passed, errors, text }。 */
function runChecks(dir, { timetables = true, systems = true, version = true } = {}) {
  const report = new Report();
  if (timetables) checkTimetables(dir, report);
  if (systems) checkSystems(dir, report);
  if (version) checkVersion(dir, report);
  return { passed: report.passed, errors: report.errors, text: report.toText() };
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
  test('完整的合法仓库通过全部 schema + 语义 + 跨文件校验', () => {
    const dir = writeValidRepo(makeRepoFixture('valid'));
    const result = runChecks(dir);
    assert.equal(result.passed, true, `预期通过，实际错误：\n${errorsText(result.errors)}`);
    assert.match(result.text, /id 与文件名一致/);
    assert.match(result.text, /跨文件一致性：presets\/systems 的 id 集合与 SCHOOL_SYSTEM_IDS 完全一致/);
    assert.match(result.text, /other 不参与识别/);
  });

  test('真实仓库根目录本身通过校验（不含沙箱冒烟）', () => {
    const report = new Report();
    checkTimetables(REPO_ROOT, report);
    checkSystems(REPO_ROOT, report);
    checkAdapters(REPO_ROOT, report);
    checkVersion(REPO_ROOT, report);
    assert.equal(report.passed, true, `真实仓库应通过：\n${errorsText(report.errors)}`);
  });

  test('SCHOOL_SYSTEM_IDS 与主项目约定一致', () => {
    assert.deepEqual(SCHOOL_SYSTEM_IDS, ['jwglxt', 'qzdatasource', 'urp', 'other']);
  });
});

/* ------------------------------------------------------------------ */
/* 2. 非法配置各自报错                                                   */
/* ------------------------------------------------------------------ */

describe('作息表非法配置', () => {
  test('重复 periodNo 报错', () => {
    const dir = writeValidRepo(makeRepoFixture('t-dup'));
    writeFileSync(join(dir, 'presets', 'timetables', 'usts.json'), JSON.stringify({
      id: 'usts',
      name: '苏州科技大学',
      periods: [
        { periodNo: 1, start: '08:00', end: '08:45' },
        { periodNo: 1, start: '08:55', end: '09:40' },
      ],
    }, null, 2));
    const result = runChecks(dir);
    assert.equal(result.passed, false);
    assert.match(errorsText(result.errors), /periodNo 重复/);
  });

  test('时间格式错误（8:00 缺少前导零）报错', () => {
    const dir = writeValidRepo(makeRepoFixture('t-fmt'));
    writeFileSync(join(dir, 'presets', 'timetables', 'usts.json'), JSON.stringify({
      id: 'usts',
      name: '苏州科技大学',
      periods: [
        { periodNo: 1, start: '8:00', end: '08:45' },
        { periodNo: 2, start: '08:55', end: '09:40' },
      ],
    }, null, 2));
    const result = runChecks(dir);
    assert.equal(result.passed, false);
    assert.match(errorsText(result.errors), /Schema/);
    assert.match(errorsText(result.errors), /不匹配模式|时间格式非法/);
  });

  test('end <= start 报错', () => {
    const dir = writeValidRepo(makeRepoFixture('t-end'));
    writeFileSync(join(dir, 'presets', 'timetables', 'usts.json'), JSON.stringify({
      id: 'usts',
      name: '苏州科技大学',
      periods: [{ periodNo: 1, start: '09:00', end: '08:45' }],
    }, null, 2));
    const result = runChecks(dir);
    assert.equal(result.passed, false);
    assert.match(errorsText(result.errors), /end\(08:45\) 必须晚于 start\(09:00\)/);
  });

  test('相邻节次重叠报错', () => {
    const dir = writeValidRepo(makeRepoFixture('t-overlap'));
    writeFileSync(join(dir, 'presets', 'timetables', 'usts.json'), JSON.stringify({
      id: 'usts',
      name: '苏州科技大学',
      periods: [
        { periodNo: 1, start: '08:00', end: '08:50' },
        { periodNo: 2, start: '08:45', end: '09:30' },
      ],
    }, null, 2));
    const result = runChecks(dir);
    assert.equal(result.passed, false);
    assert.match(errorsText(result.errors), /时间重叠/);
  });

  test('文件内 id 与文件名不一致报错', () => {
    const dir = writeValidRepo(makeRepoFixture('t-name'));
    writeFileSync(join(dir, 'presets', 'timetables', 'usts.json'), JSON.stringify({
      id: 'sust',
      name: '苏州科技大学',
      periods: [{ periodNo: 1, start: '08:00', end: '08:45' }],
    }, null, 2));
    const result = runChecks(dir);
    assert.equal(result.passed, false);
    assert.match(errorsText(result.errors), /文件内 id "sust" 与文件名 "usts" 不一致/);
  });
});

describe('教务系统非法配置', () => {
  test('未知系统 id 报错（schema enum 兜底）', () => {
    const dir = writeValidRepo(makeRepoFixture('s-id'));
    writeFileSync(join(dir, 'presets', 'systems', 'unknown.json'), JSON.stringify({
      id: 'unknown',
      name: '未知教务',
      entryPath: '/unknown/',
      hint: '提示',
      detect: { markers: [], timetableTableIds: [], timetableTableClasses: [], gridCellIdPatterns: [] },
    }, null, 2));
    const result = runChecks(dir);
    assert.equal(result.passed, false);
    const text = errorsText(result.errors);
    assert.match(text, /unknown\.json Schema：id 取值必须是/);
    assert.match(text, /实际是 "unknown"/);
    assert.match(text, /存在 SCHOOL_SYSTEM_IDS 之外的系统/);
  });

  test('未知系统 id 在语义层同样被拦（跳过 schema 校验时）', () => {
    const report = new Report();
    checkSystemsCrossFile(
      [{ name: 'presets/systems/hijack.json', data: { id: 'hijack', entryPath: '/x/', detect: { markers: [], timetableTableIds: [], timetableTableClasses: [], gridCellIdPatterns: [] } } }],
      ['jwglxt', 'qzdatasource', 'urp', 'other'],
      report,
    );
    assert.equal(report.passed, false);
    assert.match(errorsText(report.errors), /未知系统 id "hijack"/);
    assert.match(errorsText(report.errors), /不在 SCHOOL_SYSTEM_IDS/);
  });

  test('markers 非法正则报错', () => {
    const dir = writeValidRepo(makeRepoFixture('s-re'));
    const file = join(dir, 'presets', 'systems', 'jwglxt.json');
    const data = JSON.parse(readFileSync(file, 'utf8'));
    data.detect.markers = ['jwglxt', '([unclosed'];
    writeFileSync(file, JSON.stringify(data, null, 2));
    const result = runChecks(dir);
    assert.equal(result.passed, false);
    assert.match(errorsText(result.errors), /不是合法正则/);
  });

  test('gridCellIdPatterns 非法正则报错', () => {
    const dir = writeValidRepo(makeRepoFixture('s-re2'));
    const file = join(dir, 'presets', 'systems', 'jwglxt.json');
    const data = JSON.parse(readFileSync(file, 'utf8'));
    data.detect.gridCellIdPatterns = ['*bad'];
    writeFileSync(file, JSON.stringify(data, null, 2));
    const result = runChecks(dir);
    assert.equal(result.passed, false);
    assert.match(errorsText(result.errors), /gridCellIdPatterns 中的 "\*bad" 不是合法正则/);
  });

  test('entryPath 不以 / 开头报错（schema 层拦截）', () => {
    const dir = writeValidRepo(makeRepoFixture('s-entry'));
    const file = join(dir, 'presets', 'systems', 'jwglxt.json');
    const data = JSON.parse(readFileSync(file, 'utf8'));
    data.entryPath = 'jwglxt/xtgl/login_slogin.html';
    writeFileSync(file, JSON.stringify(data, null, 2));
    const result = runChecks(dir);
    assert.equal(result.passed, false);
    assert.match(errorsText(result.errors), /不匹配模式/);
  });

  test('缺少某个系统时报跨文件一致性错误', () => {
    const dir = writeValidRepo(makeRepoFixture('s-missing'));
    rmSync(join(dir, 'presets', 'systems', 'urp.json'));
    const result = runChecks(dir);
    assert.equal(result.passed, false);
    assert.match(errorsText(result.errors), /缺少系统配置 urp/);
  });

  test('other 参与识别时报错', () => {
    const dir = writeValidRepo(makeRepoFixture('s-other'));
    const file = join(dir, 'presets', 'systems', 'other.json');
    const data = JSON.parse(readFileSync(file, 'utf8'));
    data.detect.markers = ['something'];
    writeFileSync(file, JSON.stringify(data, null, 2));
    const result = runChecks(dir);
    assert.equal(result.passed, false);
    assert.match(errorsText(result.errors), /other 的系统不得参与识别/);
  });
});

describe('版本非法配置', () => {
  test('version 不是合法 SemVer 报错', () => {
    const dir = makeRepoFixture('v-semver');
    writeFileSync(join(dir, 'version.json'), JSON.stringify({ version: 'v1.0', schemaVersion: 1, generatedAt: '2026-01-01T00:00:00.000Z', channel: 'stable' }));
    const result = runChecks(dir, { timetables: false, systems: false });
    assert.equal(result.passed, false);
    assert.match(errorsText(result.errors), /不是合法 SemVer/);
  });

  test('schemaVersion 不是正整数报错', () => {
    const dir = makeRepoFixture('v-schema');
    writeFileSync(join(dir, 'version.json'), JSON.stringify({ version: '1.0.0', schemaVersion: 0, generatedAt: '2026-01-01T00:00:00.000Z', channel: 'stable' }));
    const result = runChecks(dir, { timetables: false, systems: false });
    assert.equal(result.passed, false);
    assert.match(errorsText(result.errors), /schemaVersion 必须是正整数/);
  });
});

/* ------------------------------------------------------------------ */
/* 3. 适配器静态安全扫描                                                 */
/* ------------------------------------------------------------------ */

describe('适配器静态安全扫描', () => {
  function scanSource(source) {
    const dir = makeRepoFixture('scan');
    writeFileSync(join(dir, 'presets', 'adapters', 'candidate.js'), source);
    const report = new Report();
    checkAdapters(dir, report);
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
    assert.match(errorsText(report.errors), /candidate\.js:3 命中禁用模式 eval\(/);
  });

  test('命中 require( 并给出行号', () => {
    const report = scanSource([
      'export function parse({ html }) {',
      '  const fs = require("node:fs");',
      '  return { events: [] };',
      '}',
    ].join('\n'));
    assert.equal(report.passed, false);
    assert.match(errorsText(report.errors), /candidate\.js:2 命中禁用模式 require\(/);
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
      '/** 说明：本适配器禁止任何 IO / 网络 / 子进程操作。 */',
      '// 网络请求一律不允许',
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

  test('真实仓库的 jwglxt.js 适配器扫描通过', () => {
    const report = new Report();
    checkAdapters(REPO_ROOT, report);
    assert.equal(report.passed, true, `真实适配器不应命中禁用模式：\n${errorsText(report.errors)}`);
  });
});

/* ------------------------------------------------------------------ */
/* 4. 沙箱行为                                                          */
/* ------------------------------------------------------------------ */

describe('沙箱运行器', () => {
  test('正常适配器在受限子进程中跑通并返回事件', async () => {
    const html = readFileSync(join(REPO_ROOT, 'test', 'fixtures', 'jwglxt-page.html'), 'utf8');
    const result = await runAdapterSandbox({
      adapterPath: join(REPO_ROOT, 'presets', 'adapters', 'jwglxt.js'),
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

  test('死循环适配器被墙钟超时终止并以结构化错误返回', async () => {
    const result = await runAdapterSandbox({
      adapterPath: join(REPO_ROOT, 'test', 'fixtures', 'hang-adapter.js'),
      input: { html: '<html></html>', url: 'https://example.invalid/', hints: {} },
      timeoutMs: 1500, // 测试里收紧，避免拖慢 CI
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
    const adapter = join(dir, 'presets', 'adapters', 'noparse.js');
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
/* 5. 快照可复现性                                                       */
/* ------------------------------------------------------------------ */

describe('快照', () => {
  test('同一时间戳生成同一内容哈希（可复现）', () => {
    const at = '2026-01-01T00:00:00.000Z';
    const first = buildSnapshot({ root: REPO_ROOT, generatedAt: at });
    const second = buildSnapshot({ root: REPO_ROOT, generatedAt: at });
    assert.equal(canonicalJson(first), canonicalJson(second));
    assert.equal(first.hash, second.hash);
    assert.match(first.hash, /^sha256:[0-9a-f]{64}$/);
  });

  test('快照包含全部来源与哈希，且解析出的文件真实存在', () => {
    const snapshot = buildSnapshot({ root: REPO_ROOT, generatedAt: '2026-01-01T00:00:00.000Z' });
    assert.equal(snapshot.version, '1.0.0');
    assert.equal(snapshot.schemaVersion, 1);
    const timetableIds = snapshot.sources.timetables.map((item) => item.id);
    assert.deepEqual(timetableIds, ['default', 'usts']);
    assert.deepEqual(snapshot.sources.systems.map((item) => item.id), ['jwglxt', 'other', 'qzdatasource', 'urp']);
    assert.ok(Object.keys(snapshot.sources.adapters).includes('jwglxt.js'));
    for (const item of [...snapshot.sources.timetables, ...snapshot.sources.systems]) {
      assert.equal(existsSync(join(REPO_ROOT, item.path)), true, `${item.path} 应存在`);
      assert.equal(item.sha256, sha256(readFileSync(join(REPO_ROOT, item.path), 'utf8')));
    }
  });

  test('内容变化会改变哈希（哈希确实覆盖内容）', () => {
    const base = buildSnapshot({ root: REPO_ROOT, generatedAt: '2026-01-01T00:00:00.000Z' });
    const tampered = { ...base, sources: { ...base.sources } };
    tampered.sources.systems = base.sources.systems.map((item) => (
      item.id === 'urp' ? { ...item, sha256: 'sha256:0000000000000000000000000000000000000000000000000000000000000000' } : item
    ));
    assert.notEqual(sha256(canonicalJson({ ...tampered, hash: undefined })), base.hash);
  });
});
