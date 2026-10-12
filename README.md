# DawnTick Presets · 晓刻配置仓库

[晓刻 DawnTick](https://github.com/muyangplus/dawn-tick)（Tauri + React 课表应用）的**外部可贡献配置仓库**。

主项目本体不放这里；这里集中管理三样东西，方便学校和社区同学独立提交、独立审核：

| 类型 | 目录 | 内容 |
| --- | --- | --- |
| 学校作息时间 | `presets/timetables/*.json` | 每节课的起止时间 |
| 教务系统识别 | `presets/systems/*.json` | 登录入口、识别特征、课表表格特征 |
| 适配代码 | `presets/adapters/*.js` | 从教务页面 HTML 里抽取课表事件的纯函数 |

> 目标：**让新学校接入不需要改主仓库代码**。你只要加 JSON（必要时加一个受限适配器），跑通校验，提 PR。

---

## 目录结构

```
README.md                          本文件：贡献指南
LICENSE                            Apache-2.0（与主项目一致）
package.json                       type: module；scripts: validate / test / snapshot / sandbox:demo
version.json                       仓库版本 { version, schemaVersion, generatedAt, channel }
schema/
  timetables.schema.json           作息表 JSON Schema（draft 2020-12）
  systems.schema.json              教务系统 JSON Schema
  conformance.schema.json          适配器自检用例 JSON Schema
presets/
  timetables/{usts,default}.json   学校作息时间表
  systems/{jwglxt,qzdatasource,urp,other}.json   教务系统识别配置
  adapters/jwglxt.js               受限沙箱适配器（导出一个纯函数）
  adapters/README.md               适配器接口契约与沙箱限制
scripts/
  validate.mjs                     全量校验（schema + 语义 + 一致性 + 安全扫描 + 沙箱冒烟）
  snapshot.mjs                     生成 snapshot/presets-<version>.json（含内容哈希）
  sandbox-run.mjs                  受限沙箱运行器
  lib/schema.mjs                   零依赖 JSON Schema 子集校验器
test/
  validate.test.mjs                node --test 用例
  conformance/*.json               适配器自检用例（喂给沙箱的 HTML 与期望结果）
  fixtures/*.html|js               测试夹具（含恶意/死循环适配器样本，仅测试用）
snapshot/.gitkeep                  快照产物目录
sandbox/README.md                  沙箱威胁模型与运行约束
.github/workflows/validate.yml     CI：validate → test → snapshot → 冒烟
```

**零第三方依赖**：只用 Node 内置模块（`node:test`、`node:assert`、`node:fs`、`node:child_process`、`node:crypto` 等）。请勿提交需要 `npm install` 的方案。

要求 Node **≥ 24**（沙箱依赖 Node 权限模型 `--permission`）。

---

## 能贡献什么

### 1. 新增 / 修正学校作息表（最常见，欢迎直接提）

新增 `presets/timetables/<id>.json`，`<id>` 用小写字母开头的稳定标识（如 `usts`、`njupt`）。

```json
{
  "id": "usts",
  "name": "苏州科技大学",
  "source": "学校教务处公告（用户提供截图）",
  "periods": [
    { "periodNo": 1, "start": "08:00", "end": "08:45" },
    { "periodNo": 2, "start": "08:55", "end": "09:40" }
  ]
}
```

`source` 必须写清依据（教务处公告 / 官网链接 / 用户提供截图）。凭印象写时间不会被合并。

### 2. 修正教务系统识别规则

`presets/systems/*.json` 的 `id` **只能**是 `jwglxt` / `qzdatasource` / `urp` / `other` 之一（与主项目 `SCHOOL_SYSTEM_IDS` 严格一致，新增系统 id 属于主项目结构变更，请先开 issue 讨论）：

```json
{
  "id": "jwglxt",
  "name": "正方教务",
  "entryPath": "/jwglxt/xtgl/login_slogin.html",
  "hint": "个人课表查询在「信息查询 → 学生课表查询」",
  "detect": {
    "markers": ["jwglxt", "xskb_list", "timetable_con", "kbgrid_table"],
    "timetableTableIds": ["kbtable"],
    "timetableTableClasses": ["kb", "timetable", "schedule", "skb"],
    "gridCellIdPatterns": ["\\d{1,2}[-_]\\d{1,2}"]
  }
}
```

- `entryPath` 必须以 `/` 开头，且**不能**含协议或域名。
- `markers` 与 `gridCellIdPatterns` 必须是**合法正则字符串**（`new RegExp` 能编译）。
- `other` 表示「其他教务」，**不参与识别**，其 `detect` 各项必须为空数组。
- 注意 JSON 里反斜杠要转义：正则 `\d{1,2}` 写作 `"\\d{1,2}"`。

### 3. 提交适配器（门槛最高，请先读契约）

适配器是一个**纯函数**，输入 HTML、输出事件，禁止任何 IO / 网络 / 动态求值：

```js
export function parse({ html, url, hints }) {
  return { events: [{ title, dayOfWeek, periodStart, periodEnd, room, teacher, weeks }] };
}
```

完整契约、字段含义与沙箱限制见 **[presets/adapters/README.md](presets/adapters/README.md)**。

同时需要提交 `test/conformance/<id>.json` 自检用例（输入 HTML + 期望事件），CI 会在沙箱里真跑一遍。

### 4. 改进校验器 / 沙箱 / CI

`scripts/`、`test/`、`.github/` 下的改进入欢迎，但请保持**零第三方依赖**，并为新逻辑补 `node --test` 用例。

---

## 本地校验命令

```bash
npm run validate      # 全量校验：schema + 语义 + 跨文件一致性 + 安全扫描 + 沙箱冒烟
npm test              # node --test 单元测试
npm run snapshot      # 生成 snapshot/presets-<version>.json
npm run sandbox:demo  # 沙箱演示：正常适配器成功 + 越权/动态代码/死循环被拦截
```

`validate` 逐项输出中文结论，任一失败以非 0 退出。提 PR 前请确保 `npm run validate` 与 `npm test` 全绿。

### 校验都查了什么

| 类别 | 检查项 |
| --- | --- |
| Schema | `type` / `required` / `properties` / `additionalProperties` / `items` / `enum` / `pattern` / `minLength` / `minItems` / `maxItems` / `minimum` / `maximum` / `uniqueItems` / `$ref` |
| 作息语义 | `periodNo` 唯一、严格递增且从 1 起连续；时间严格 `HH:MM`；`end > start`；相邻节次不重叠；文件内 `id` 与文件名一致 |
| 系统语义 | `id` 唯一且属于 `SCHOOL_SYSTEM_IDS`；`entryPath` 以 `/` 开头且不含域名；`markers`/`gridCellIdPatterns` 是合法正则；`timetableTableIds/Classes` 是字符串数组 |
| 跨文件一致性 | `presets/systems/*.json` 的 id 集合 == `SCHOOL_SYSTEM_IDS`（`jwglxt/qzdatasource/urp/other`）；`other` 的 `detect` 必须全空 |
| 安全扫描 | 适配器静态禁用模式命中即报错并给出行号（`require(`、`import `、`process`、`child_process`、`fs`、`net`、`http`、`https`、`fetch(`、`XMLHttpRequest`、`WebSocket`、`eval(`、`new Function`、`globalThis`、`Function(`、`__proto__`、`constructor[`、`while(true)`、`setInterval(`）；且只允许 `export function parse({...})` 这一种导出 |
| 版本一致性 | `version.json.version` 是合法 SemVer；`schemaVersion` 是正整数；`channel` ∈ {stable, beta} |
| 沙箱冒烟 | 每个 `presets/adapters/*.js` 在受限子进程里跑一次 `test/conformance` 用例，验证真的能产出期望事件 |

> 静态扫描先忽略注释再匹配（注释中的词不计入命中）。运行期约束由 `scripts/sandbox-run.mjs` 的受限子进程施加。

---

## 审核流程

1. **Fork + 分支**：`feat/timetable-<school>`、`fix/system-<id>`、`feat/adapter-<id>`。
2. **本地跑通**：`npm run validate && npm test && npm run snapshot`（快照要一起提交，见下）。
3. **提 PR**：PR 描述里写清**依据来源**（公告链接 / 截图 / 实测页面），适配器类 PR 请附上脱敏后的样例 HTML。
4. **CI 自动把关**：`.github/workflows/validate.yml` 在 `ubuntu-latest` + Node 24 上跑 `validate` → `test` → `snapshot` → 哈希一致性 → `sandbox:demo`，结论写进 PR 的 Step Summary。
5. **人工复核**：
   - 数据类：核对来源真实性、时间是否与公告一致；
   - 适配器类：逐行读代码，确认没有规避静态扫描的写法（如字符串拼接构造 `eval`、隐式网络调用），并确认自检用例覆盖了真实页面结构；
   - 一致性：确认 `version.json` 按下面的规则升过版。
6. **合并**：至少一位维护者 approve；CI 全绿后 squash merge。

---

## 版本与快照

`snapshot/presets-<version>.json` 是给主项目消费的**内容快照**：

```json
{
  "version": "1.0.0",
  "schemaVersion": 1,
  "generatedAt": "2026-01-01T00:00:00.000Z",
  "sources": {
    "timetables": [{ "id": "usts", "path": "presets/timetables/usts.json", "sha256": "sha256:…" }],
    "systems":    [{ "id": "jwglxt", "path": "presets/systems/jwglxt.json", "sha256": "sha256:…" }],
    "adapters":   { "jwglxt.js": "sha256:…" }
  },
  "hash": "sha256:…"
}
```

`hash` 是对「去掉 `hash` 字段后的规范化 JSON」（对象键排序、无多余空白）做 sha256，任何内容变化都会改哈希。

### 语义化版本规则

| 变更 | 版本位 | 例子 |
| --- | --- | --- |
| **新增**学校作息 / 新增适配器（纯增量，不破坏既有数据） | **minor** | 1.0.0 → 1.1.0 |
| **修正**时间、字段值、正则（语义兼容） | **patch** | 1.0.0 → 1.0.1 |
| **结构变更**：JSON 字段增减/改名、目录布局调整、消费方需要改代码 | **major** | 1.0.0 → 2.0.0 |

改结构时必须同时 `schemaVersion + 1`，主项目据此判断能否直接消费。`channel` 用 `stable`（正式）或 `beta`（预发布）。

### 快照可复现（CI 强制）

`generatedAt` 优先取 `--at <ISO>`，其次取环境变量 `SOURCE_DATE_EPOCH`（Unix 秒），都没有才用当前时间。CI 用固定值，因此：

- 内容没变 → 快照文件不变 → `git diff --exit-code snapshot` 通过；
- 内容变了但忘了重新生成快照 → 该步骤失败，提醒你 `npm run snapshot`。

本地想验证可复现性：

```bash
SOURCE_DATE_EPOCH=1767225600 npm run snapshot
git status --short snapshot   # 应为空
```

---

## 许可

本仓库采用 **Apache License 2.0**（与主项目一致），见 [LICENSE](LICENSE)。

提交 PR 即表示你同意以 Apache-2.0 授权你的贡献，并确认所提交的作息数据、页面结构信息不侵犯第三方权利（**请勿提交教务系统的账号、密码、Cookie、真实学号或未脱敏的个人课表**）。
