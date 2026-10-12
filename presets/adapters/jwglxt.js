/**
 * jwglxt.js —— 正方教务课表适配器（最小可运行示例）
 *
 * 契约（详见 presets/adapters/README.md）：
 *   - 唯一导出：export function parse({ html, url, hints })
 *   - 输入只读，禁止任何 IO / 网络 / 动态求值
 *   - 必须纯函数式返回：{ events: [{ title, dayOfWeek, periodStart, periodEnd, room, teacher, weeks }] }
 *
 * 本示例只做最小实现：从正方课表页的 kbtable 里抓取形如 id="1-2" 的格子，
 * 产出 1-2 条事件用于演示。生产级适配器请自行补齐周次解析、多时段合并等逻辑。
 */

/** 从一段 HTML 里剥掉标签，返回纯文本（用于格子内容）。 */
function stripTags(fragment) {
  return fragment
    .replace(/<br\s*\/?>/gi, '\u0001')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .trim();
}

/**
 * 按格子 id 提取事件。正方 kbtable 的格子 id 形如 "行-列"：
 *   行 1..N 对应「第 2*行-1 节 ~ 第 2*行 节」，列 1..7 对应星期一到星期日。
 */
function collectCells(html) {
  const events = [];
  const cellRe = /<td\b[^>]*\bid\s*=\s*["']\s*(\d{1,2})\s*[-_]\s*(\d{1,2})\s*["'][^>]*>([\s\S]*?)<\/td>/gi;
  let match = cellRe.exec(html);
  while (match !== null) {
    const row = Number(match[1]);
    const dayOfWeek = Number(match[2]);
    const text = stripTags(match[3]);
    if (text !== '' && dayOfWeek >= 1 && dayOfWeek <= 7 && row >= 1) {
      events.push({ dayOfWeek, periodStart: row * 2 - 1, periodEnd: row * 2, text });
    }
    match = cellRe.exec(html);
  }
  return events;
}

/** 把单元格文本拆成标题 / 教师 / 教室。 */
function splitCellText(text) {
  const parts = text.split('\u0001').map((part) => part.trim()).filter((part) => part !== '');
  const title = parts[0] ?? '';
  let teacher;
  let room;
  for (const part of parts.slice(1)) {
    const teacherMatch = /^(.+?)\s*老师$/.exec(part);
    if (teacherMatch !== null) {
      teacher = teacherMatch[1];
      continue;
    }
    const roomMatch = /^([A-Za-z]?\d{2,4}(?:[-号]?\d{0,4})?)$/.exec(part);
    if (roomMatch !== null) {
      room = part;
      continue;
    }
    room = room ?? part;
  }
  return { title, teacher, room };
}

/**
 * @param {{ html: string, url: string, hints: object }} input
 * @returns {{ events: Array<object> }}
 */
export function parse({ html, url, hints }) {
  const events = [];
  for (const cell of collectCells(html)) {
    const { title, teacher, room } = splitCellText(cell.text);
    if (title === '') continue;
    events.push({
      title,
      dayOfWeek: cell.dayOfWeek,
      periodStart: cell.periodStart,
      periodEnd: cell.periodEnd,
      room: room ?? '',
      teacher: teacher ?? '',
      weeks: [],
    });
  }
  if (Array.isArray(hints?.extraEvents)) {
    for (const extra of hints.extraEvents) events.push(extra);
  }
  if (url === undefined) return { events: [] };
  return { events };
}
