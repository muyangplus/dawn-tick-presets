# DawnTick Presets · 晓刻配置仓库

[晓刻 DawnTick](https://github.com/muyangplus/dawn-tick)（Tauri + React 课表应用）的**外部可贡献配置仓库**。

主项目本体不放这里；这里按**作者结构**集中管理两类东西，方便学校和社区同学独立提交、独立审核：

| 类型 | 目录 | 内容 |
| --- | --- | --- |
| 学校 | `presets/schools/<school-id>/` | 学校元数据 + 作息时间表 + 对该校所用系统的覆盖 |
| 教务系统 | `presets/systems/<system-id>/` | 元数据 / 识别特征、登录入口、纯函数解析器、一致性夹具 |

> 目标：**让新学校接入不需要改主仓库代码**。你只要加目录（必要时加一个受限解析器 + 夹具），跑通校验，提 PR。

---

## 目录结构（作者结构）

```
README.md                                 本文件：贡献指南
LICENSE                                   Apache-2.0（与主项目一致）
package.json                              type: module；scripts: validate / test / snapshot / sandbox:demo
version.json                              仓库版本 { version, schemaVersion, generatedAt, channel }
schema/                                   per-file JSON Schema（draft 2020-12）
  school-meta.schema.json                 schools/<id>/meta.json
  timetable.schema.json                   schools/<id>/timetable.json
  school-config.schema.json               schools/<id>/config.json（语义写死的四个键）
  system-meta.schema.json                 systems/<id>/meta.json
  system-login.schema.json                systems/<id>/login.json
  system-fixture.schema.json              systems/<id>/fixtures/expected-events.json
  index.schema.json                       presets/index.json（生成物）
presets/
  index.json                              【构建产物，禁止手改】学校索引 + 系统引用 + 版本
  schools/<school-id>/
    meta.json                             学校元数据：id / name / region? / type? / system / aliases?
    timetable.json                        该校作息（periodNo / start / end）
    config.json                           对该校所用系统的覆盖（可选；语义见下）
    README.md                             可选说明（如「通用作息」为什么没有 config.json）
  systems/<system-id>/
    meta.json                             系统元数据：id / name / version? / aliases[] / detect{…}
    login.json                            登录入口：entryPath / hint / fields?
    parse.js                              纯函数解析器 export function parse({ html, url, hints })
    fixtures/                             必填（只要该目录下有 parse.js）
      sample-page.html                    页面样本（脱敏后的真实课表页）
      expected-events.json                期望事件（喂给沙箱跑 parse.js 做一致性校验）
scripts/
  validate.mjs                            全量校验（schema + 语义 + 一致性 + 夹具硬规则 + 安全扫描 + 沙箱冒烟）
  snapshot.mjs                            生成 snapshot/presets-<version>.json 与 presets/index.json
  sandbox-run.mjs                         受限沙箱运行器
  lib/schema.mjs                          零依赖 JSON Schema 子集校验器
  lib/legacy.mjs                          把新结构编译回「旧扁平结构」系统配置（分发格式不变）
test/
  validate.test.mjs                       node --test 用例
  fixtures/{evil,hang,codegen}-adapter.js 沙箱测试夹具（仅测试用，不是系统夹具）
snapshot/presets-<version>.json           扁平编译产物（主仓库客户端只认它）
sandbox/README.md                         沙箱威胁模型与运行约束
.github/workflows/validate.yml            CI：validate → test → snapshot → 生成物未变 → 冒烟
```

**零第三方依赖**：只用 Node 内置模块（`node:test`、`node:assert`、`node:fs`、`node:child_process`、`node:crypto` 等）。请勿提交需要 `npm install` 的方案。

要求 Node **≥ 24**（沙箱依赖 Node 权限模型 `--permission`）。

---

## 改预设的规矩（重要）

> **改预设仓库 → 重跑 validate / snapshot → 把 `presets/index.json` 与 `snapshot/presets-<version>.json` 一起提交。**

- `presets/index.json` 是**生成物**，`_generated: true`，由 `scripts/snapshot.mjs` 生成；**禁止人工编辑**（CI 会重跑 `npm run snapshot` 后做 `git diff --exit-code`，手改必红）。
- `snapshot/presets-<version>.json` 是给主项目消费的**扁平编译产物**，字段结构固定为
  `{ version, schemaVersion, generatedAt, sources: { timetables, systems, adapters }, hash }`，**不得改动结构**（只随 `version.json` 变版本号）。

---

## 能贡献什么

### 1. 新增 / 修正学校（最常见）

新建 `presets/schools/<school-id>/`，包含 `meta.json` 与 `timetable.json`：

```json
// presets/schools/usts/meta.json
{
  "id": "usts",
  "name": "苏州科技大学",
  "region": "江苏",
  "type": "university",
  "system": "jwglxt",
  "aliases": ["苏州科技大学", "苏科大", "USTS"]
}
```

```json
// presets/schools/usts/timetable.json
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

- 目录名建议与 `meta.id` 一致；**只有**「通用作息」用 `_default` 目录，其 `meta.id` 是 `default`、`meta.generic` 是 `true`、`timetable.id` 必须是 `default`。
- `meta.system` 引用的系统 id 必须真实存在于 `presets/systems/`；不绑定教务系统时写 `null`。
- `timetable.source` 必须写清依据（教务处公告 / 官网链接 / 用户提供截图）。凭印象写时间不会被合并。
- `timetable` 的 `periodNo` 必须从 1 起连续递增，`start`/`end` 严格 `HH:MM`，`end > start`，相邻节次不重叠。
- **`schools/` 只收录我们真有数据的学校**——不要批量搬校名清单进来（没有真实作息数据的学校不建目录）。

#### `config.json`：对系统的覆盖（语义写死）

`config.json` 是**可选**的，只允许这四个键，出现其它键 → **校验失败**：

| 键 | 语义 | 约束 |
| --- | --- | --- |
| `system` | 覆盖 `meta.json` 里的 `system`（该校实际用的系统 id） | 必须存在于 `presets/systems/`；与 `meta.system` 不一致时给警告（`index.json` 以 `meta.json` 为准） |
| `login` | 覆盖该系统 `login.json` 的 `entryPath` / `hint` | 只允许这两个子键；`entryPath` 必须 `/` 开头且不含协议/域名 |
| `params` | 附加到登录入口 query 的字符串键值 | 值必须是字符串（如 `{ "gnmkdm": "N2151" }`） |
| `detect` | 向系统级识别特征里**追加** `markers` / `timetableTableIds` / `timetableTableClasses` | **只允许追加，不允许删除系统级特征**；不允许写 `gridCellIdPatterns` |

```json
// 最小写法
{ "system": "jwglxt" }
```

```json
// 覆盖登录入口 + 追加识别特征
{
  "system": "jwglxt",
  "login": { "entryPath": "/jwglxt/xtgl/login_slogin.html", "hint": "课表在「信息查询 → 学生课表查询」" },
  "params": { "gnmkdm": "N2151" },
  "detect": { "markers": ["usts"], "timetableTableIds": ["kbtable-usts"] }
}
```

> 合并规则：客户端拿到的识别特征 = 系统级 `meta.detect` **并集** 学校 `config.detect`；系统级特征永远无法被学校配置删除（这是有意的，避免某校配置破坏系统识别）。

### 2. 修正教务系统识别规则

`presets/systems/<system-id>/meta.json` 的 `id` **只能**是主项目约定的系统 id 之一（`jwglxt` / `qzdatasource` / `urp` / `other`，与 `SCHOOL_SYSTEM_IDS` 严格一致，新增系统 id 属于主项目结构变更，请先开 issue 讨论），且必须与目录名一致：

```json
{
  "id": "jwglxt",
  "name": "正方教务",
  "version": "1.0.0",
  "aliases": ["jwglxt", "正方教务"],
  "detect": {
    "markers": ["jwglxt", "xskb_list", "timetable_con", "kbgrid_table"],
    "timetableTableIds": ["kbtable"],
    "timetableTableClasses": ["kb", "timetable", "schedule", "skb"],
    "gridCellIdPatterns": ["\\d{1,2}[-_]\\d{1,2}"]
  }
}
```

登录入口在同目录的 `login.json`：

```json
{
  "entryPath": "/jwglxt/xtgl/login_slogin.html",
  "hint": "个人课表查询在「信息查询 → 学生课表查询」"
}
```

- `entryPath` 必须以 `/` 开头，且**不能**含协议或域名。
- `markers` 与 `gridCellIdPatterns` 必须是**合法正则字符串**（`new RegExp` 能编译）。
- `other` 表示「其他教务」，**不参与识别**，其 `detect` 各项必须为空数组。
- 注意 JSON 里反斜杠要转义：正则 `\d{1,2}` 写作 `"\\d{1,2}"`。

### 3. 提交 / 修改解析器（门槛最高，请先读契约）

解析器是 `presets/systems/<system-id>/parse.js`，一个**纯函数**，输入 HTML、输出事件，禁止任何 IO / 网络 / 动态求值：

```js
export function parse({ html, url, hints }) {
  return { events: [{ title, dayOfWeek, periodStart, periodEnd, room, teacher, weeks }] };
}
```

**硬规则：有 `parse.js` 就必须有夹具。** `presets/systems/<system-id>/fixtures/` 至少要有

1. 一个页面样本（`*.html` / `*.htm`，脱敏后的真实课表页）；
2. 一个期望事件文件（`*.json`，如 `expected-events.json`，符合 `schema/system-fixture.schema.json`）。

`npm run validate` 会在沙箱里用该夹具执行一次解析器，并校验产出事件与 `expected-events.json` 里声明的期望**逐条一致**（`expect.minEvents` 是最低条数门槛）；夹具缺失或为空 → **校验失败**。同一个系统目录里只允许一个 `parse.js`。

完整契约、字段含义与沙箱限制见 **[sandbox/adapter-contract.md](sandbox/adapter-contract.md)**。

### 4. 改进校验器 / 沙箱 / CI

`scripts/`、`test/`、`.github/` 下的改进入欢迎，但请保持**零第三方依赖**，并为新逻辑补 `node --test` 用例。

---

## 本地校验命令

```bash
npm run validate      # 全量校验：schema + 语义 + 跨文件一致性 + 夹具硬规则 + 安全扫描 + 沙箱冒烟
npm test              # node --test 单元测试（node --test test/*.test.mjs）
npm run snapshot      # 生成 snapshot/presets-<version>.json 与 presets/index.json
npm run sandbox:demo  # 沙箱演示：正常解析器成功 + 越权/动态代码/死循环被拦截
```

`validate` 逐项输出中文结论，任一失败以非 0 退出。提 PR 前请确保 `npm run validate` 与 `npm test` 全绿，并已重跑 `npm run snapshot`。

### 校验都查了什么

| 类别 | 检查项 |
| --- | --- |
| Schema | 七个 per-file schema：`school-meta` / `timetable` / `school-config` / `system-meta` / `system-login` / `system-fixture` / `index` |
| 作息语义 | 文件内 `id` 合法；`periodNo` 唯一、严格递增且从 1 起连续；时间严格 `HH:MM`；`end > start`；相邻节次不重叠；`generic: true` 必须配 `id: "default"` 的作息 |
| 系统语义 | `meta.id` 与目录名一致且唯一、属于 `SCHOOL_SYSTEM_IDS`；`login.entryPath` 以 `/` 开头且不含域名；`markers`/`gridCellIdPatterns` 是合法正则；`timetableTableIds/Classes` 是字符串数组；`other` 的 `detect` 必须全空 |
| `school-config` 语义 | 只允许 `system` / `login` / `params` / `detect` 四个键，未知键即失败；`detect` 只允许追加 `markers` / `timetableTableIds` / `timetableTableClasses`（不允许删除系统级特征、不允许写 `gridCellIdPatterns`）；`params` 值必须是字符串 |
| **夹具硬规则（新增）** | 某系统有 `parse.js` 但 `fixtures/` 缺失或为空 → **校验失败**；有 `parse.js` 就必须同时有页面样本与期望事件；一个系统目录只允许一个 `.js` 解析器 |
| 跨文件一致性 | `schools/*/meta.json` 的 `system` 必须存在于 `systems/`；`systems` 的 id 集合 == `SCHOOL_SYSTEM_IDS`（`jwglxt/qzdatasource/urp/other`）；`index.json` 的学校 / 系统 id 集合与目录实际内容一致，且 `detect` / `entryPath` / `hint` 与 `meta.json` + `login.json` 的编译结果一致 |
| 安全扫描 | 扫描 `systems/*/parse.js`，静态禁用模式命中即报错并给出行号（`require(`、`import `、`process`、`child_process`、`fs`、`net`、`http`、`https`、`fetch(`、`XMLHttpRequest`、`WebSocket`、`eval(`、`new Function`、`globalThis`、`Function(`、`__proto__`、`constructor[`、`while(true)`、`setInterval(`）；且只允许 `export function parse({...})` 这一种导出 |
| 版本一致性 | `version.json.version` 是合法 SemVer；`schemaVersion` 是正整数；`channel` ∈ {stable, beta} |
| 沙箱冒烟 | 每个 `systems/*/parse.js` 在受限子进程里用**它自己的夹具**跑一次，产出的事件必须与 `expected-events.json` 里声明的期望**逐条一致**（`expect.minEvents` 是最低条数门槛） |

> 静态扫描先忽略注释再匹配（注释中的词不计入命中）。运行期约束由 `scripts/sandbox-run.mjs` 的受限子进程施加。

---

## 审核流程

1. **Fork + 分支**：`feat/school-<id>`、`fix/system-<id>`、`feat/parser-<id>`。
2. **本地跑通**：`npm run validate && npm test && npm run snapshot`（生成物要一起提交，见上「改预设的规矩」）。
3. **提 PR**：PR 描述里写清**依据来源**（公告链接 / 截图 / 实测页面），解析器类 PR 请附上脱敏后的样例 HTML（放进 `fixtures/`）。
4. **CI 自动把关**：`.github/workflows/validate.yml` 在 `ubuntu-latest` + Node 24 上跑 `validate` → `test` → `snapshot` → 生成物未变 → `sandbox:demo`，结论写进 PR 的 Step Summary。
5. **人工复核**：
   - 数据类：核对来源真实性、时间是否与公告一致；
   - 解析器类：逐行读代码，确认没有规避静态扫描的写法（如字符串拼接构造 `eval`、隐式网络调用），并确认夹具覆盖了真实页面结构；
   - 一致性：确认 `version.json` 按下面的规则升过版，且 `index.json` / snapshot 已重新生成。
6. **合并**：至少一位维护者 approve；CI 全绿后 squash merge。

---

## 版本与快照

两个产物都由 `scripts/snapshot.mjs` 生成：

### 1. `snapshot/presets-<version>.json`（分发格式，结构固定）

```json
{
  "version": "0.1.0",
  "schemaVersion": 1,
  "generatedAt": "2026-01-01T00:00:00.000Z",
  "sources": {
    "timetables": [{ "id": "usts", "path": "presets/schools/usts/timetable.json", "sha256": "sha256:…" }],
    "systems":    [{ "id": "jwglxt", "path": "presets/systems/jwglxt/system.json", "sha256": "sha256:…" }],
    "adapters":   { "jwglxt.js": "sha256:…" }
  },
  "hash": "sha256:…"
}
```

- `sources.timetables`：真实文件 `presets/schools/<dir>/timetable.json` 的路径 + sha256。
- `sources.systems`：**新结构下不再有「一个系统一个 `.json`」的真实文件**，所以 `path` 是符号路径
  `presets/systems/<id>/system.json`，`sha256` 是 `meta.json` + `login.json` 按**旧扁平结构**
  （`scripts/lib/legacy.mjs`）编译出的文本哈希。对未改动的系统，这个哈希与重构前
  `presets/systems/<id>.json` 的哈希**完全相同**（已用旧快照逐项核对）。
- `sources.adapters`：`systems/<id>/parse.js` 的文件哈希，键名保持旧格式 `<id>.js`。
- `hash`：对「去掉 `hash` 字段后的规范化 JSON」（对象键排序、无多余空白）做 sha256。

### 2. `presets/index.json`（生成物，禁止手改）

`_generated: true` + `version` / `schemaVersion` / `generatedAt` + `schools[]`（学校索引：id / name / region? / type? / system / aliases / generic / default / configPath / timetablePath）+ `systems[]`（系统引用：id / name / version? / aliases / hasParser / parserPath? / metaPath / loginPath / detect / entryPath / hint）。

### 语义化版本规则

| 变更 | 版本位 | 例子 |
| --- | --- | --- |
| **新增**学校 / 新增解析器（纯增量，不破坏既有数据） | **minor** | 0.1.0 → 0.2.0 |
| **修正**时间、字段值、正则（语义兼容） | **patch** | 0.1.0 → 0.1.1 |
| **结构变更**：JSON 字段增减/改名、目录布局调整、消费方需要改代码 | **major** | 0.1.0 → 1.0.0 |

改结构时必须同时 `schemaVersion + 1`，主项目据此判断能否直接消费。`channel` 用 `stable`（正式）或 `beta`（预发布）。

> **本次重构的有意例外**：目录布局从 `presets/{timetables,systems,adapters}` 换成了作者结构，按上表本该 bump `major` 且 `schemaVersion + 1`；但**分发格式（snapshot 字段结构）完全没变**，主项目客户端无需改动，因此经维护者确认：`version` 取 `0.1.0`、`schemaVersion` 保持 `1`。

### 快照可复现（CI 强制）

`generatedAt` 优先取 `--at <ISO>`，其次取环境变量 `SOURCE_DATE_EPOCH`（Unix 秒），都没有才用当前时间。CI 用固定值，因此：

- 内容没变 → snapshot 与 `index.json` 都不变 → `git diff --exit-code snapshot presets/index.json` 通过；
- 内容变了但忘了重新生成 → 该步骤失败，提醒你 `npm run snapshot`。

本地想验证可复现性：

```bash
SOURCE_DATE_EPOCH=1767225600 npm run snapshot
git status --short snapshot presets/index.json   # 应为空
```

---

## 许可

本仓库采用 **Apache License 2.0**（与主项目一致），见 [LICENSE](LICENSE)。

提交 PR 即表示你同意以 Apache-2.0 授权你的贡献，并确认所提交的作息数据、页面结构信息不侵犯第三方权利（**请勿提交教务系统的账号、密码、Cookie、真实学号或未脱敏的个人课表**）。
