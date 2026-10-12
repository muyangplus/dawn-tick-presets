/**
 * schema.mjs —— 零依赖 JSON Schema 子集校验器
 *
 * 支持的关键字：
 *   type / required / properties / additionalProperties / items
 *   enum / const / pattern / minLength / maxLength
 *   minItems / maxItems / uniqueItems / minimum / maximum
 *   $ref（仅支持 "#/$defs/<name>" 形式，用于本文件内的定义复用）
 *
 * 不支持（故意不实现，够用即可）：allOf/anyOf/oneOf/not、if-then-else、
 * patternProperties、dependencies、format 断言。若后续需要，请在此文件补齐，
 * 而不是引入第三方库。
 *
 * 设计要点：
 *   - 纯函数，无 IO，可被 validate.mjs / 测试直接调用；
 *   - 返回错误数组（每条含人类可读中文说明与 JSON 路径），不抛异常；
 *   - 只报告错误，不做类型强制转换（strict）。
 */

/** JSON 值的类型名（用于 type 关键字比较）。 */
function jsonTypeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}

function typeMatches(value, expected) {
  const actual = jsonTypeOf(value);
  if (expected === 'number') return actual === 'number' || actual === 'integer';
  if (expected === 'integer') return actual === 'integer';
  return actual === expected;
}

/** 把 JSON 路径数组渲染成 a.b[0].c 形式。 */
export function formatPath(path) {
  if (path.length === 0) return '<root>';
  let out = '';
  for (const segment of path) {
    if (typeof segment === 'number') out += `[${segment}]`;
    else if (out === '') out = segment;
    else out += `.${segment}`;
  }
  return out;
}

function describe(value) {
  const type = jsonTypeOf(value);
  if (type === 'string') {
    const text = value.length > 40 ? `${value.slice(0, 40)}…` : value;
    return `字符串 "${text}"`;
  }
  if (type === 'array') return `数组（${value.length} 项）`;
  if (type === 'object') return `对象（键：${Object.keys(value).join(', ') || '无'}）`;
  return `${type} ${String(value)}`;
}

function resolveRef(ref, rootSchema) {
  const match = /^#\/(\$defs|[A-Za-z0-9_]+)(?:\/(.+))?$/.exec(ref);
  if (!match) return undefined;
  let node = rootSchema?.[match[1]];
  if (node === undefined) return undefined;
  if (match[2] !== undefined) {
    for (const part of match[2].split('/')) {
      if (node === null || typeof node !== 'object') return undefined;
      node = node[part];
    }
  }
  return node;
}

/**
 * 校验一个 JSON 值。
 * @param {unknown} value 待校验的值
 * @param {object} schema JSON Schema（draft 2020-12 的受支持子集）
 * @param {{ rootSchema?: object, path?: Array<string|number> }} [options]
 * @returns {Array<{ path: string, message: string }>} 错误列表，空数组表示通过
 */
export function validateSchema(value, schema, options = {}) {
  const rootSchema = options.rootSchema ?? schema;
  const errors = [];
  walk(value, schema, rootSchema, options.path ?? [], errors);
  return errors;
}

function walk(value, schema, rootSchema, path, errors) {
  if (schema === undefined || schema === null || typeof schema !== 'object') return;

  if (typeof schema.$ref === 'string') {
    const target = resolveRef(schema.$ref, rootSchema);
    if (target === undefined) {
      errors.push({ path: formatPath(path), message: `内部错误：无法解析 $ref ${schema.$ref}` });
      return;
    }
    walk(value, target, rootSchema, path, errors);
    return;
  }

  const where = formatPath(path);

  if (schema.type !== undefined) {
    const expected = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!expected.some((item) => typeMatches(value, item))) {
      errors.push({
        path: where,
        message: `类型应为 ${expected.join(' 或 ')}，实际是 ${jsonTypeOf(value)}（${describe(value)}）`,
      });
      return; // 类型不符时后续关键字无意义，避免连锁噪声
    }
  }

  if (schema.const !== undefined && value !== schema.const) {
    errors.push({ path: where, message: `必须恒等于 ${JSON.stringify(schema.const)}` });
  }

  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    errors.push({
      path: where,
      message: `取值必须是 ${schema.enum.map((item) => JSON.stringify(item)).join(' / ')} 之一，实际是 ${JSON.stringify(value)}`,
    });
  }

  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
      errors.push({ path: where, message: `字符串长度至少 ${schema.minLength}，实际 ${value.length}` });
    }
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
      errors.push({ path: where, message: `字符串长度最多 ${schema.maxLength}，实际 ${value.length}` });
    }
    if (typeof schema.pattern === 'string') {
      let re;
      try {
        re = new RegExp(schema.pattern);
      } catch (error) {
        errors.push({ path: where, message: `schema 自身 pattern 非法（${schema.pattern}）：${error.message}` });
        re = undefined;
      }
      if (re !== undefined && !re.test(value)) {
        errors.push({
          path: where,
          message: `不匹配模式 /${schema.pattern}/，实际值 ${JSON.stringify(value)}`,
        });
      }
    }
  }

  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      errors.push({ path: where, message: `数值不能小于 ${schema.minimum}，实际 ${value}` });
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      errors.push({ path: where, message: `数值不能大于 ${schema.maximum}，实际 ${value}` });
    }
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
      errors.push({ path: where, message: `数组项数至少 ${schema.minItems}，实际 ${value.length}` });
    }
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
      errors.push({ path: where, message: `数组项数最多 ${schema.maxItems}，实际 ${value.length}` });
    }
    if (schema.uniqueItems === true) {
      const seen = new Set();
      value.forEach((item, index) => {
        const key = JSON.stringify(item);
        if (seen.has(key)) {
          errors.push({ path: formatPath([...path, index]), message: `数组项重复：${key}` });
        }
        seen.add(key);
      });
    }
    if (schema.items !== undefined) {
      value.forEach((item, index) => {
        walk(item, schema.items, rootSchema, [...path, index], errors);
      });
    }
  }

  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const keys = Object.keys(value);
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) {
          errors.push({ path: formatPath([...path, key]), message: `缺少必填字段 "${key}"` });
        }
      }
    }
    const properties = schema.properties ?? {};
    for (const key of keys) {
      const childSchema = properties[key];
      if (childSchema !== undefined) {
        walk(value[key], childSchema, rootSchema, [...path, key], errors);
        continue;
      }
      if (schema.additionalProperties === false) {
        errors.push({
          path: formatPath([...path, key]),
          message: `不允许的额外字段 "${key}"（可用字段：${Object.keys(properties).join(', ') || '无'}）`,
        });
      } else if (schema.additionalProperties !== undefined && typeof schema.additionalProperties === 'object') {
        walk(value[key], schema.additionalProperties, rootSchema, [...path, key], errors);
      }
    }
  }
}
