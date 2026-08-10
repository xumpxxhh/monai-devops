# 后端应用用户系统集成设计

本文档说明业务后端如何接入 Monai 统一认证体系。适用于任意技术栈（Node、Go、Java、Python 等），重点描述**职责划分、鉴权流程与实现约定**，不绑定具体框架。

---

## 1. 角色与职责

Monai 采用**中心化认证 + 分布式校验**模型：

| 角色                            | 职责                                                          | 典型实现                                                    |
| ------------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------- |
| **认证服务（Auth Service）**    | 用户账号、登录、注册、SSO、签发/刷新/吊销 Token、用户资料查询 | 独立部署，默认 `http://localhost:8888`，前缀 `/api/v1/auth` |
| **业务后端（Resource Server）** | 校验 Access Token、解析用户身份、执行业务授权与数据隔离       | 各子应用自有 API 服务                                       |
| **前端（Client）**              | 引导登录、携带 Cookie 调 API、在 401 时触发 Token 刷新        | 浏览器 SPA / 原生客户端                                     |

**核心原则：**

- 业务后端不签发 Token，不维护登录态。
- 认证服务**只做用户身份**（是谁、是否已登录），**不做身份权限模型**（角色、RBAC、资源权限等由业务系统自行实现）。
- 业务后端在验证 Token 后确定「当前用户是谁」，再按自身规则做授权与数据隔离。

```
┌──────────────┐   登录 / SSO / 刷新   ┌─────────────────┐
│   前端应用    │ ◄──────────────────► │  Auth Service   │
│              │   Set-Cookie          │  （认证中心）    │
└──────┬───────┘   auth_token         └────────┬────────┘
       │                                        │
       │  业务 API 请求（携带 auth_token）         │ JWT_SECRET 一致
       ▼                                        │
┌──────────────┐   本地校验 JWT 或远程 validate    │
│  业务后端     │ ◄──────────────────────────────┘
│              │
└──────┬───────┘
       │  服务端间调用时透传 Token（如上传、代理）
       ▼
┌──────────────┐
│ 其他受保护服务 │
└──────────────┘
```

---

## 2. 认证服务约定（集成方需知晓）

以下内容为业务后端集成时的**前置知识**，集成时无需再查阅其他文档。

### 2.1 双 Token 机制

认证服务使用 **Access Token + Refresh Token**：

| Token         | 形态   | 存储位置                                            | 有效期（默认） | 用途                           |
| ------------- | ------ | --------------------------------------------------- | -------------- | ------------------------------ |
| Access Token  | JWT    | Cookie `auth_token`，Path=`/`                       | 2 小时         | 访问业务 API、上传等受保护接口 |
| Refresh Token | 随机串 | Cookie `refresh_token`，Path=`/api/v1/auth/refresh` | 7 天           | 仅用于换发新 Access Token      |

两个 Cookie 均为 `HttpOnly; Secure; SameSite=Lax`，前端 JavaScript 无法读取。

**正常请求：** 浏览器自动携带 `auth_token`，业务后端验证 JWT。

**Access Token 过期：** 业务后端返回 401 → 前端调用 `POST /api/v1/auth/refresh`（浏览器自动携带 `refresh_token`）→ 认证服务轮换两个 Cookie → 前端重试原请求。

**登出：** `POST /api/v1/auth/logout` 吊销 Refresh Token 并清除两个 Cookie。

### 2.2 Token 传递方式

认证服务支持两种携带方式（业务后端建议**至少实现 Cookie**，与浏览器场景一致）：

1. **Cookie**：`auth_token=<jwt>`（浏览器同域/跨域代理场景下的默认方式）
2. **请求头**：`Authorization: Bearer <jwt>`（适合移动端、CLI、服务间调用）

### 2.3 JWT Payload 与用户标识

Access Token 为 JWT，使用与认证服务共享的密钥签名。Payload 中用户 ID 可能出现在以下字段（集成时应按优先级兼容读取）：

- `user_id`
- `id`
- `sub`

解析结果须为**正整数**方可作为有效用户 ID。若签发方使用其他字段名（如 `UserID`），需在解析逻辑中显式兼容。

认证服务 `GET /api/v1/auth/validate` 校验成功时返回当前用户基本信息，**不含**角色或权限字段：

```json
{
  "id": 2,
  "email": "xx@xx.com"
}
```

该接口仅用于确认 Token 有效并获取用户标识；若业务需要角色、权限、租户等，应在**业务后端或独立权限服务**中维护与校验，不应依赖认证服务。

### 2.4 认证服务主要接口

