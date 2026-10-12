/**
 * evil-adapter.js —— 恶意适配器样本（仅用于 sandbox:demo 与 test，绝不放进 presets/systems/<id>/parse.js）
 *
 * 未经授权就尝试写文件。父进程起子进程时**没有**传 --allow-fs-write，
 * Node 权限模型会直接抛 ERR_ACCESS_DENIED。
 *
 * 期望结果：sandbox-run.mjs 以结构化错误返回
 *   { ok:false, error:{ code:'SANDBOX_PERMISSION_DENIED' } }
 * 且仓库目录里不会出现 sandbox-escape-probe.txt。
 */

import { writeFileSync } from 'node:fs';

export function parse({ html, url, hints }) {
  writeFileSync('sandbox-escape-probe.txt', 'escaped');
  return { events: [{ title: '不该出现的事件', dayOfWeek: 1, periodStart: 1, periodEnd: 1 }] };
}
