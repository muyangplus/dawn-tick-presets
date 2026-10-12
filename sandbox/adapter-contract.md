# 解析器接口契约（`presets/systems/<system-id>/parse.js`）

解析器负责把某个教务系统课表页面的 **HTML** 变成晓刻能用的**事件列表**。
因为它是「外部贡献的、会被执行的代码」，所以它的运行环境是受限沙箱，接口也被刻意收窄。

> 先读 [README.md](README.md) 了解沙箱的运行约束与拦截结果。

---

## 1. 接口

```js
// 输入只读；禁止任何 IO / 外部请求；必须纯函数式返回
export function parse({ html, url, hints }) {
  // 返回 { events: [{ title, dayOfWeek, periodStart, periodEnd, room, teacher, weeks }] }
  return { events: [] };
}
```

**整个文件只能有这一个导出**。校验器会检查：

- 必须匹配 `export function parse({ … }) {` 的形式；
- 不允许出现任何其它 `export`；
- 不允许 CommonJS（`module.exports` / `exports.`）。

### 入参（`ctx`）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `html` | `string` | 课表页面的 HTML（已登录后的页面）。**只读**，不要试图改写它。 |
| `url` | `string` | 页面 URL，用于区分同一系统的不同入口。 |
| `hints` | `object` | 来自 `presets/systems/<id>/meta.json` 的 `detect` 提示（表格 id / class / 格子 id 正则等）。可能为空对象。 |

入参在沙箱里被 `Object.freeze`，写入不会生效。

### 返回（`{ events: [...] }`）

必须是**同步**返回（返回 Promise 会被判为 `ADAPTER_NOT_SYNC` 直接失败）。

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `title` | `string` | ✅ | 课程名 |
| `dayOfWeek` | `integer` | ✅ | 1=周一 … 7=周日 |
| `periodStart` | `integer` | ✅ | 起始节次，从 1 开始 |
| `periodEnd` | `integer` | ✅ | 结束节次（含），≥ `periodStart` |
| `room` | `string` | | 教室，未知就给 `""` |
| `teacher` | `string` | | 教师，未知就给 `""` |
| `weeks` | `integer[]` | | 上课周次，`[]` 表示未解析出周次 |

解析不出内容时返回 `{ events: [] }`，**不要**抛异常（抛了会被沙箱转成结构化错误，但那是失败信号）。

---

## 2. 硬性禁止（静态扫描会拦，命中即 CI 失败）

| 禁用模式 | 原因 |
| --- | --- |
| `require(` / `import ` / `import(` | 禁止加载任何模块 |
| `process`、`globalThis` | 禁止触碰宿主进程与全局逃逸 |
| `child_process`、`fs` | 禁止起进程、读写文件 |
| `net`、`http`、`https`、`fetch(`、`XMLHttpRequest`、`WebSocket` | 禁止任何外部请求 |
| `eval(`、`new Function`、`Function(` | 禁止动态生成代码 |
| `__proto__`、`constructor[` | 禁止原型链逃逸 |
| `while(true)`、`setInterval(` | 禁止死循环 / 无限定时器 |

扫描前会**忽略注释**（注释内的词不计入命中），命中会报出**文件与行号**。

> 解析器 PR 需要**人工逐行复核**；运行期约束见第 3 节。

---

## 3. 运行约束（沙箱）

解析器在**受限子进程**中执行，与主进程隔离，不在主进程内直接 `import`：

| 约束项 | 取值方式 | 说明 |
| --- | --- | --- |
| 权限模型 | `node --permission` | Node 24 的权限系统 |
| 文件读取 | `--allow-fs-read=<系统目录>` | 只读白名单，只放开 `presets/systems/<id>/` |
| 文件写入 | ❌ 拒绝 | 不传 `--allow-fs-write` |
| 子进程 | ❌ 拒绝 | 不传 `--allow-child-process` |
| worker_threads | ❌ 拒绝 | 不传 `--allow-worker` |
| 原生插件 | ❌ 拒绝 | 不传 `--allow-addons` |
| 动态代码生成 | ❌ 拒绝 | `--disallow-code-generation-from-strings` |
| 内存 | 堆上限 | `--max-old-space-size` |
| 墙钟超时 | 上限 | `execFile` 的 `timeout` |
| 环境变量 | 白名单 | 只传 `PATH`/`SystemRoot`/`windir`/`TEMP`/`TMP`/`LANG`/`LC_ALL` |