| 方法 | 路径                         | 说明                                       |
| ---- | ---------------------------- | ------------------------------------------ |
| GET  | `/api/v1/auth/request-login` | SSO：获取登录页 URL                        |
| POST | `/api/v1/auth/login`         | 邮箱密码登录，下发 Cookie                  |
| POST | `/api/v1/auth/token-by-code` | 前端用授权码换 Token（无需 client_secret） |
| POST | `/api/v1/auth/token`         | 后端用授权码换 Token（需 client_secret）   |
| POST | `/api/v1/auth/refresh`       | 刷新 Access Token（Token 轮换）            |
| POST | `/api/v1/auth/logout`        | 登出                                       |
| GET  | `/api/v1/auth/validate`      | 校验 Token，返回 id、email 等用户基本信息  |
| GET  | `/api/v1/auth/me`            | 当前用户基本信息                           |
| POST | `/api/v1/auth/upload`        | 上传静态资源（需鉴权）                     |

认证服务错误响应统一为 JSON：`{ "code": "...", "message": "..." }`。常见 code：`UNAUTHORIZED`、`INVALID_TOKEN`、`INVALID_CREDENTIALS` 等。

### 2.5 SSO 简要流程

子应用未登录时：

1. 前端调用 `GET /api/v1/auth/request-login?client_id=...&redirect_uri=...`
2. 跳转认证中心登录页，登录成功后重定向回子应用并附带 `code`
3. 前端调用 `POST /api/v1/auth/token-by-code` 换取 Cookie
4. 此后业务 API 请求携带 `auth_token` 即可

有独立后端的服务端应用，可使用 `POST /api/v1/auth/token`（带 `client_secret`）完成换 Token。

---

## 3. 业务后端鉴权设计

### 3.1 推荐模式：本地 JWT 校验（无状态）

适用于高吞吐、低延迟场景。业务后端持有与认证服务相同的 `JWT_SECRET`，在请求入口中间件中完成校验。

**处理流程：**

```
请求进入
  │
  ├─ 1. 提取 Token
  │     优先从 Cookie（auth_token）读取；
  │     可选同时支持 Authorization: Bearer
  │
  ├─ 2. 缺失 Token → 401
  │
  ├─ 3. 使用 JWT_SECRET 验证签名与过期时间
  │     失败 → 401
  │
  ├─ 4. 从 Payload 解析用户 ID
  │     无效 → 401
  │
  ├─ 5. 写入请求上下文（如 currentUserId）
  │
  └─ 6. 进入业务处理
```

**优点：** 无额外网络开销，不依赖认证服务在线（仅校验密钥与 Token 有效期）。

**缺点：** 密钥轮换需多服务同步；Token 吊销在过期前无法感知（可接受短有效期 Access Token 弥补）。

### 3.2 备选模式：远程校验

每次请求调用 `GET /api/v1/auth/validate`，由认证服务返回用户信息。

**适用场景：** 不想分发 JWT 密钥、需要实时感知吊销、或校验逻辑集中在认证中心。

**缺点：** 多一次 RPC，认证服务成为强依赖；应配合超时、熔断与本地缓存（短 TTL）使用。

### 3.3 网关透传模式

API 网关在边缘完成 JWT 校验，向下游注入可信请求头（如 `X-User-Id`）。业务后端仅信任**内网链路**上的该头部。

**注意：** 公网直连的业务后端**不可**仅凭 `X-User-Id` 鉴权，否则可被伪造。此模式要求网络隔离或 mTLS。

---

## 4. 请求上下文与路由保护

### 4.1 请求上下文

鉴权中间件应将解析结果写入**请求级上下文**，供后续 Handler 使用，建议最小字段：

| 字段       | 说明                                                     |
| ---------- | -------------------------------------------------------- |
| `userId`   | 当前用户数字 ID（鉴权必需）                              |
| `email`    | 可选，远程 validate 时可缓存；本地 JWT 校验通常只解析 ID |
| `rawToken` | 可选，服务端需代理调用其他受保护 API 时保留原始 Token    |

业务代码通过上下文获取用户身份，**禁止**从请求 Body 或 Query 中信任客户端传入的 `userId`。

### 4.2 路由分级

建议将路由分为三类，在路由表或中间件链中显式声明：

| 类型         | 说明                             | 示例                                       |
| ------------ | -------------------------------- | ------------------------------------------ |
| **公开**     | 无需登录                         | 健康检查、版本信息                         |
| **已认证**   | 需有效 Access Token              | 绝大部分业务 API                           |
| **业务授权** | 已认证基础上，由业务后端校验权限 | 管理接口、敏感操作（权限规则归属业务系统） |

实现方式因框架而异：全局中间件 + 白名单、按路由挂载中间件、或注解/装饰器标记，本质均为「在进入 Handler 前完成身份确认」。

### 4.3 跨域与 Cookie

浏览器跨域调用业务 API 时：

- 业务后端 CORS 须允许 `credentials`（携带 Cookie）
- `Access-Control-Allow-Origin` 不可为 `*`（须指定具体源）
- 前端请求须设置 `credentials: 'include'`

