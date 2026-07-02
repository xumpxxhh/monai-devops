# Git 历史敏感信息清理教程

本文档介绍如何从 Git 仓库中**彻底移除**已提交的敏感信息（API Key、密码、Token、私钥等），并安全地同步到远程。

> **适用场景**：敏感信息被误写入代码或配置文件，并已 `git push` 到远程。仅删除当前文件或新增一次提交**无法**从历史中抹掉这些内容，必须重写 Git 历史。

---

## 目录

1. [背景与原理](#背景与原理)
2. [前置准备](#前置准备)
3. [完整操作流程](#完整操作流程)
4. [推送远程](#推送远程)
5. [常见问题](#常见问题)
6. [清理后检查清单](#清理后检查清单)
7. [协作者同步指南](#协作者同步指南)

---

## 背景与原理

### 为什么普通提交不够？

Git 会永久保留每次提交的快照。即使你在最新版本里删掉了密钥，别人仍可通过以下方式看到：

```bash
git log -p                      # 查看历史 diff
git show <commit>:<文件路径>     # 查看某次提交中的文件内容
git clone                       # 克隆完整历史
```

### 正确思路

1. **源码**：从当前代码中彻底删除敏感信息（不要只注释掉，注释里仍可能残留密钥字符串）。
2. **历史**：用 `git filter-repo` 遍历所有 commit，批量删除或替换敏感内容。
3. **远程**：`force push` 覆盖远程历史。
4. **密钥**：**立即轮换（作废）已泄露的凭据**——清历史不能替代凭据轮换。

### 例子

假设 `src/config.ts` 中误写了数据库密码：

```typescript
// 错误：硬编码密码
export const dbConfig = {
  host: 'localhost',
  password: 'my-secret-password',
};
```

后续某次 commit 将其删除：

```typescript
export const dbConfig = {
  host: 'localhost',
};
```

此时最新代码里看似已处理，但**首次提交的快照中仍包含明文密码**，必须重写历史。

正确做法是整行删除，改从环境变量读取：

```typescript
export const dbConfig = {
  host: process.env.DB_HOST,
  password: process.env.DB_PASSWORD,
};
```

---

## 前置准备

### 1. 安装 git-filter-repo

```bash
pip install git-filter-repo # 若已有python环境
# 也可用其他方式安装
# brew install git-filter-repo
# sudo apt install git-filter-repo
```

验证：

```bash
git filter-repo --version
```

### 2. 确认仓库状态

```bash
git status          # 工作区尽量干净
git log --oneline -5
git remote -v
```

### 3. 通知协作者（如有）

历史重写会改变所有 commit 的 hash，其他人需要按 [协作者同步指南](#协作者同步指南) 重置本地分支。

### 4. 备份（可选但推荐）

```bash
git branch backup-before-secret-scrub
```

---

## 完整操作流程

### 第一步：从源码中删除敏感信息

**错误做法**——注释掉但仍保留密钥：

```python
# API_KEY = "sk-live-abc123xyz"  # 已删除
```

**正确做法**——整行删除，改用环境变量或密钥管理服务：

```python
import os

API_KEY = os.environ["API_KEY"]
```

环境变量示例（`.env`，且确保已在 `.gitignore` 中）：

```bash
API_KEY=你的新密钥
DB_PASSWORD=你的新密码
```

### 第二步：编写替换规则

在 `.git/replace-expressions.txt` 中定义替换规则（该文件位于 `.git` 目录，不会被提交）。

**按整行删除**（适合已知格式的配置行）：

```
regex:(?m)^\s*password: 'my-secret-password',\r?\n==>
regex:(?m)^\s*// password: 'my-secret-password',.*\r?\n==>
```

**按字面量替换**（适合密钥可能出现在多处、格式不固定时）：

```
literal:sk-live-abc123xyz==>REDACTED
```

说明：

| 部分           | 含义                             |
| -------------- | -------------------------------- |
| `(?m)`         | 多行模式，`^` / `$` 匹配行首行尾 |
| `\s*`          | 可选缩进空格                     |
| `\r?\n`        | 兼容 Windows / Unix 换行         |
| `==>` 右侧为空 | 删除匹配到的内容                 |
| `literal:`     | 精确匹配字符串并替换             |
| `regex:`       | 正则匹配并替换                   |

若有多种写法（明文、注释、单引号/双引号），每种各写一条规则。建议优先用「整行删除」，避免留下 `password: ''` 这类空壳行。

### 第三步：执行历史重写

在仓库根目录执行：

```bash
git filter-repo --replace-text .git/replace-expressions.txt --force
```

`--force` 是必须的：`filter-repo` 默认拒绝在已有远程的仓库上运行。

**执行后会发生什么：**

- 所有 commit 的 hash 都会改变
- 敏感内容从每个历史快照中移除
- `origin` **远程会被自动删除**（防止误推）
- 若某 commit 在清理后与父提交无差异，该 commit 可能被自动丢弃（例如仅「把密钥改成注释」的提交）

### 第四步：验证历史已清理干净

将 `YOUR_SECRET` 替换为实际要排查的字符串片段：

```bash
# 在当前工作区及历史提交中搜索
git grep 'YOUR_SECRET'

# 查看特定文件的历史
git log --oneline -- path/to/affected/file
git show <commit>:path/to/affected/file
```

确认输出中不再出现敏感字符串。

### 第五步：处理构建产物（如适用）

若项目有编译产物（如 `dist/`、`build/`），本地旧构建可能仍含敏感信息：

```bash
npm run build
# 或
pnpm build
# 或
make build
```

> 构建目录通常不入库，但本地磁盘上仍需重新生成，避免旧文件残留。

### 第六步：重新添加远程

`filter-repo` 会删除 `origin`，需手动加回：

```bash
git remote add origin https://github.com/<owner>/<repo>.git
```

---

## 推送远程

历史重写后，必须用 force push 覆盖远程。

### 推荐方式：force-with-lease

```bash
git fetch origin
git push --force-with-lease origin main
```

将 `main` 替换为实际分支名（如 `master`、`develop`）。

`--force-with-lease` 比 `--force` 更安全：仅当远程未被他人更新时才允许推送。

### 成功输出示例

```
To https://github.com/<owner>/<repo>.git
 + a1b2c3d...e4f5g6h main -> main (forced update)
```

---

## 常见问题

### 1. `stale info` 推送失败

```
! [rejected] main -> main (stale info)
error: failed to push some refs
```

**原因**：`filter-repo` 删除并重建 `origin` 后，本地没有 `origin/main` 跟踪分支，`--force-with-lease` 无法对比远程状态。

**解决**：

```bash
git fetch origin
git push --force-with-lease origin main
```

### 2. 某个 fix commit 消失了

若某个 commit **只**做了「注释掉密钥」这类修改，清理后它与父提交内容相同，会被 `filter-repo` 自动合并。这是预期行为，不影响最终代码正确性。

### 3. commit hash 全变了

历史重写后所有 hash 都会改变，PR、Issue、CI 配置里引用的旧 hash 会失效，属正常现象。

### 4. 能否用 BFG 或 git filter-branch？

| 工具                | 说明                                   |
| ------------------- | -------------------------------------- |
| `git filter-repo`   | **推荐**，官方维护，速度快，行为可预期 |
| BFG Repo-Cleaner    | 可用，适合简单字符串替换               |
| `git filter-branch` | 已废弃，不推荐                         |

### 5. 清理整个文件而非替换内容

若误提交了 `.env`、证书、私钥文件等，可直接从历史中移除该文件：

```bash
git filter-repo --path .env --invert-paths --force
```

### 6. 清理后仍担心泄露

以下途径**无法**通过 Git 历史清理完全消除：

- 他人已 clone 的本地副本
- GitHub/GitLab 缓存、Fork、镜像
- CI 日志、截图、聊天记录

因此**轮换凭据**始终是必要步骤，清历史只是降低后续暴露面。

---

## 清理后检查清单

- [ ] 源码中无硬编码敏感信息（含注释）
- [ ] `git grep` 在历史与工作区中搜不到敏感字符串
- [ ] 本地构建产物已重新生成（如适用）
- [ ] 已 `git fetch` + `git push --force-with-lease` 更新远程
- [ ] **已在服务商控制台轮换（作废）旧凭据**
- [ ] 新凭据配置在环境变量或密钥管理服务中
- [ ] `.env` 等敏感文件已在 `.gitignore` 中
- [ ] 已通知协作者重置本地分支

---

## 协作者同步指南

历史被 force push 后，其他开发者的本地分支会与远程分叉。**不要**直接 `git pull`，应执行：

```bash
git fetch origin
git checkout main
git reset --hard origin/main
```

若有未推送的本地改动，先暂存：

```bash
git stash
git fetch origin
git reset --hard origin/main
git stash pop   # 如有冲突需手动解决
```

---

## 流程总览

```
发现敏感信息已提交并推送
    │
    ▼
从源码彻底删除（不要只注释）
    │
    ▼
编写 .git/replace-expressions.txt
    │
    ▼
git filter-repo --replace-text ... --force
    │
    ▼
git grep / git show 验证无残留
    │
    ▼
重新构建本地产物（如需要）
    │
    ▼
git remote add origin <url>
    │
    ▼
git fetch origin
    │
    ▼
git push --force-with-lease origin <branch>
    │
    ▼
轮换旧凭据 + 通知协作者
```

---

## 参考

- [git-filter-repo 官方文档](https://github.com/newren/git-filter-repo)
- [GitHub: 从仓库删除敏感数据](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository)
- [GitLab: 从仓库历史中删除敏感文件](https://docs.gitlab.com/ee/user/project/merge_requests/revert_changes.html#redact-text-from-repository)
