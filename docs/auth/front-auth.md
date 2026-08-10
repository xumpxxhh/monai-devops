# 前端应用用户系统集成设计

本文档说明**业务前端子应用**如何接入 Monai 统一认证体系。接入模型为：

- **统一认证页面**：独立前端，负责登录 / 注册 UI，与 Auth Service 交互
- **业务前端**：不实现登录页；启动时校验会话，未登录则跳转统一认证页；登录成功后携带授权码回跳并换 Cookie

适用于任意前端技术栈，重点描述职责划分与接入流程，不绑定具体框架。

---

## 1. 角色与职责

| 角色             | 职责                                                                                           |
| ---------------- | ---------------------------------------------------------------------------------------------- |
| **Auth Service** | 账号、SSO、签发 / 刷新 / 吊销 Token；通过 HttpOnly Cookie 维持会话                             |
| **统一认证页面** | 登录 / 注册表单；SSO 场景下把 `state` / `redirect_uri` 交给登录接口，成功后跳转 `redirect_url` |
| **业务前端**     | 启动鉴权、授权码换 Token、业务 API 调用与 401 刷新；**不自建登录页**                           |
| **业务后端**     | 校验 Token、业务授权与数据隔离                                                                 |

**核心原则：**

- 业务前端**不持有、不解析** Access Token（HttpOnly Cookie，JS 不可读）。
- Auth Service **只做用户身份**，不做角色 / RBAC；权限由业务侧自行实现。
- 业务前端与统一认证页面分离：前者只负责「要不要登录、登录后如何回来」，后者只负责「用户怎么输入账号密码」。

```
┌────────────────┐                      ┌──────────────────┐
│  业务前端子应用  │ ──未登录跳转──────► │  统一认证页面      │
│                │ ◄──redirect_url────── │  （登录 / 注册）   │
│  启动鉴权       │     ?code=...        │                  │
│  code 换 Cookie │                      └────────┬─────────┘
│  业务 API 调用  │                               │
└───────┬────────┘                               │ login / register
        │ credentials: include                   ▼
        │                              ┌──────────────────┐
        ├─────────────────────────────►│  Auth Service     │
        │  validate / refresh /        │  /api/v1/auth     │
        │  token-by-code / logout      └──────────────────┘
        ▼
┌────────────────┐
│  业务后端 API   │
└────────────────┘
```

---

## 2. 认证约定（集成方需知晓）

### 2.1 双 Token 与 Cookie

| Cookie          | 含义                | Path                   | 前端是否可读   |
| --------------- | ------------------- | ---------------------- | -------------- |
| `auth_token`    | Access Token（JWT） | `/`                    | 否（HttpOnly） |
| `refresh_token` | Refresh Token       | `/api/v1/auth/refresh` | 否（HttpOnly） |

属性一般为 `HttpOnly; Secure; SameSite=Lax`（本地开发可能无 Secure）。

前端**不要**把 Token 写入 `localStorage` / `sessionStorage` 作为长期凭证。仅允许把 SSO 流程临时数据（如 `redirect_uri`、`code_verifier`）放在 `sessionStorage`，用完即清。

### 2.2 业务前端主要调用的接口

认证服务 Base URL 示例：`http://localhost:8888/api/v1/auth`（生产由环境变量或网关配置）。

| 方法 | 路径             | 用途                                                   |
| ---- | ---------------- | ------------------------------------------------------ |
| GET  | `/request-login` | 获取统一认证页 URL，发起 SSO                           |
| POST | `/token-by-code` | 用回调 URL 中的 `code` 换 Cookie（无需 client_secret） |
| GET  | `/validate`      | 校验是否已登录                                         |
| POST | `/refresh`       | Access Token 过期后静默刷新                            |
| POST | `/logout`        | 登出                                                   |
| GET  | `/me`            | 可选，拉取展示用用户资料                               |

**`GET /validate` 成功响应示例**（无 role / 权限字段）：

```json
{
  "id": 2,
  "email": "user@example.com"
}
```

### 2.3 统一认证页面主要调用的接口

| 方法 | 路径        | 用途                                                       |
| ---- | ----------- | ---------------------------------------------------------- |
| POST | `/login`    | 邮箱密码登录；SSO 时带 `server_state`，返回 `redirect_url` |
| POST | `/register` | 注册                                                       |
| GET  | `/validate` | 进入页面时判断是否已登录                                   |
| POST | `/logout`   | 已登录态下退出                                             |

业务前端**不直接调用** `/login` / `/register`，这些只存在于统一认证页面。

---

## 3. 端到端 SSO 流程

这是业务子应用接入的主路径。

