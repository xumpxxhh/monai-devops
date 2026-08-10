// 零依赖的极简 YAML Front Matter 解析器。
// 只处理本 skill 模板里用到的结构：顶层 "key: value" 标量字段，
// 以及形如 "key:\n  - item" 的顶层列表字段（如 anchors/tags）。
// 不追求通用 YAML 兼容，够用即可，避免引入外部依赖。

import fs from "node:fs";

/**
 * 从 markdown 文本中提取 "---\n...\n---" 之间的 Front Matter 原始文本。
 * @param {string} content
 * @returns {string|null}
 */
export function extractFrontMatterBlock(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return match ? match[1] : null;
}

/**
 * 解析 Front Matter 文本为一个浅层对象。
 * 标量字段：{ key: "value" }
 * 列表字段：{ key: ["a", "b"] }
 * @param {string} raw
 * @returns {Record<string, string | string[]>}
 */
export function parseFrontMatter(raw) {
  const result = {};
  const lines = raw.split(/\r?\n/);
  let currentListKey = null;

  for (const line of lines) {
    if (/^\s*#/.test(line) || line.trim() === "") continue;

    const listItemMatch = line.match(/^\s+-\s*(.+)$/);
    if (listItemMatch && currentListKey) {
      const value = stripInlineComment(listItemMatch[1]).trim();
      (result[currentListKey] ||= []).push(value);
      continue;
    }

    const kvMatch = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (kvMatch) {
      const [, key, rawValue] = kvMatch;
      const value = stripInlineComment(rawValue).trim();
      if (value === "") {
        // 形如 "anchors:" 后面跟列表项
        currentListKey = key;
        result[key] = result[key] || [];
      } else {
        currentListKey = null;
        result[key] = unquote(value);
      }
      continue;
    }

    currentListKey = null;
  }

  return result;
}

function stripInlineComment(value) {
  const idx = value.indexOf(" #");
  return idx >= 0 ? value.slice(0, idx) : value;
}

function unquote(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * 读取单个知识文件，返回解析后的 Front Matter（附带 filePath）。
 * 解析失败（无 Front Matter）返回 null。
 * @param {string} filePath
 */
export function readKnowledgeFile(filePath) {
  const content = fs.readFileSync(filePath, "utf8");
  const block = extractFrontMatterBlock(content);
  if (!block) return null;
  const meta = parseFrontMatter(block);
  return { filePath, meta };
}

/**
 * 递归收集目录下所有 .md 文件路径。
 * @param {string} dir
 * @param {(filePath: string) => boolean} [filter]
 */
export function collectMarkdownFiles(dir, filter) {
  const results = [];
  if (!fs.existsSync(dir)) return results;

  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = `${current}/${entry.name}`;
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        if (!filter || filter(fullPath)) results.push(fullPath);
      }
    }
  }
  return results;
}

/**
 * 解析 "YYYY-MM-DD HH:MM:SS" 或 "YYYY-MM-DD" 为 Date，失败返回 null。
 * @param {string|undefined} value
 */
export function parseDate(value) {
  if (!value) return null;
  const normalized = value.includes(" ") ? value.replace(" ", "T") : `${value}T00:00:00`;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function daysBetween(a, b) {
  return Math.floor((b.getTime() - a.getTime()) / (24 * 60 * 60 * 1000));
}
