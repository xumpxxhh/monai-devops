#!/usr/bin/env node
// 扫描 knowledge/candidate/ 下的候选知识，找出超过 SLA 天数仍未 review（status 仍为
// PENDING_REVIEW）的条目，防止 candidate 变成没人处理的堆积区。
//
// 用法（项目内脚本应放在 knowledge/scripts/）：
//   node knowledge/scripts/check-candidate-sla.mjs [--dir knowledge/candidate] [--days 14] [--strict]
//
// --strict：存在逾期条目时以退出码 1 结束（用于接入 CI）。默认只打印报告，退出码 0。

import { collectMarkdownFiles, readKnowledgeFile, parseDate, daysBetween } from "./lib-frontmatter.mjs";

const args = parseArgs(process.argv.slice(2));
const dir = args.dir || "knowledge/candidate";
const thresholdDays = Number(args.days || 14);
const strict = args.strict === true;

const files = collectMarkdownFiles(dir, (p) => !p.endsWith("README.md"));
const now = new Date();
const overdue = [];
const skipped = [];

for (const filePath of files) {
  const parsed = readKnowledgeFile(filePath);
  if (!parsed) {
    skipped.push({ filePath, reason: "no front matter" });
    continue;
  }
  const { meta } = parsed;
  const status = meta.status || "PENDING_REVIEW";
  if (status !== "PENDING_REVIEW") continue; // 已 MERGED/REJECTED 的不算逾期

  const createdAt = parseDate(meta.createdAt);
  if (!createdAt) {
    skipped.push({ filePath, reason: "missing/invalid createdAt" });
    continue;
  }

  const age = daysBetween(createdAt, now);
  if (age > thresholdDays) {
    overdue.push({ filePath, id: meta.id, owner: meta.owner, age });
  }
}

overdue.sort((a, b) => b.age - a.age);

console.log(`\n候选知识 SLA 检查：目录=${dir}，阈值=${thresholdDays} 天`);
console.log(`扫描文件数：${files.length}，逾期未 review：${overdue.length}\n`);

if (overdue.length > 0) {
  console.log("逾期条目（按逾期天数降序）：");
  for (const item of overdue) {
    console.log(`  - [${item.age} 天] ${item.filePath}  id=${item.id || "?"}  owner=${item.owner || "?"}`);
  }
  console.log("\n处理建议：安排 owner review，确认合并进 official 或标记 REJECTED；不要让 candidate 无限堆积。");
}

if (skipped.length > 0) {
  console.log("\n以下文件缺少必要字段，未纳入统计（建议补全 Front Matter）：");
  for (const item of skipped) {
    console.log(`  - ${item.filePath}  (${item.reason})`);
  }
}

if (strict && overdue.length > 0) {
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