```
业务前端发现未登录
        │
        ▼
GET /request-login?client_id=...&redirect_uri=...&code_challenge=...
        │  响应 { "login_url": "https://认证页/?client_id=...&redirect_uri=...&state=..." }
        ▼
浏览器跳转到统一认证页面（login_url）
        │
        ▼
用户在统一认证页输入账号密码
POST /login { email, password, server_state, redirect_uri? }
        │  响应 { "redirect_url": "https://业务前端/?code=...&state=..." }
        ▼
统一认证页执行 location.href = redirect_url
        │
        ▼
业务前端启动，发现 URL 含 code
POST /token-by-code { client_id, code, redirect_uri, code_verifier }
        │  Set-Cookie: auth_token + refresh_token
        │  清理 URL 中的 code
        ▼
GET /validate → 进入业务主界面
```

要点：

- URL 中只出现一次性 `code`，**从不出现 Token**。
- `client_id` 须在认证中心注册，且 `redirect_uri` 合法。
- 建议使用 PKCE：发起登录时生成 `code_verifier` / `code_challenge`，换码时提交 `code_verifier`。

---

## 4. 统一认证页面行为

统一认证页是独立应用，业务子应用只需理解其约定，一般**不修改**该页。

### 4.1 入口参数

由 `request-login` 返回的 `login_url` 携带，典型 Query：

| 参数           | 说明                                                           |
| -------------- | -------------------------------------------------------------- |
| `client_id`    | 发起登录的业务应用 ID                                          |
| `redirect_uri` | 登录成功后要回跳的业务前端地址                                 |
| `state`        | 认证服务生成，约 10 分钟有效；登录时须作为 `server_state` 回传 |

### 4.2 登录提交

SSO 场景请求体需包含：

- `email`、`password`
- `server_state`（来自 URL 的 `state`）
- 可选：`redirect_uri`（与入口一致时更稳妥）

成功响应（SSO）：

```json
{
  "redirect_url": "https://业务前端地址?code=xxx&state=xxx"
}
```

页面收到后自行 `window.location.href = redirect_url`，**不做服务端 302**。

非 SSO（用户直接打开认证页）时，登录成功通常直接 Set-Cookie，不返回 `redirect_url`。

### 4.3 业务前端不要做的事

- 不要在业务应用内嵌登录表单去调 `/login`
- 不要自己拼认证页 URL 而绕过 `/request-login`（会丢失服务端 `state` 绑定）

---

## 5. 业务前端接入步骤

### 5.1 前置配置

| 配置项                 | 说明                                             |
| ---------------------- | ------------------------------------------------ |
| 认证 API Base URL      | 指向 `/api/v1/auth`                              |
| `client_id`            | 在认证中心注册的应用标识                         |
| 业务 API Base URL      | 本应用后端前缀                                   |
| 应用 Base Path（可选） | 子路径部署时，路由与 `redirect_uri` 须包含此前缀 |

`redirect_uri` 一般为当前业务页完整 URL（登录后回到原处）。若部署在子路径，须保证与认证中心登记的回调地址一致。

### 5.2 启动鉴权（必做）

在应用根入口执行一次，推荐顺序：

```
loading = true
  │
  ├─ URL 含 code？
  │     是 → POST /token-by-code
  │           成功后从地址栏移除 code
  │
  ├─ GET /validate
  │     成功 → 得到 user（id、email）
  │     失败 → POST /refresh → 再次 validate
  │
  ├─ 可选：异步 GET /me → userInfo（失败不阻断）
  │
  ├─ 仍失败 → request-login（跳转统一认证页）
  │
  └─ loading = false
        有 user → 渲染业务 UI
        无 user（即将跳转）→ 空白或轻提示，避免闪屏
```

**UI 状态：**

| 状态      | 表现                                                                 |
| --------- | -------------------------------------------------------------------- |
| `loading` | 「校验身份中…」，不渲染需登录的业务内容                              |
| 已登录    | 挂载路由；通过 Context / Store 注入 `user`、`logout`、`requestLogin` |
| 未登录    | 通常已触发跳转；根组件可返回 `null` 或占位，避免未鉴权内容闪现       |

### 5.3 发起登录（request-login）

未登录时：

1. 将当前 `redirect_uri` 写入 `sessionStorage`
2. 生成 PKCE：`code_verifier` 写入 `sessionStorage`，`code_challenge` 放入请求
3. `GET /request-login?client_id=...&redirect_uri=...&code_challenge=...`
4. 读取响应 `login_url`，`window.location.href = login_url`

不要在业务前端实现「自己的登录表单」。

### 5.4 授权码换 Token（token-by-code）

从 URL Query 取 `code`，与 `client_id`、sessionStorage 中的 `redirect_uri` / `code_verifier` 一并提交：

```json
{
  "client_id": "your-app-id",
  "code": "...",
  "redirect_uri": "...",
  "code_verifier": "..."
}
```

成功：响应头 Set-Cookie；body 通常为 `{ "status": "ok" }`。随后清理 URL 中的 `code`。

失败：提示登录链接失效，重新走 `request-login`。

### 5.5 登出

