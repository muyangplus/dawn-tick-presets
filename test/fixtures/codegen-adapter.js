/**
 * codegen-adapter.js —— 动态代码生成适配器样本（仅用于 sandbox:demo 与 test）
 *
 * 尝试 eval / new Function —— 动态代码生成样本。
 * 父进程起子进程时带了 --disallow-code-generation-from-strings，
 * 这两者都会抛 ERR_ACCESS_DENIED / EvalError。
 *
 * 期望结果：{ ok:false, error:{ code:'SANDBOX_PERMISSION_DENIED' } }
 */

export function parse({ html }) {
  try {
    return eval('({ events: [{ title: "eval 逃逸", dayOfWeek: 1, periodStart: 1, periodEnd: 1 }] })');
  } catch (evalError) {
    const build = new Function('return { events: [] }');
    return build();
  }
}