所有失败（越权、超时、OOM、语法错误、返回结构不对）都会被转成结构化错误：

```json
{ "ok": false, "error": { "code": "SANDBOX_PERMISSION_DENIED", "message": "…", "stage": "parse" } }
```

异常不会逃逸到父进程。

---

## 4. 怎么写一个解析器

参考最小可运行示例 **[../presets/systems/jwglxt/parse.js](../presets/systems/jwglxt/parse.js)**，
它从正方课表页的 `kbtable` 里抓 `id="1-2"` 形式的格子：

```js
export function parse({ html, url, hints }) {
  const events = [];
  const cellRe = /<td\b[^>]*\bid\s*=\s*["']\s*(\d{1,2})\s*[-_]\s*(\d{1,2})\s*["'][^>]*>([\s\S]*?)<\/td>/gi;
  let match = cellRe.exec(html);
  while (match !== null) {
    // 行 n → 第 2n-1 ~ 2n 节；列 m → 星期 m
    events.push({ title, dayOfWeek: Number(match[2]), periodStart: Number(match[1]) * 2 - 1, periodEnd: Number(match[1]) * 2 });
    match = cellRe.exec(html);
  }
  return { events };
}
```

### 实用建议

- **只用正则和字符串处理**（沙箱里没有 DOM，也拿不到任何库）。
- 循环务必有界：`while (match !== null)` + `re.exec` 会自然收敛；不要写 `while (true)`。
- `hints` 里可能带着 `presets/systems/<id>/meta.json` 的 `detect` 提示，优先用它，别硬编码。
- 单个格子里多条课程（换行分隔）需自行切分。
- 数量级目标：1000 行以内的 HTML 应在几十毫秒内解析完。

### 必须附带夹具（硬规则）

只要 `presets/systems/<id>/parse.js` 存在，同目录的 `fixtures/` 就**必须**至少包含：

1. 页面样本：`sample-page.html`（脱敏后的真实课表页）；
2. 期望事件：`expected-events.json`：

```json
{
  "id": "jwglxt-sample-page",
  "system": "jwglxt",
  "school": "usts",
  "adapter": "parse.js",
  "fixtures": { "page": "sample-page.html", "events": "expected-events.json" },
  "input": { "url": "https://jwgl.usts.edu.cn/jwglxt/xskb/query", "hints": {} },
  "expect": {
    "minEvents": 2,
    "events": [
      { "title": "高等数学", "dayOfWeek": 2, "periodStart": 1, "periodEnd": 2, "room": "A101", "teacher": "张伟", "weeks": [] },
      { "title": "大学英语", "dayOfWeek": 4, "periodStart": 1, "periodEnd": 2, "room": "B203", "teacher": "李娜", "weeks": [] },
      { "title": "线性代数", "dayOfWeek": 3, "periodStart": 3, "periodEnd": 4, "room": "C305", "teacher": "王强", "weeks": [] }
    ]
  }
}
```

- `fixtures/` 缺失或为空 → **`npm run validate` 直接失败**（这是本次结构调整的主要收益）；
- `npm run validate` 会在沙箱里用 `sample-page.html` 真跑一遍 `parse.js`，产出事件必须与
  `expected-events.json` 里的 `expect.events` **逐条一致**；`expect.minEvents` 是最低条数门槛；
- `expect.events` 是给人看的完整期望，也是沙箱逐条比对的基准；
- HTML 请**脱敏**：删掉学号、姓名、Cookie、真实 token，只保留结构。

### 本地自查

```bash
npm run validate      # 含静态扫描 + 沙箱冒烟
npm test              # 单元测试
npm run sandbox:demo  # 看沙箱如何拦截越权/死循环解析器
```

想手动跑一个解析器：

```bash
node --permission --disallow-code-generation-from-strings \
     --allow-fs-read=presets/systems/jwglxt \
     scripts/sandbox-run.mjs --sandbox-child presets/systems/jwglxt/parse.js \
  <<< '{"html":"<table id=\"kbtable\"><tr><td id=\"1-2\">高数<br>张伟 老师<br>A101</td></tr></table>","url":"https://jwgl.usts.edu.cn/","hints":{}}'
```
