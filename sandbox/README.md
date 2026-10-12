# 适配器沙箱：威胁模型与运行约束

本文件说明 `scripts/sandbox-run.mjs` 施加的运行约束与拦截结果，供提交或运行外部适配器前查阅。

---

## 1. 威胁模型

适配器属于**外部贡献、会被执行**的 JavaScript。威胁模型假设：

- 适配器代码可能带有恶意意图：读取用户文件、外传数据、消耗资源；
- 适配器代码可能存在缺陷：死循环、内存膨胀、抛出异常并波及宿主；
- 可信范围：Node 二进制、仓库内 `scripts/`、宿主账户权限。

约束目标分两类：缺陷类故障收敛为终止或结构化错误；上述恶意行为中的文件访问、子进程创建、动态代码生成按权限模型拒绝。

## 2. 架构：受限子进程

```
父进程（validate / sandbox:demo）
  │  execFile(node, [
  │      '--permission',                              ← Node 权限模型
  │      '--disallow-code-generation-from-strings',   ← 禁 eval / new Function
  │      '--allow-fs-read=<presets/adapters>',        ← 只读白名单（仅适配器目录）
  │      <sandbox-run.mjs> '--sandbox-child' <adapter> ← 双角色文件
  │  ], { timeout: <墙钟上限>, stdio: 'pipe', env: 白名单 })
  │
  │  ── stdin：{ html, url, hints }（只有输入数据）
  │  ── stdout：{ ok, events?, error? }（必须是 JSON）
  ▼
子进程（沙箱内）
  ├─ 按 `import()` 加载适配器（读权限仅覆盖适配器目录）
  ├─ 调用 parse(frozenCtx)
  └─ 同步校验返回结构 → 写 JSON → 退出
```

适配器在**独立子进程**中执行，父子进程之间只交换 JSON 字符串。运行约束由 Node 权限模型、资源上限参数与代码生成开关共同施加。

**`stdio: 'pipe'` 的作用**：宿主与沙箱之间只交换 JSON 字符串，沙箱拿不到宿主的文件描述符、tty 或终端能力；父进程也不把子进程的 stdout 直接透传给用户。
---

## 3. 拦截结果

| 攻击 / 故障 | 结果 | 结构化错误码 |
| --- | --- | --- |
| 写文件（`writeFileSync`） | ❌ 拒绝 | `SANDBOX_PERMISSION_DENIED`（`Access to this API has been restricted. Use --allow-fs-write…`） |
| `eval(...)` / `new Function(...)` | 拒绝 | `SANDBOX_PERMISSION_DENIED`（`Code generation from strings disallowed for this context`） |
| 读白名单外的文件 | ❌ 拒绝 | `SANDBOX_PERMISSION_DENIED` |
| 起子进程（`child_process`） | ❌ 拒绝 | `SANDBOX_PERMISSION_DENIED`（未传 `--allow-child-process`） |
| `worker_threads` | 拒绝 | `SANDBOX_PERMISSION_DENIED`（未传 `--allow-worker`） |
| 原生插件 `.node` | ❌ 拒绝 | `SANDBOX_PERMISSION_DENIED`（未传 `--allow-addons`） |
| 死循环 / 长时间计算 | 终止 | `SANDBOX_TIMEOUT`（`execFile` 的 `timeout` 到期后以 SIGTERM 结束子进程） |
| 内存膨胀 | 终止 | `SANDBOX_OOM` 或 `SANDBOX_NO_OUTPUT`（`--max-old-space-size`） |
| 抛异常 / 未处理 Promise 拒绝 | ✅ 转结构化错误 | `ADAPTER_THREW` / `ADAPTER_UNHANDLED_REJECTION` |
| 语法错误 / 导出不对 | ✅ 转结构化错误 | `ADAPTER_IMPORT_FAILED` / `ADAPTER_NO_PARSE` |
| 返回 Promise / 结构不对 | ✅ 转结构化错误 | `ADAPTER_NOT_SYNC` / `ADAPTER_BAD_RESULT` / `ADAPTER_BAD_EVENT` |
| 读取宿主环境变量 | 收窄到白名单 | `env` 只传：`PATH`、`SystemRoot`、`windir`、`TEMP`、`TMP`、`LANG`、`LC_ALL` |

**错误出口**：以上任何情况，父进程都拿不到未捕获异常，只会得到 `{ ok:false, error:{ code, message, stage } }`。

---

## 4. 权限参数与 Node 版本

- `--permission` 是 Node 23+ 的稳定名；Node 20–22 对应 `--experimental-permission`。
- `detectPermissionFlag()` 依次探测两种参数名，并把**实际使用的那种**打印在校验报告与 `sandbox:demo` 输出里。
- 仓库要求 **Node ≥ 24**（`package.json` 的 `engines` 与 CI 一致）。

---

## 5. 运行方式

```bash
npm run sandbox:demo
```

会依次展示：正常适配器成功 → 越权写文件被拒 → `eval`/`new Function` 被拒 → 死循环被超时终止。

单独探测当前 Node 用的权限参数：

```bash
node scripts/sandbox-run.mjs --probe
# {"node":"v24.19.0","detected":{"flag":"--permission","label":"--permission（Node 23+ 稳定名）"}}
```

测试夹具（`test/fixtures/`）里的 `evil-adapter.js`、`codegen-adapter.js`、`hang-adapter.js`
**只在 demo 与测试中使用**，绝不会被放进 `presets/adapters/`（`validate` 只扫描后者）。
