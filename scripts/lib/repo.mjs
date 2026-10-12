/**
 * repo.mjs —— 读取**新作者结构**（合并后的 school.json / system.json）。
 *
 * 合并后的目录布局（方案 A + 统一套一层目录）：
 *
 *   presets/schools/<dir>/school.json    身份 + 作息 + 对系统的覆盖（原 meta + timetable + config）
 *   presets/schools/<dir>/parse.js       可选：**学校级**解析器（优先级高于系统级）
 *   presets/schools/<dir>/fixtures/      有 parse.js 就必须非空（硬规则）
 *   presets/systems/<id>/system.json     元数据 + 识别特征 + 登录入口（原 meta + login）
 *   presets/systems/<id>/parse.js        可选：**系统级**解析器
 *   presets/systems/<id>/fixtures/
 *
 * 本模块只负责「读文件 + 取字段 + 排序」，不做任何校验（校验在 validate.mjs），
 * 也不做任何旧格式编译（编译在 lib/legacy.mjs，用于保持分发哈希不变）。
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/** school.json 里「覆盖」语义的键（原 config.json 的键白名单）。 */
export const SCHOOL_OVERRIDE_KEYS = ['system', 'login', 'params', 'detect'];

/** 学校身份字段（school.json 顶层允许出现的「非覆盖」键）。 */
export const SCHOOL_IDENTITY_KEYS = [
  'id', 'name', 'shortName', 'region', 'province', 'city', 'tags', 'type', 'system', 'aliases', 'generic',
];

/** school.json 顶层允许出现的全部键（身份 + 覆盖 + timetable）。 */
export const SCHOOL_TOP_KEYS = [
  'id', 'name', 'shortName', 'region', 'province', 'city', 'tags', 'type',
  'system', 'aliases', 'generic', 'login', 'params', 'detect', 'timetable',
];

/** 相对仓库根的 POSIX 路径。 */
export function repoRel(root, file) {
  return relative(root, file).split(sep).join('/');
}

/** 列出目录下的子目录名（排序）。 */
export function listDirs(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => statSync(join(dir, name)).isDirectory())
    .sort();
}

/** 列出目录下的文件名（排序）。 */
export function listFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => statSync(join(dir, name)).isFile())
    .sort();
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

/** 稳定排序：按 id 升序。 */
function byId(left, right) {
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

/**
 * 读取一个学校目录。
 * @returns {object} 学校定义（school.json 的键 + 目录/路径信息）
 */
export function readSchool(root, dirName) {
  const dir = join(root, 'presets', 'schools', dirName);
  const schoolJsonPath = join(dir, 'school.json');
  const parserPath = join(dir, 'parse.js');
  const fixturesDir = join(dir, 'fixtures');
  const doc = existsSync(schoolJsonPath) ? readJson(schoolJsonPath) : undefined;
  return {
    dirName,
    dir,
    doc,
    path: repoRel(root, schoolJsonPath),
    fullPath: schoolJsonPath,
    parserFile: existsSync(parserPath) ? parserPath : undefined,
    parserPath: existsSync(parserPath) ? repoRel(root, parserPath) : undefined,
    fixturesDir,
    fixtureFiles: existsSync(fixturesDir) ? listFiles(fixturesDir).map((name) => join(fixturesDir, name)) : [],
  };
}

/** 读取全部学校目录（按目录名排序，与旧行为一致）。 */
export function readSchools(root) {
  return listDirs(join(root, 'presets', 'schools')).map((dirName) => readSchool(root, dirName));
}

/**
 * 读取一个系统目录。
 * @returns {object} 系统定义（system.json 的键 + 目录/路径信息）
 */
export function readSystem(root, id) {
  const dir = join(root, 'presets', 'systems', id);
  const systemJsonPath = join(dir, 'system.json');
  const parserPath = join(dir, 'parse.js');
  const fixturesDir = join(dir, 'fixtures');
  const doc = existsSync(systemJsonPath) ? readJson(systemJsonPath) : undefined;
  return {
    id,
    dir,
    doc,
    path: repoRel(root, systemJsonPath),
    fullPath: systemJsonPath,
    parserFile: existsSync(parserPath) ? parserPath : undefined,
    parserPath: existsSync(parserPath) ? repoRel(root, parserPath) : undefined,
    fixturesDir,
    fixtureFiles: existsSync(fixturesDir) ? listFiles(fixturesDir).map((name) => join(fixturesDir, name)) : [],
  };
}

/** 读取全部系统目录。 */
export function readSystems(root) {
  return listDirs(join(root, 'presets', 'systems')).map((id) => readSystem(root, id));
}

/**
 * 学校的**有效** system 引用：合并后 school.json 顶层只有一个 `system` 键，
 * 语义是「该校实际使用的教务系统 id」（等价于原 meta.system，覆盖了原 config.system）。
 */
export function schoolSystem(doc) {
  return doc?.system ?? null;
}

/** 学生生效的登录覆盖（school.json 的 login 键）。 */
export function schoolLoginOverride(doc) {
  return doc?.login ?? {};
}

/** 生成 `presets/index.json` 的内容（现在内嵌进快照的 `index` 字段）。 */
export function buildIndex({ schools, systems, versionData, generatedAt }) {
  const schoolEntries = schools
    .map((school) => {
      const doc = school.doc ?? {};
      const system = schoolSystem(doc);
      return {
        id: doc.id,
        name: doc.name,
        ...(doc.region === undefined ? {} : { region: doc.region }),
        ...(doc.type === undefined ? {} : { type: doc.type }),
        system: system ?? null,
        aliases: doc.aliases ?? [],
        generic: doc.generic === true,
        default: doc.generic === true,
        // configPath：合并后「覆盖配置」就是 school.json 自身（键名保留，避免消费方 breaking）。
        configPath: school.path,
        timetablePath: school.path,
      };
    })
    .sort(byId);

  const systemEntries = systems
    .map((system) => {
      const doc = system.doc ?? {};
      return {
        id: doc.id,
        name: doc.name,
        ...(doc.version === undefined ? {} : { version: doc.version }),
        aliases: doc.aliases ?? [],
        hasParser: system.parserFile !== undefined,
        ...(system.parserFile === undefined ? {} : { parserPath: system.parserPath }),
        metaPath: system.path,
        loginPath: system.path,
        detect: doc.detect,
        entryPath: doc.login?.entryPath,
        hint: doc.login?.hint,
      };
    })
    .sort(byId);

  return {
    _generated: true,
    version: versionData.version,
    schemaVersion: versionData.schemaVersion,
    generatedAt,
    schools: schoolEntries,
    systems: systemEntries,
  };
}
