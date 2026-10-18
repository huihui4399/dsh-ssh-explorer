/**
 * 校验 profile 的 cordis.patch.yml 结构。
 *
 * 用 profile 自带的 `yaml` 包解析（`~/.dsh/profiles/desktop/node_modules/yaml`），
 * 确认整个文件仍是合法的顶层数组，并且里面有一条 id=ssh-explorer 的 insert 行。
 *
 * `!!js` 是 DSH 对 yaml 库的自定义 tag（值是 JS 表达式），标准解析器不认识，
 * 所以解析前先把它剥掉 —— 本脚本只做结构校验，不求值。
 *
 * 用法：node validate_patch.mjs <cordis.patch.yml 路径>
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const PROFILE_DIR = join(homedir(), ".dsh", "profiles", "desktop");
const require = createRequire(pathToFileURL(join(PROFILE_DIR, "package.json")).href);

let YAML;
try {
  YAML = require("yaml");
} catch (error) {
  console.log(`[skip] 取不到 profile 的 yaml 包：${error.message}`);
  process.exit(0);
}

const patchPath = process.argv[2];
if (!patchPath) {
  console.log("[FAIL] 用法：node validate_patch.mjs <cordis.patch.yml>");
  process.exit(1);
}

const text = readFileSync(patchPath, "utf8").replace(/!!js\s+/g, "");

let document;
try {
  document = YAML.parse(text);
} catch (error) {
  console.log(`[FAIL] YAML 解析失败：${error.message}`);
  process.exit(1);
}

if (!Array.isArray(document)) {
  console.log(`[FAIL] 顶层应为数组，实际是 ${typeof document}`);
  process.exit(1);
}

const inserts = document.filter((entry) => entry && typeof entry === "object" && entry.insert);
console.log(`[ok] YAML 解析通过：${document.length} 个顶层条目，其中 ${inserts.length} 个 insert`);

const mine = inserts.find((entry) => entry.insert.some((row) => row && row.id === "ssh-explorer"));
if (!mine) {
  console.log("[FAIL] 没找到 id=ssh-explorer 的 insert 行");
  process.exit(1);
}
console.log(`[ok] 本插件装载行：${JSON.stringify(mine.insert.find((row) => row.id === "ssh-explorer"))}`);
process.exit(0);