生产环境通常通过**反向代理**将认证服务与业务 API 置于同一站点下，避免跨站 Cookie 问题。

### 4.4 WebSocket 鉴权

业务若提供实时通道（如 Run 事件推流），**不得只保护 HTTP、放开 WS**。浏览器在同站场景下会在握手请求中自动携带 `auth_token` Cookie，推荐与 HTTP **共用同一套本地 JWT 校验**。

**推荐约定：**

| 项         | 约定                                                                                               |
| ---------- | -------------------------------------------------------------------------------------------------- |
| 时机       | 在连接建立时（如 Nest `handleConnection`）校验；失败则关闭连接，不进入业务消息处理                 |
| Token 来源 | 优先 Cookie `auth_token`；可选支持 `Authorization` 握手头或（仅非浏览器/调试）query `access_token` |
| 成功       | 将 `userId`（及可选 `rawToken`）挂到连接上下文，供后续 `subscribe` / `run` 做归属校验              |
| 失败       | 关闭连接；可用自定义 close code（如 `4401`）便于前端识别未授权                                     |
| 过期       | Access Token 有效期内通常不中途重验；断开后由前端先走 HTTP `/refresh`，再重连 WS                   |
| 公开通道   | 健康检查等仅限 HTTP；业务 WS（如 Runs）默认一律需登录                                              |

**不要**在应用协议里再发明首包 `{ type: 'auth' }` 状态机（除非无法在握手阶段读到 Cookie）；多一轮协议增加「未鉴权即可发业务消息」的漏洞面。

网关透传模式下，仅当 WS 终止于内网、且网关已校验 JWT 时，下游可信任注入的用户头；公网直连业务 WS 时仍须自行验 Token。

前端侧：同站下浏览器握手自动携带 Cookie；连接因未授权关闭时，应先走 HTTP `/refresh` 再重连，**不要**在 WS 协议内换票。业务前端的会话与 401 刷新约定见 [front-auth.md](./front-auth.md)。

---

## 5. 授权与数据隔离

**鉴权（Authentication）** 解决「你是谁」，由认证服务 + 业务后端 Token 校验完成。

**授权（Authorization）** 解决「你能做什么」，**完全归属业务系统**：认证服务不提供 role、权限码或策略引擎，业务后端需自行设计（如本地 RBAC 表、资源 Owner 校验、独立权限服务等）。

### 5.1 行级数据隔离（多租户按用户）

用户私有数据表应包含 `uid`（或 `user_id`）外键/字段。所有读写必须在查询条件中绑定当前用户：

- 列表/统计：`WHERE uid = :currentUserId`
- 更新/删除：`WHERE id = :resourceId AND uid = :currentUserId`
- 资源不存在或不属于当前用户：返回 **404**（避免通过 403 泄露资源是否存在）

### 5.2 业务侧权限（非认证服务职责）

常见做法（任选或组合，均在业务域实现）：

- 在业务库维护用户—角色—权限映射，Handler 内按 `userId` 查询后判断
- 资源级校验：除 `uid` 外再检查组织、项目、共享关系等
- 引入独立权限/策略服务，业务后端在鉴权通过后二次问询

不应假设 JWT 或 `/validate` 会返回 `role` 等字段；旧版若曾写入相关 Claim，新集成应忽略。

### 5.3 业务后端不负责刷新 Token

Access Token 过期时，业务后端统一返回 **401**。Token 刷新由**前端**调用认证服务 `/refresh` 完成，业务后端不参与 Refresh Token 的存储与轮换。

---

## 6. 服务端代理调用

当业务后端需要代用户调用其他受保护服务（如认证服务的文件上传接口），应**透传用户 Access Token**，而非使用服务账号替代用户身份。

典型流程：

1. 入口中间件已校验 JWT，并保留 raw Token
2. 业务 Handler 发起出站 HTTP 请求
3. 将 Token 放入出站请求的 Cookie 或 `Authorization` 头
4. 下游服务独立校验；业务后端不缓存、不持久化用户凭证

上传接口约定：`POST /api/v1/auth/upload`，`multipart/form-data` 字段 `fileName`、`file`，需鉴权。响应含 `path`、`route`、`access_url` 等字段。

---

## 7. 配置项

业务后端建议通过环境变量注入，便于各环境部署：

| 变量                    | 必填                | 说明                                       |
| ----------------------- | ------------------- | ------------------------------------------ |
| `JWT_SECRET`            | 本地校验时必填      | 与认证服务签发密钥一致                     |
| `AUTH_COOKIE_NAME`      | 否                  | Access Token Cookie 名，默认 `auth_token`  |
| `AUTH_SERVICE_BASE_URL` | 远程校验/代理时必填 | 认证服务根地址，如 `http://localhost:8888` |
| `UPLOAD_BASE_URL`       | 代理上传时          | 上传服务根地址                             |
| `UPLOAD_PATH`           | 否                  | 上传路径，默认 `/api/v1/auth/upload`       |