1. `POST /logout`（`credentials: 'include'`）
2. 清空内存中的 `user` / `userInfo`
3. 按产品选择：回到营销页，或再次 `request-login`

---

## 6. 业务 API 调用

### 6.1 携带凭证

访问业务后端与认证服务时一律：

- `credentials: 'include'`（axios 则为 `withCredentials: true`）
- **不要**手动拼 `Cookie` 或从 JS 读 Token

### 6.2 401 自动刷新

封装统一 HTTP 客户端：

```
请求业务 API
  │
  ├─ 非 401 → 返回
  └─ 401
        ├─ 已重试过 → 抛出 / 引导登录
        ├─ POST /refresh
        ├─ 成功 → 原请求重试一次
        └─ 失败 → 视为会话结束，request-login
```

多个并发 401 应**合并为一次 refresh**（共享 Promise），避免刷新风暴。

刷新只打认证服务 `/refresh`；业务接口刷新后仍 401，按业务错误处理，不要无限循环 refresh。

---

## 7. 会话状态模型

业务前端建议维护：

| 状态           | 来源                   | 用途                         |
| -------------- | ---------------------- | ---------------------------- |
| `user`         | `/validate`            | 是否登录、用户 id / email    |
| `userInfo`     | `/me`（可选）          | 个人中心等展示               |
| `loading`      | 启动鉴权               | 首屏守卫                     |
| `requestLogin` | 封装 request-login     | 手动「去登录」或会话失效重登 |
| `logout`       | `/logout` + 清本地状态 | 退出                         |

权限相关按钮的展示若依赖业务权限数据，应调业务接口；**不要**假设认证响应里有 `role`。

---

## 8. 部署与 Cookie

| 场景   | 建议                                                                                     |
| ------ | ---------------------------------------------------------------------------------------- |
| 开发   | 业务前端、统一认证页、Auth Service、业务 API 通过代理尽量同源，或明确 Cookie / CORS 限制 |
| 生产   | 优先同站路径分流：`/api/v1/auth`、业务 API、静态资源同一 host                            |
| 跨子域 | 需 Cookie `Domain` 与各方一致                                                            |
| HTTPS  | 生产启用 `Secure`                                                                        |

`redirect_uri`、统一认证页地址、业务前端地址须与认证中心客户端配置一致，否则 SSO 换码失败。

---

## 9. 错误与体验

| 场景                         | 处理                                            |
| ---------------------------- | ----------------------------------------------- |
| validate 失败                | 先 refresh，再 validate；仍失败则 request-login |
| token-by-code 失败           | 清理 code，重新 SSO                             |
| 业务 API 401（刷新后仍失败） | 会话失效，走登录                                |
| 业务 API 403 / 404           | 业务权限或资源问题，与未登录区分文案            |
| 网络错误                     | 可重试，避免误跳登录页                          |

不要在日志或埋点中输出 `code`、`code_verifier`。

---

## 10. 前端不应做的事

- 在业务应用内自建登录页并直调 `/login`（应走统一认证页）
- 绕过 `/request-login` 手写认证页 URL
- 把 Token 存入可被 JS 读取的存储
- 换码成功后不清理 URL 中的 `code`
- 每个页面各自实现一套 SSO / refresh
- 用认证服务字段做权限安全决策

---

## 11. 实现检查清单

**业务前端：**

- [ ] 已注册 `client_id` 与合法 `redirect_uri`
- [ ] 根入口完成：code 换 Token → validate →（失败）refresh →（仍失败）request-login
- [ ] 未登录跳转统一认证页，而非本地登录表单
- [ ] 换码后清除 URL 中的 `code`
- [ ] 业务请求 `credentials: 'include'`，并对 401 做「刷新 + 单次重试」（refresh 去重）
- [ ] 首屏 loading，避免未鉴权闪屏
- [ ] 登出调用 `/logout` 并清空本地会话状态

**统一认证页面（维护方）：**

- [ ] 从 URL 读取 `state` / `redirect_uri`，登录时提交 `server_state`
- [ ] SSO 成功后按 `redirect_url` 跳回业务前端
- [ ] 非 SSO 场景可直接完成 Cookie 登录

---

## 12. 扩展方向

| 需求            | 建议                                                     |
| --------------- | -------------------------------------------------------- |
| 多 Tab 同时 401 | refresh 单例锁                                           |
| 部分公开路由    | 白名单跳过启动鉴权；进入受保护区再校验                   |
| SSR             | 区分服务端与浏览器 Cookie；浏览器侧完成 validate / SSO   |
| 原生 App        | 通常改用 Bearer + 安全存储，与本文浏览器 Cookie 方案分支 |
| 回到前台        | 可主动 validate，失败再 refresh                          |

集成边界回顾：**统一认证页负责登录 UI；业务前端负责会话校验、回跳换码与业务请求；Auth Service 只回答「用户是谁」；权限与数据隔离归业务系统。**
