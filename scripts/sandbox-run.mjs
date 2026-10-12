#!/usr/bin/env node
/**
 * sandbox-run.mjs —— 受沙箱约束的适配器运行器
 *
 * 双角色文件：
 *   1) 父进程（默认）：用 node:child_process 起一个「受限子进程」跑适配器。
 *      受限手段（Node 权限模型 + 资源上限 + 代码生成开关）：
 *        - node --permission            （Node 24 的权限模型；旧版为 --experimental-permission）
 *        - --allow-fs-read=<限定目录>    （只读白名单，只放开适配器所在目录）
 *        - 不传 --allow-fs-write        → 文件写入被拒
 *        - 不传 --allow-child-process   → 起子进程被拒
 *        - 不传 --allow-worker          → worker_threads 被拒
 *        - 不传 --allow-addons          → 原生插件被拒
 *        - --disallow-code-generation-from-strings → eval / new Function 被拒
 *        - --max-old-space-size=64      → 堆内存上限 64MB
 *        - execFile 的 timeout: 5000    → 墙钟超时 5s
 *        - stdio: 'pipe'                → 只通过管道传 JSON
 *        - env 白名单                    → 不泄漏宿主环境变量
 *
 *   2) 子进程（--sandbox-child）：读 stdin 的 { html, url, hints }，动态 import 适配器，
 *      调用 parse()，把结果写成 stdout 上的 JSON。任何异常都转成 { ok:false, error }，
 *      不向父进程逃逸。
 *
 * 约束的施加位置：Node 权限模型、资源上限参数、代码生成开关，以及 stdio 上的 JSON 交换。
 * 威胁模型与拦截结果见 sandbox/README.md。
 */