密钥轮换时，认证服务与新版本业务后端须**同时**切换 `JWT_SECRET`，否则会出现大面积 401。

---

## 8. 错误响应约定

业务后端鉴权失败应返回 HTTP **401 Unauthorized**，Body 建议与认证服务风格一致：

```json
{
  "code": "UNAUTHORIZED",
  "message": "Missing or invalid token"
}
```

可按场景细分 message，便于排查：

| 场景                  | 建议 message             |
| --------------------- | ------------------------ |
| 未携带 Token          | Missing auth token       |
| 服务未配置密钥        | Server auth config error |
| Payload 无有效用户 ID | Invalid token payload    |
| 签名错误或已过期      | Invalid or expired token |

业务错误（如参数非法）使用 4xx 其他状态码，与鉴权失败区分。

---

## 9. 端到端时序

### 9.1 正常业务请求

```
用户已登录（浏览器持有 auth_token）
        │
        ▼
前端 ──GET /api/v1/{app}/resources──► 业务后端
        Cookie: auth_token=<jwt>              │
                                              ├─ 校验 JWT
                                              ├─ currentUserId = 123
                                              ▼
                                        查询 uid=123 的数据
                                              │
        ◄──────────── 200 + JSON ─────────────┘
```

### 9.2 Token 过期与刷新

```
前端 ──请求业务 API──► 业务后端 ──401──► 前端
                              │
                              ▼
                    POST /api/v1/auth/refresh
                    （refresh_token Cookie）
                              │
                              ▼
                    认证服务轮换 auth_token
                              │
                              ▼
                    前端重试原业务请求 ──200──►
```

---

## 10. 实现检查清单

接入统一认证时，可按下列项自检：

- [ ] 业务后端不实现登录/注册/刷新接口，相关能力由认证服务提供
- [ ] 已配置与认证服务一致的 `JWT_SECRET`（或已实现远程 validate）
- [ ] 请求入口中间件从 Cookie（及可选 Bearer）提取并校验 Token
- [ ] 用户 ID 写入请求上下文，业务层不信任客户端传入的用户标识
- [ ] 私有数据按 `uid` 行级隔离，跨用户访问返回 404
- [ ] 健康检查等公开路由已排除鉴权
- [ ] 业务 WebSocket 在握手时校验 Token，与 HTTP 共用校验逻辑
- [ ] CORS 支持 credentials，或与认证服务同域部署
- [ ] 鉴权失败统一 401（建议 Body 含 `code: "UNAUTHORIZED"`），不泄露密钥或内部栈信息
- [ ] 服务端代理外部 API 时透传用户 Token，不使用固定服务凭证冒充用户
- [ ] 权限/角色逻辑在业务后端或独立服务实现，未依赖认证服务返回 role

---

## 11. 扩展方向

| 需求                | 设计建议                                                                        |
| ------------------- | ------------------------------------------------------------------------------- |
| 移动端 / 第三方 API | 在中间件中增加 `Authorization: Bearer` 解析                                     |
| API 网关统一鉴权    | 网关校验 JWT，内网透传 `X-User-Id`；业务后端仅监听内网                          |
| 细粒度权限          | 在业务后端或独立权限服务实现；认证服务仅提供 userId                             |
| Token 即时吊销      | 缩短 Access Token 有效期，或改用远程 validate + 黑名单                          |
| 多应用共享登录      | 依赖 SSO 与统一 Cookie 域；各业务后端使用相同 JWT_SECRET                        |
| 开发旁路            | 可用 `AUTH_DISABLED` 等开关跳过 Guard（仅 local）；e2e 与演示需文档化，生产禁止 |

---

## 12. 与本仓库（monai-devops）的路径约定

本应用业务 HTTP / WS 全局前缀推荐：

```text
GLOBAL_API_PREFIX=api/v1/devops
```

与认证服务前缀为**兄弟路径**，同站部署时互不冲突：

| 路径前缀         | 去向                            |
| ---------------- | ------------------------------- |
| `/api/v1/auth`   | 认证服务                        |
| `/api/v1/devops` | 本业务后端（含 `…/runs/ws` 等） |

反向代理 / 开发代理须**先匹配** `/api/v1/auth`，再匹配 `/api/v1/devops`，避免过宽的 `/api/v1` 规则把认证流量误打到业务进程。

前端接入（统一认证页跳转、code 换 Cookie、业务请求 credentials 与 401 刷新）以 [front-auth.md](./front-auth.md) 为准。同站部署时业务前端、统一认证页、Auth Service 与业务 API 尽量同一 host 路径分流。

实现时保持本文的职责边界与数据流即可；具体 Guard / Gateway 代码落在 `apps/server`。
