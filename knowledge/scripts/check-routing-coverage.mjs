#!/usr/bin/env node
// 校验：所有正式/候选知识文件的 anchors 是否已在 ROUTING.md 中登记，
// 防止 ROUTING 表随知识增长逐渐失真（写了知识忘了更新路由）。
//
// 用法（项目内脚本应放在 knowledge/scripts/）：
//   node knowledge/scripts/check-routing-coverage.mjs [--knowledge-dir knowledge] [--routing-file knowledge/ROUTING.md] [--strict]

import fs from "node:fs";
import { collectMarkdownFiles, readKnowledgeFile } from "./lib-frontmatter.mjs";

const args = parseArgs(process.argv.slice(2));
const knowledgeDir = args["knowledge-dir"] || "knowledge";
const routingFile = args["routing-file"] || `${knowledgeDir}/ROUTING.md`;
const strict = args.strict === true;

if (!fs.existsSync(routingFile)) {
  console.error(`未找到 ROUTING 文件：${routingFile}`);
  process.exitCode = 1;
  process.exit();
}

const routingText = fs.readFileSync(routingFile, "utf8");

// 排除 template/ 下的模板文件（占位符不需要被路由覆盖）以及元文件本身
const excludedPaths = new Set([
  routingFile,
  `${knowledgeDir}/INDEX.md`,
  `${knowledgeDir}/README.md`,
  `${knowledgeDir}/KNOWLEDGE-RULES.md`,
]);

const files = collectMarkdownFiles(knowledgeDir, (p) => {
  if (excludedPaths.has(p)) return false;
  if (p.includes(`${knowledgeDir}/template/`)) return false;
  if (p.includes(`${knowledgeDir}/scripts/`)) return false;
  return true;
});

const uncovered = [];
let anchorCount = 0;

for (const filePath of files) {
  const parsed = readKnowledgeFile(filePath);
  if (!parsed) continue;
  const anchors = parsed.meta.anchors;
  if (!anchors || anchors.length === 0) continue;

  for (const anchor of anchors) {
    anchorCount++;
    if (!routingText.includes(anchor)) {
      uncovered.push({ filePath, anchor });
    }
  }
}

console.log(`\nROUTING 覆盖率检查：知识目录=${knowledgeDir}，路由文件=${routingFile}`);
console.log(`扫描文件数：${files.length}，锚点总数：${anchorCount}，未登记锚点：${uncovered.length}\n`);

if (uncovered.length > 0) {
  console.log("以下锚点未在 ROUTING.md 中出现，建议补充对应路由条目：");
  for (const item of uncovered) {
    console.log(`  - ${item.anchor}  (来自 ${item.filePath})`);
  }
}

if (strict && uncovered.length > 0) {
  process.exitCode = 1;
}

function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--strict") {
      result.strict = true;
    } else if (token.startsWith("--")) {
      const key = token.slice(2);
      result[key] = argv[i + 1];
      i++;
    }
  }
  return result;
}
