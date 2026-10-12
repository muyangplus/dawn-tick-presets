# DawnTick Presets · 晓刻配置仓库

[晓刻 DawnTick](https://github.com/muyangplus/dawn-tick)（Tauri + React 课表应用）的**外部可贡献配置仓库**。

主项目本体不放这里；这里按**作者结构**集中管理两类东西，方便学校和社区同学独立提交、独立审核：

| 类型 | 目录 | 内容 |
| --- | --- | --- |
| 学校 | `presets/schools/<school-id>/school.json` | 学校身份 + 作息时间表 + 对该校所用系统的覆盖（**一个文件**） |
| 教务系统 | `presets/systems/<system-id>/system.json` | 元数据 / 识别特征 / 登录入口（**一个文件**） |

> 目标：**让新学校接入不需要改主仓库代码**。你只要改一个 `school.json`（必要时加一个受限解析器 + 夹具），跑通校验，提 PR。

---

## 目录结构

```
README.md                                 本文件：贡献指南
LICENSE                                   Apache-2.0（与主项目一致）
package.json                              type: module；scripts: validate / test / snapshot / sandbox:demo
version.json                              仓库版本 { version, schemaVersion, generatedAt, channel }
schema/                                   per-file JSON Schema（draft 2020-12）
  school.schema.json                      schools/<id>/school.json
  system.schema.json                      systems/<id>/system.json
  snapshot.schema.json                    snapshot/presets-<version>.json（唯一生成物）
presets/
  schools/<school-id>/
    school.json                           身份 + 作息 + 覆盖（合并了原 meta / timetable / config）
    parse.js                              可选：**学校级**解析器（优先级高于系统级）
    fixtures/                             有 parse.js 则必须非空（页面样本 + 期望事件）
    NOTES.json                            可选说明（如「通用作息」为什么 system 为 null）
  systems/<system-id>/
    system.json                           元数据 + 识别特征（detect）+ 登录入口（login）
    parse.js                              可选：系统级解析器（服务该系统下所有学校）
    fixtures/                             有 parse.js 则必须非空
scripts/
  validate.mjs                            全量校验（schema + 语义 + 一致性 + 夹具硬规则 + 安全扫描 + 沙箱冒烟）
  snapshot.mjs                            生成**唯一产物** snapshot/presets-<version>.json（含内嵌 index）
  sandbox-run.mjs                         受限沙箱运行器
  lib/schema.mjs                          零依赖 JSON Schema 子集校验器
  lib/repo.mjs                            读取合并结构（school.json / system.json）
  lib/legacy.mjs                          把 system.json 编译回「旧扁平结构」系统配置（分发格式不变）
test/
  validate.test.mjs                       node --test 用例
  fixtures/{evil,hang,codegen}-adapter.js 沙箱测试夹具（仅测试用，不是系统夹具）
snapshot/presets-<version>.json           【唯一生成物】分发清单 + 内嵌 index
sandbox/README.md                         沙箱威胁模型与运行约束
sandbox/adapter-contract.md               解析器接口契约（两个挂载点 + 优先级 + 夹具规则）
.github/workflows/validate.yml            CI：validate → test → snapshot → 生成物未变 → 冒烟
```

**已取消的产物**：`presets/index.json`。它的全部信息（学校索引 + 系统引用 + 版本）现在并入
快照的新增字段 `index`；仓库里不再存在这个文件（校验器发现它会直接报错）。

**零第三方依赖**：只用 Node 内置模块（`node:test`、`node:assert`、`node:fs`、`node:child_process`、`node:crypto` 等）。请勿提交需要 `npm install` 的方案。

要求 Node **≥ 24**（沙箱依赖 Node 权限模型 `--permission`）。

---

## 改预设的规矩（重要）

> **改预设仓库 → 重跑 validate / snapshot → 提交快照。**

- `snapshot/presets-<version>.json` 是**唯一生成物**兼分发产物：
  - 顶层保留旧字段结构 `{ version, schemaVersion, generatedAt, sources: { timetables, systems, adapters }, hash }`；
  - 新增 `index` 字段承载原 `presets/index.json` 的全部信息（客户端忽略未知键，因此结构演进不破坏兼容）。
- **快照必须已提交**：CI 会重跑 `npm run snapshot` 后做 `git diff --exit-code snapshot`。
- `hash` 的规范化范围 = **去掉 `hash` 之后的整个快照，包含 `index`**；也就是说改一行 index 就会改 hash。
- 快照是生成物，**禁止手改**（`index._generated` 恒为 `true`，校验器会用它复算全量内容）。

---

## 能贡献什么

### 1. 新增 / 修正学校（最常见）

新建 `presets/schools/<school-id>/school.json`：**身份字段平铺在顶层，作息放在 `timetable` 键，对该校系统的覆盖（`login` / `params` / `detect`）同样平铺在顶层**。

```json
// presets/schools/usts/school.json
{
  "id": "usts",
  "name": "苏州科技大学",
  "region": "江苏",
  "type": "university",
  "system": "jwglxt",
  "aliases": ["苏州科技大学", "苏科大", "USTS"],
  "timetable": {
    "id": "usts",
    "name": "苏州科技大学",
    "source": "学校教务处公告（用户提供截图）",
    "periods": [
      { "periodNo": 1, "start": "08:00", "end": "08:45" },
      { "periodNo": 2, "start": "08:55", "end": "09:40" }
    ]
  }
}
```

- 目录名建议与 `id` 一致；**只有**「通用作息」用 `_default` 目录，其 `id` 是 `default`、`generic` 是 `true`、`timetable.id` 必须是 `default`。
- `system` 引用的系统 id 必须真实存在于 `presets/systems/`；不绑定教务系统时写 `null`。
- `timetable.source` 必须写清依据（教务处公告 / 官网链接 / 用户提供截图）。凭印象写时间不会被合并。
- `timetable.periods` 的 `periodNo` 必须从 1 起连续递增，`start`/`end` 严格 `HH:MM`，`end > start`，相邻节次不重叠。
- **`schools/` 只收录我们真有数据的学校**——不要批量搬校名清单进来（没有真实作息数据的学校不建目录）。

#### 顶层字段一览

| 字段 | 类型 | 必填 | 语义 |
| --- | --- | --- | --- |
| `id` | string | ✅ | 学校稳定标识（`^[a-z][a-z0-9_-]*$`），也是对外暴露的作息表 id |
| `name` | string | ✅ | 中文展示名 |
| `shortName` / `region` / `province` / `city` / `tags` | string / string[] | | 展示与检索用（可选） |
| `type` | string | | 学校类型，如 `university` / `college` / `generic` |
| `system` | string \| null | ✅ | 该校使用的教务系统 id（必须在 `presets/systems/` 下存在）；`null` 表示不绑定 |
| `aliases` | string[] | | 搜索别名 |
| `generic` | boolean | | `true` 表示这是「通用作息」而非真实学校 |
| `login` | object | | **覆盖**该系统 `login` 的 `entryPath` / `hint` |
| `params` | object | | 追加到登录入口 query 的字符串键值对 |
| `detect` | object | | 向系统级识别特征**追加** `markers` / `timetableTableIds` / `timetableTableClasses` |
| `timetable` | object | ✅ | 作息时间表：`id` / `name` / `source?` / `periods[]` |

#### 覆盖语义（原 `config.json`，键白名单写死）

覆盖键只允许四个：`system` / `login` / `params` / `detect`。出现其它键 → **校验失败**。

| 键 | 语义 | 约束 |
| --- | --- | --- |
| `system` | 该校实际使用的系统 id | 必须存在于 `presets/systems/`；合并后 `school.json` 的 `system` 是**唯一真值**（快照 `index.schools[].system` 取它） |
| `login` | 覆盖 `systems/<id>/system.json` 的 `login.entryPath` / `login.hint` | 只允许这两个子键；`entryPath` 必须 `/` 开头且不含协议/域名 |
| `params` | 附加到登录入口 query 的字符串键值 | 值必须是字符串（如 `{ "gnmkdm": "N2151" }`） |
| `detect` | 向系统级识别特征里**追加** `markers` / `timetableTableIds` / `timetableTableClasses` | **只允许追加，不允许删除系统级特征**；不允许写 `gridCellIdPatterns` |

```json
// 覆盖登录入口 + 追加识别特征（写在 school.json 顶层）
{
  "id": "usts",
  "name": "苏州科技大学",
  "system": "jwglxt",
  "login": { "entryPath": "/jwglxt/xtgl/login_slogin.html", "hint": "课表在「信息查询 → 学生课表查询」" },
  "params": { "gnmkdm": "N2151" },
  "detect": { "markers": ["usts"], "timetableTableIds": ["kbtable-usts"] },
  "timetable": { "id": "usts", "name": "苏州科技大学", "periods": [{ "periodNo": 1, "start": "08:00", "end": "08:45" }] }
}
```

> 合并规则：客户端拿到的识别特征 = 系统级 `detect` **并集** 学校 `detect`；系统级特征永远无法被学校配置删除（这是有意的，避免某校配置破坏系统识别）。

### 2. 修正教务系统识别规则

`presets/systems/<system-id>/system.json` 的 `id` **只能**是主项目约定的系统 id 之一（`jwglxt` / `qzdatasource` / `urp` / `other`，与 `SCHOOL_SYSTEM_IDS` 严格一致，新增系统 id 属于主项目结构变更，请先开 issue 讨论），且必须与目录名一致：

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
  },
  "login": {
    "entryPath": "/jwglxt/xtgl/login_slogin.html",
    "hint": "个人课表查询在「信息查询 → 学生课表查询」"
  }
}
```

| 字段 | 类型 | 必填 | 语义 |
| --- | --- | --- | --- |
| `id` | string | ✅ | 系统 id，必须与目录名一致且在约定集合内 |
| `name` | string | ✅ | 展示名 |
| `version` | string | | 该系统配置 / 解析器自身的版本号 |
| `aliases` | string[] | | 识别 / 搜索别名 |
| `detect` | object | ✅ | `markers` / `timetableTableIds` / `timetableTableClasses` / `gridCellIdPatterns` 四键齐全 |
| `login` | object | ✅ | `entryPath`（必须 `/` 开头、不能含协议或域名）/ `hint` / `fields?` |

- `markers` 与 `gridCellIdPatterns` 必须是**合法正则字符串**（`new RegExp` 能编译）。
- `other` 表示「其他教务」，**不参与识别**，其 `detect` 各项必须为空数组。
- 注意 JSON 里反斜杠要转义：正则 `\d{1,2}` 写作 `"\\d{1,2}"`。

### 3. 提交 / 修改解析器（门槛最高，请先读契约）

解析器是**纯函数**，输入 HTML、输出事件，禁止任何 IO / 外部请求 / 动态求值。它可以放在两个位置：

- `presets/systems/<system-id>/parse.js`：服务该系统下**所有**学校；
- `presets/schools/<school-id>/parse.js`：**只**服务这一所学校。

**优先级：学校级 ＞ 系统级。** 两者都存在时学校级生效（校验报告里的 `D3` 小节会明确写出）。
同一个目录里只允许一个 `parse.js`。

```js
export function parse({ html, url, hints }) {
  return { events: [{ title, dayOfWeek, periodStart, periodEnd, room, teacher, weeks }] };
}
```

**硬规则：有 `parse.js` 就必须有夹具。** 同目录的 `fixtures/` 至少要有

1. 一个页面样本（`*.html` / `*.htm`，脱敏后的真实课表页）；
2. 一个期望事件文件（`*.json`，如 `expected-events.json`）。

`npm run validate` 会在沙箱里用该夹具执行一次解析器，并校验产出事件与期望文件里声明的期望**逐条一致**（`expect.minEvents` 是最低条数门槛）；夹具缺失或为空 → **校验失败**。

完整契约、字段含义与沙箱限制见 **[sandbox/adapter-contract.md](sandbox/adapter-contract.md)**。

### 4. 改进校验器 / 沙箱 / CI

`scripts/`、`test/`、`.github/` 下的改进入欢迎，但请保持**零第三方依赖**，并为新逻辑补 `node --test` 用例。

---

## 本地校验命令

```bash
npm run validate      # 全量校验：schema + 语义 + 跨文件一致性 + 夹具硬规则 + 安全扫描 + 沙箱冒烟
npm test              # node --test 单元测试（node --test test/*.test.mjs）
npm run snapshot      # 生成 snapshot/presets-<version>.json（唯一产物，含内嵌 index）
npm run sandbox:demo  # 沙箱演示：正常解析器成功 + 越权/动态代码/死循环被拦截
```

`validate` 逐项输出中文结论，任一失败以非 0 退出。提 PR 前请确保 `npm run validate` 与 `npm test` 全绿，并已重跑 `npm run snapshot`。

### 校验都查了什么

| 类别 | 检查项 |
| --- | --- |
| Schema | 三个 per-file schema：`school`（`schools/<id>/school.json`）/ `system`（`systems/<id>/system.json`）/ `snapshot`（唯一生成物） |
| 作息语义 | `timetable.id` 合法；`periodNo` 唯一、严格递增且从 1 起连续；时间严格 `HH:MM`；`end > start`；相邻节次不重叠；`generic: true` 必须配 `timetable.id: "default"` |
| 系统语义 | `id` 与目录名一致且唯一、属于 `SCHOOL_SYSTEM_IDS`；`login.entryPath` 以 `/` 开头且不含域名；`markers`/`gridCellIdPatterns` 是合法正则；`timetableTableIds/Classes` 是字符串数组；`other` 的 `detect` 必须全空 |
| school.json 语义 | 顶层只允许身份键 + `login`/`params`/`detect`/`timetable`，未知键即失败；覆盖键白名单 `system`/`login`/`params`/`detect`；`detect` 只允许追加（不允许删除系统级特征、不允许写 `gridCellIdPatterns`）；`params` 值必须是字符串 |
| **夹具硬规则** | **学校级与系统级**只要有 `parse.js`，同目录 `fixtures/` 缺失或为空 → **校验失败**；必须有页面样本 + 期望事件；一个目录只允许一个解析器 |
| 解析器优先级 | 报告 `D3` 小节显式写出每所学校实际生效的解析器（学校级 ＞ 系统级） |
| 跨文件一致性 | `schools/*/school.json` 的 `system` 必须存在于 `systems/`；`systems` 的 id 集合 == `SCHOOL_SYSTEM_IDS`（`jwglxt/qzdatasource/urp/other`） |
| 生成物一致性 | 快照必须存在且**可从当前目录完整复现**；`sources.timetables/systems/adapters` 的 path 与 sha256 逐项复算；内嵌 `index` 的学校 / 系统 id 集合与目录一致，`detect` / `entryPath` / `hint` / `hasParser` 与源文件一致；`hash` 覆盖 `index`；`presets/index.json` 必须不存在 |
| 安全扫描 | 扫描 `systems/*/parse.js` **与** `schools/*/parse.js`，静态禁用模式命中即报错并给出行号（`require(`、`import `、`process`、`child_process`、`fs`、`net`、`http`、`https`、`fetch(`、`XMLHttpRequest`、`WebSocket`、`eval(`、`new Function`、`globalThis`、`Function(`、`__proto__`、`constructor[`、`while(true)`、`setInterval(`）；且只允许 `export function parse({...})` 这一种导出 |
| 版本一致性 | `version.json.version` 是合法 SemVer；`schemaVersion` 是正整数；`channel` ∈ {stable, beta} |
| 沙箱冒烟 | 每个 `parse.js` 在受限子进程里用**它自己的夹具**跑一次，产出的事件必须与期望文件里声明的期望**逐条一致** |

> 静态扫描先忽略注释再匹配（注释中的词不计入命中）。运行期约束由 `scripts/sandbox-run.mjs` 的受限子进程施加。

---

## 审核流程

1. **Fork + 分支**：`feat/school-<id>`、`fix/system-<id>`、`feat/parser-<id>`。
2. **本地跑通**：`npm run validate && npm test && npm run snapshot`（快照要一起提交，见上「改预设的规矩」）。
3. **提 PR**：PR 描述里写清**依据来源**（公告链接 / 截图 / 实测页面），解析器类 PR 请附上脱敏后的样例 HTML（放进 `fixtures/`）。
4. **CI 自动把关**：`.github/workflows/validate.yml` 在 `ubuntu-latest` + Node 24 上跑 `validate` → `test` → `snapshot` → 生成物未变 → `sandbox:demo`，结论写进 PR 的 Step Summary。
5. **人工复核**：
   - 数据类：核对来源真实性、时间是否与公告一致；
   - 解析器类：逐行读代码，确认没有规避静态扫描的写法（如字符串拼接构造 `eval`、隐式网络调用），并确认夹具覆盖了真实页面结构；
   - 一致性：确认 `version.json` 按下面的规则升过版，且快照已重新生成。
6. **合并**：至少一位维护者 approve；CI 全绿后 squash merge。

---

## 版本与快照

产物只有一个：`snapshot/presets-<version>.json`。

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
  "index": {
    "_generated": true,
    "version": "0.1.0",
    "schemaVersion": 1,
    "generatedAt": "2026-01-01T00:00:00.000Z",
    "schools": [ { "id": "usts", "name": "苏州科技大学", "system": "jwglxt", "generic": false, "default": false, "configPath": "presets/schools/usts/school.json", "timetablePath": "presets/schools/usts/school.json", "region": "江苏", "type": "university", "aliases": ["…"] } ],
    "systems": [ { "id": "jwglxt", "name": "正方教务", "hasParser": true, "parserPath": "presets/systems/jwglxt/parse.js", "metaPath": "presets/systems/jwglxt/system.json", "loginPath": "presets/systems/jwglxt/system.json", "detect": { "…": [] }, "entryPath": "/…", "hint": "…" } ]
  },
  "hash": "sha256:…"
}
```

### `sources`（分发清单，字段结构保持旧契约）

- `sources.timetables[].path` 是**符号路径**，恒为 `presets/schools/<校目录>/timetable.json`（真实文件已合并进 `school.json`）；
  `sha256` 是**原始作息 JSON 文本**的哈希 —— 合并时把 `timetable` 的值**逐字节**内嵌（只整体缩进一层），
  因此这些哈希与合并前**完全一致**（这也是 `scripts/snapshot.mjs` 的 `extractTimetableText` 存在的唯一原因：
  绝不能走 `JSON.stringify` 重新排版，否则字节会变、哈希会变）。
- `sources.systems[].path` 是符号路径 `presets/systems/<id>/system.json`；
  `sha256` 是把 `system.json` 按**旧扁平结构**（`scripts/lib/legacy.mjs`）编译出的文本哈希。
- `sources.adapters` 是解析器文件哈希：系统解析器键名 `<系统id>.js`，学校解析器键名 `<学校id>.js`
  （两个 id 空间不同，正常不会重名；万一重名，系统级优先，学校级解析器仍可通过 `index.schools[].parserPath` 定位）。
- `hash`：对「去掉 `hash` 字段后的**整个快照**（**包含 `index`**）」做规范化 JSON（对象键排序、无多余空白）后的 sha256。

### `index`（新增字段，承载原 `presets/index.json`）

学校索引（id / name / region? / type? / system / aliases / generic / default / configPath / timetablePath）+
系统引用（id / name / version? / aliases / hasParser / parserPath? / metaPath / loginPath / detect / entryPath / hint）。
合并后 `configPath` 与 `timetablePath` 都指向 `schools/<dir>/school.json`，`metaPath` 与 `loginPath` 都指向
`systems/<id>/system.json`（键名刻意保留，避免消费方 breaking）。

### 语义化版本规则

| 变更 | 版本位 | 例子 |
| --- | --- | --- |
| **新增**学校 / 新增解析器（纯增量，不破坏既有数据） | **minor** | 0.1.0 → 0.2.0 |
| **修正**时间、字段值、正则（语义兼容） | **patch** | 0.1.0 → 0.1.1 |
| **结构变更**：JSON 字段增减/改名、目录布局调整、消费方需要改代码 | **major** | 0.1.0 → 1.0.0 |

改结构时必须同时 `schemaVersion + 1`，主项目据此判断能否直接消费。`channel` 用 `stable`（正式）或 `beta`（预发布）。

> **两次有意例外（README 写明）**
>
> 1. 作者结构重构（`presets/{timetables,systems,adapters}` → `presets/{schools,systems}`）本应 bump major；
> 2. 本次「配置合并」（meta+timetable+config → `school.json`；meta+login → `system.json`；取消 `presets/index.json`、
>    信息并入快照 `index`）同样属于结构变更。
>
> 但**分发格式（快照的旧字段结构与全部 sha256）完全没变**，主项目客户端无需改代码即可继续消费，因此经维护者确认：
> `version` 保持 `0.1.0`、`schemaVersion` 保持 `1`。

### 快照可复现（CI 强制）

`generatedAt` 优先取 `--at <ISO>`，其次取环境变量 `SOURCE_DATE_EPOCH`（Unix 秒），都没有才用当前时间。CI 用固定值，因此：

- 内容没变 → 快照不变 → `git diff --exit-code snapshot` 通过；
- 内容变了但忘了重新生成 → 该步骤失败，提醒你 `npm run snapshot`。

本地想验证可复现性：

```bash
SOURCE_DATE_EPOCH=1767225600 npm run snapshot
git status --short snapshot   # 应为空
```

---

## 许可

本仓库采用 **Apache License 2.0**（与主项目一致），见 [LICENSE](LICENSE)。

提交 PR 即表示你同意以 Apache-2.0 授权你的贡献，并确认所提交的作息数据、页面结构信息不侵犯第三方权利（**请勿提交教务系统的账号、密码、Cookie、真实学号或未脱敏的个人课表**）。
