#!/usr/bin/env node
// 扫描所有 status=OFFICIAL 的知识文件，找出 lastVerifiedAt（缺失则回退 updatedAt）
// 超过阈值天数未验证的条目，防止知识悄悄过期却无人发现。
//
// 用法（项目内脚本应放在 knowledge/scripts/）：
//   node knowledge/scripts/check-knowledge-freshness.mjs [--dir knowledge] [--days 90] [--strict]

import { collectMarkdownFiles, readKnowledgeFile, parseDate, daysBetween } from "./lib-frontmatter.mjs";

const args = parseArgs(process.argv.slice(2));
const dir = args.dir || "knowledge";
const thresholdDays = Number(args.days || 90);
const strict = args.strict === true;

const files = collectMarkdownFiles(dir, (p) => {
  if (p.includes(`${dir}/template/`)) return false;
  if (p.includes(`${dir}/scripts/`)) return false;
  return true;
});
const now = new Date();
const stale = [];
const missingDate = [];

for (const filePath of files) {
  const parsed = readKnowledgeFile(filePath);
  if (!parsed) continue;
  const { meta } = parsed;
  if (meta.status !== "OFFICIAL") continue; // 只关心已进入正式库的知识

  const verifiedAt = parseDate(meta.lastVerifiedAt) || parseDate(meta.updatedAt);
  if (!verifiedAt) {
    missingDate.push(filePath);
    continue;
  }

  const age = daysBetween(verifiedAt, now);
  if (age > thresholdDays) {
    stale.push({ filePath, id: meta.id, age });
  }
}

stale.sort((a, b) => b.age - a.age);

console.log(`\n知识新鲜度检查：目录=${dir}，阈值=${thresholdDays} 天（仅检查 status=OFFICIAL）`);
console.log(`扫描文件数：${files.length}，可能过期：${stale.length}\n`);

if (stale.length > 0) {
  console.log("以下 official 知识距最近一次验证已超过阈值，建议回代码核对并更新 lastVerifiedAt：");
  for (const item of stale) {
    console.log(`  - [${item.age} 天未验证] ${item.filePath}  id=${item.id || "?"}`);
  }
}

if (missingDate.length > 0) {
  console.log("\n以下 official 知识缺少 lastVerifiedAt/updatedAt，无法判断新鲜度，建议补全：");
  for (const filePath of missingDate) {
    console.log(`  - ${filePath}`);
  }
}

if (strict && (stale.length > 0 || missingDate.length > 0)) {
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