import { execFile, execFileSync } from 'node:child_process';
import { existsSync, statSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 沙箱硬限制（也会写进 README 与校验报告）。 */
export const SANDBOX_LIMITS = {
  timeoutMs: 5000,
  maxOldSpaceSizeMb: 64,
  stdio: 'pipe',
  fsWrite: false,
  childProcess: false,
  worker: false,
  addons: false,
  codeGenerationFromStrings: false,
  envAllowlist: ['PATH', 'SystemRoot', 'windir', 'TEMP', 'TMP', 'LANG', 'LC_ALL'],
};

/**
 * 组装权限模型参数。
 * Node 24 用 --permission；早期实验版本用 --experimental-permission。
 */
export function buildPermissionFlags({ permissionFlag = '--permission', readAllow = [] } = {}) {
  const flags = [permissionFlag, '--disallow-code-generation-from-strings'];
  for (const entry of readAllow) flags.push(`--allow-fs-read=${entry}`);
  return flags;
}

/** 探测当前 node 支持哪种权限模型参数名，两种都试。 */
export function detectPermissionFlag() {
  const candidates = [
    { flag: '--permission', label: '--permission（Node 23+ 稳定名）' },
    { flag: '--experimental-permission', label: '--experimental-permission（Node 20-22 实验名）' },
  ];
  for (const candidate of candidates) {
    try {
      execFileSync(process.execPath, [candidate.flag, '-e', '0'], { stdio: 'pipe', timeout: 15000 });
      return candidate;
    } catch {
      // 试下一个
    }
  }
  return { flag: '--permission', label: '--permission（探测失败，回退默认值）' };
}

function childEnv() {
  const env = {};
  for (const key of SANDBOX_LIMITS.envAllowlist) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

function nowMs() {
  return Number(process.hrtime.bigint() / 1000000n);
}

/**
 * 在受限子进程中运行一个适配器。
 * @param {{ adapterPath: string, input?: object, expectedMinEvents?: number, timeoutMs?: number, permissionFlag?: string }} options
 * @returns {Promise<{ ok: boolean, events?: object[], error?: object, meta: object }>}
 */
export async function runAdapterSandbox(options) {
  const {
    adapterPath,
    input = { html: '', url: '', hints: {} },
    timeoutMs = SANDBOX_LIMITS.timeoutMs,
    permissionFlag = '--permission',
  } = options;

  const absoluteAdapter = resolve(adapterPath);
  const startedAt = nowMs();
  const meta = {
    adapterPath: absoluteAdapter,
    permissionFlag,
    timeoutMs,
    maxOldSpaceSizeMb: SANDBOX_LIMITS.maxOldSpaceSizeMb,
    durationMs: 0,
  };

  if (!existsSync(absoluteAdapter) || !statSync(absoluteAdapter).isFile()) {
    meta.durationMs = nowMs() - startedAt;
    return {
      ok: false,
      error: { code: 'ADAPTER_NOT_FOUND', message: `适配器文件不存在：${absoluteAdapter}`, stage: 'parent' },
      meta,
    };
  }

  const allowRead = [dirname(absoluteAdapter)];
  const args = [
    ...buildPermissionFlags({ permissionFlag, readAllow: allowRead }),
    `--max-old-space-size=${SANDBOX_LIMITS.maxOldSpaceSizeMb}`,
    fileURLToPath(import.meta.url),
    '--sandbox-child',
    absoluteAdapter,
  ];

  const payload = JSON.stringify({
    html: String(input.html ?? ''),
    url: String(input.url ?? ''),
    hints: input.hints ?? {},
  });

  const result = await new Promise((resolvePromise) => {
    const child = execFile(
      process.execPath,
      args,
      {
        timeout: timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: childEnv(),
        windowsHide: true,
        cwd: dirname(absoluteAdapter),
      },
      (error, stdout, stderr) => {
        resolvePromise({
          error,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
          killed: error?.killed === true,
          signal: error?.signal ?? null,
          code: error?.code,
        });
      },
    );
    child.stdin.on('error', () => {}); // 子进程提前退出时忽略 EPIPE
    child.stdin.end(payload);
  });

  meta.durationMs = nowMs() - startedAt;

  const timedOut = result.killed === true
    || result.signal === 'SIGTERM'
    || result.code === 'ETIMEDOUT';
  if (timedOut) {
    return {
      ok: false,
      error: { code: 'SANDBOX_TIMEOUT', message: `适配器超过 ${timeoutMs}ms 未返回，已终止`, stage: 'parent' },
      meta,
    };
  }

  const stdout = result.stdout.trim();
  if (stdout === '') {
    const detail = result.stderr.trim().split(/\r?\n/).slice(-12).join('\n');
    return {
      ok: false,
      error: {
        code: result.code === 134 || /heap out of memory/i.test(result.stderr)
          ? 'SANDBOX_OOM'
          : 'SANDBOX_NO_OUTPUT',
        message: `受限子进程没有输出合法结果（退出码 ${result.code ?? 'null'}）`,
        detail,
        stage: 'parent',
      },
      meta,
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(stdout.split(/\r?\n/).filter(Boolean).pop());
  } catch {
    return {
      ok: false,
      error: { code: 'SANDBOX_BAD_OUTPUT', message: '受限子进程输出不是合法 JSON', detail: stdout.slice(0, 500), stage: 'parent' },
      meta,
    };
  }

  if (parsed.ok === true) {
    return { ok: true, events: Array.isArray(parsed.events) ? parsed.events : [], meta };
  }
  return { ok: false, error: parsed.error ?? { code: 'SANDBOX_FAILED', message: '适配器返回 ok:false' }, meta };
}

/* ------------------------------------------------------------------ */
/* 子进程侧：--sandbox-child <adapterPath>                              */
/* ------------------------------------------------------------------ */

function writeResult(result) {
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

/** 粗粒度校验返回的事件结构。 */
function checkEventsShape(events) {
  if (!Array.isArray(events)) {
    return { code: 'ADAPTER_BAD_RESULT', message: 'parse() 必须返回 { events: [...] }，实际 events 不是数组' };
  }
  for (const [index, event] of events.entries()) {
    if (event === null || typeof event !== 'object') {
      return { code: 'ADAPTER_BAD_EVENT', message: `events[${index}] 不是对象` };
    }
    for (const key of ['title', 'dayOfWeek', 'periodStart', 'periodEnd']) {
      if (event[key] === undefined) {
        return { code: 'ADAPTER_BAD_EVENT', message: `events[${index}] 缺少字段 ${key}` };
      }
    }
  }
  return undefined;
}

async function sandboxChildMain() {
  const adapterPath = process.argv[3];
  if (adapterPath === undefined) {
    writeResult({ ok: false, error: { code: 'SANDBOX_BAD_ARGS', message: '缺少适配器路径参数', stage: 'child' } });
    return;
  }

  let raw;
  try {
    raw = await readStdin();
  } catch (error) {
    writeResult({
      ok: false,
      error: { code: 'SANDBOX_STDIN_FAILED', message: `读取 stdin 失败：${error?.message}`, stage: 'child' },
    });
    return;
  }

  let input;
  try {
    input = JSON.parse(raw === '' ? '{}' : raw);
  } catch (error) {
    writeResult({
      ok: false,
      error: { code: 'SANDBOX_BAD_INPUT', message: `stdin 不是合法 JSON：${error?.message}`, stage: 'child' },
    });
    return;
  }

  const { html, url, hints } = input;
  const frozen = Object.freeze({
    html: String(html ?? ''),
    url: String(url ?? ''),
    hints: Object.freeze(typeof hints === 'object' && hints !== null ? hints : {}),
  });

  let module;
  try {
    module = await import(new URL(`file://${adapterPath.replace(/\\/g, '/')}`).href);
  } catch (error) {
    writeResult({
      ok: false,
      error: {
        code: /permission|ERR_ACCESS_DENIED/i.test(String(error?.code) + String(error?.message))
          ? 'SANDBOX_PERMISSION_DENIED'
          : 'ADAPTER_IMPORT_FAILED',
        message: `导入适配器失败：${error?.message}`,
        detail: String(error?.code ?? ''),
        stage: 'import',
      },
    });
    return;
  }

  if (typeof module.parse !== 'function') {
    writeResult({
      ok: false,
      error: { code: 'ADAPTER_NO_PARSE', message: '适配器必须导出 parse 函数', stage: 'import' },
    });
    return;
  }

  let returned;
  try {
    returned = module.parse(frozen);
  } catch (error) {
    writeResult({ ok: false, error: classifyAdapterError(error, 'parse') });
    return;
  }

  if (returned !== null && typeof returned === 'object' && typeof returned.then === 'function') {
    writeResult({
      ok: false,
      error: { code: 'ADAPTER_NOT_SYNC', message: 'parse() 必须同步返回 { events }，不能返回 Promise', stage: 'parse' },
    });
    return;
  }

  const shapeError = checkEventsShape(returned?.events);
  if (shapeError !== undefined) {
    writeResult({ ok: false, error: { ...shapeError, stage: 'parse' } });
    return;
  }
  writeResult({ ok: true, events: returned.events });
}

/** 把适配器抛出的异常分类成结构化错误。 */
function classifyAdapterError(error, stage) {
  const code = String(error?.code ?? '');
  const cause = String(error?.cause?.code ?? '');
  const isPermission = code.startsWith('ERR_ACCESS_DENIED')
    || code === 'ERR_PERMISSION_DENIED'
    || code === 'ERR_ACCESS_DENIED'
    || /permission|access denied|not permitted|code generation from strings/i.test(
      `${error?.message ?? ''} ${cause}`,
    );
  return {
    code: isPermission ? 'SANDBOX_PERMISSION_DENIED' : 'ADAPTER_THREW',
    message: String(error?.message ?? error),
    detail: [code, cause].filter(Boolean).join(' / '),
    stage,
  };
}

/* ------------------------------------------------------------------ */
/* 演示模式：--demo                                                    */
/* ------------------------------------------------------------------ */

function line(level, message) {
  const marks = { ok: '\u001b[32m✓\u001b[0m', fail: '\u001b[31m✗\u001b[0m', info: '\u001b[2m·\u001b[0m' };
  process.stdout.write(`  ${marks[level] ?? '·'} ${message}\n`);
}

function loadFixture(name) {
  return fileURLToPath(new URL(`../test/fixtures/${name}`, import.meta.url));
}

/** 系统目录下的夹具（systems/<id>/fixtures/）。 */
function loadSystemFixture(system, name) {
  return fileURLToPath(new URL(`../presets/systems/${system}/fixtures/${name}`, import.meta.url));
}

async function demoMain() {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const detected = detectPermissionFlag();
  process.stdout.write('\u001b[1m=== 适配器沙箱演示（sandbox:demo）===\u001b[0m\n\n');
  process.stdout.write('沙箱模型：受限子进程（Node 权限模型 + 资源上限 + 代码生成开关）\n');
  process.stdout.write(`权限参数：${detected.flag}（探测标签：${detected.label}）+ --disallow-code-generation-from-strings\n`);
  process.stdout.write(`资源上限：墙钟超时（execFile 的 timeout）、堆上限（--max-old-space-size）、stdio=${SANDBOX_LIMITS.stdio}\n`);
  process.stdout.write(`环境变量白名单：${SANDBOX_LIMITS.envAllowlist.join(', ')}\n\n`);

  let failures = 0;

  process.stdout.write('\u001b[1m[1/4] 正常解析器（presets/systems/jwglxt/parse.js）\u001b[0m\n');
  const adapterPath = resolve(root, 'presets', 'systems', 'jwglxt', 'parse.js');
  const sampleHtml = readFileSync(loadSystemFixture('jwglxt', 'sample-page.html'), 'utf8');
  const good = await runAdapterSandbox({
    adapterPath,
    input: { html: sampleHtml, url: 'https://jwgl.usts.edu.cn/jwglxt/xskb/query', hints: {} },
    permissionFlag: detected.flag,
  });
  if (good.ok) {
    line('ok', `成功返回 ${good.events.length} 条事件（${good.meta.durationMs}ms）`);
    for (const event of good.events.slice(0, 3)) {
      line('info', `周${event.dayOfWeek} 第 ${event.periodStart}-${event.periodEnd} 节 ${event.title} @ ${event.room ?? '未标注'}（${event.teacher ?? '未标注'}）`);
    }
  } else {
    failures += 1;
    line('fail', `预期成功但失败：${good.error.code} ${good.error.message}`);
  }

  process.stdout.write('\n\u001b[1m[2/4] 越权写文件的适配器（test/fixtures/evil-adapter.js）\u001b[0m\n');
  const probeFile = resolve(root, 'sandbox-escape-probe.txt');
  const evil = await runAdapterSandbox({
    adapterPath: loadFixture('evil-adapter.js'),
    input: { html: '<html></html>', url: 'https://example.invalid/', hints: {} },
    permissionFlag: detected.flag,
  });
  if (evil.ok) {
    failures += 1;
    line('fail', '预期被拒绝，但越权适配器执行成功了（沙箱失效！）');
  } else if (evil.error.code === 'SANDBOX_PERMISSION_DENIED') {
    const leaked = existsSync(probeFile);
    if (leaked) {
      failures += 1;
      line('fail', `权限模型报告拒绝，但探测文件真的被写出来了：${probeFile}`);
    } else {
      line('ok', `被权限模型拒绝，结构化返回 ${evil.error.code}（stage=${evil.error.stage}）`);
      line('info', `原始信息：${String(evil.error.message).split('\n')[0]}`);
      line('info', '已确认仓库目录中不存在 sandbox-escape-probe.txt');
    }
  } else {
    failures += 1;
    line('fail', `返回了非预期的错误码 ${evil.error.code}：${evil.error.message}`);
  }

  process.stdout.write('\n\u001b[1m[3/4] 动态生成代码的适配器（test/fixtures/codegen-adapter.js：eval / new Function）\u001b[0m\n');
  const codegen = await runAdapterSandbox({
    adapterPath: loadFixture('codegen-adapter.js'),
    input: { html: '<html></html>', url: 'https://example.invalid/', hints: {} },
    permissionFlag: detected.flag,
  });
  if (codegen.ok) {
    failures += 1;
    line('fail', '预期被拒绝，但 eval / new Function 执行成功了（沙箱失效！）');
  } else if (codegen.error.code === 'SANDBOX_PERMISSION_DENIED') {
    line('ok', `eval / new Function 被 --disallow-code-generation-from-strings 拒绝：${codegen.error.code}`);
    line('info', `原始信息：${String(codegen.error.message).split('\n')[0]}`);
  } else {
    failures += 1;
    line('fail', `返回了非预期的错误码 ${codegen.error.code}：${codegen.error.message}`);
  }

  process.stdout.write('\n\u001b[1m[4/4] 死循环适配器（test/fixtures/hang-adapter.js：触发墙钟超时）\u001b[0m\n');
  const hang = await runAdapterSandbox({
    adapterPath: loadFixture('hang-adapter.js'),
    input: { html: '<html></html>', url: 'https://example.invalid/', hints: {} },
    permissionFlag: detected.flag,
  });
  if (hang.ok) {
    failures += 1;
    line('fail', '预期超时，但死循环适配器返回了结果（沙箱失效！）');
  } else if (hang.error.code === 'SANDBOX_TIMEOUT') {
    line('ok', `已超时终止并结构化返回：${hang.error.code}（耗时 ${hang.meta.durationMs}ms）`);
  } else {
    failures += 1;
    line('fail', `返回了非预期的错误码 ${hang.error.code}：${hang.error.message}`);
  }

  process.stdout.write('\n');
  if (failures === 0) {
    process.stdout.write('\u001b[32m\u001b[1m沙箱演示全部符合预期：正常适配器可跑；越权写文件 / 动态代码生成 / 死循环均被拦截\u001b[0m\n');
  } else {
    process.stdout.write(`\u001b[31m\u001b[1m沙箱演示有 ${failures} 项不符合预期\u001b[0m\n`);
  }
  return failures === 0 ? 0 : 1;
}

const invokedDirectly = process.argv[1] !== undefined
  && fileURLToPath(import.meta.url) === process.argv[1];

if (invokedDirectly) {
  if (process.argv[2] === '--sandbox-child') {
    process.on('uncaughtException', (error) => {
      writeResult({ ok: false, error: { code: 'SANDBOX_CHILD_CRASH', message: String(error?.message ?? error), stage: 'child' } });
      process.exit(0);
    });
    process.on('unhandledRejection', (reason) => {
      // 适配器漏掉了 await / .catch，或调用了会被权限模型异步拒绝的 API。
      // 这里统一转成结构化错误，父进程永远不会看到未捕获异常。
      writeResult({
        ok: false,
        error: {
          code: 'ADAPTER_UNHANDLED_REJECTION',
          message: `适配器产生了未处理的 Promise 拒绝（parse 必须同步、禁止未 await 的 IO 调用）：${String(reason?.message ?? reason)}`,
          detail: String(reason?.cause?.code ?? reason?.code ?? ''),
          stage: 'child',
        },
      });
      process.exit(0);
    });
    await sandboxChildMain();
  } else if (process.argv[2] === '--demo') {
    process.exitCode = await demoMain();
  } else if (process.argv[2] === '--probe') {
    const detected = detectPermissionFlag();
    process.stdout.write(`${JSON.stringify({ node: process.version, detected })}\n`);
  } else {
    process.stdout.write('用法：node scripts/sandbox-run.mjs --demo | --probe | --sandbox-child <adapter>\n');
    process.exitCode = 1;
  }
}
