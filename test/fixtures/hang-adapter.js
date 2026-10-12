/**
 * hang-adapter.js —— 死循环适配器样本（仅用于 sandbox:demo 与 test）
 *
 * 期望结果：父进程的 execFile timeout（5000ms）到点后杀掉子进程，
 * 返回结构化错误 { ok:false, error:{ code:'SANDBOX_TIMEOUT' } }。
 */

export function parse() {
  let spin = 0;
  for (;;) {
    spin += 1;
    if (spin === Number.MAX_SAFE_INTEGER) break;
  }
  return { events: [] };
}
