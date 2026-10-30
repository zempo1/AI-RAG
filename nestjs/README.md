# AI-RAG NestJS 后端

独立替代 Java 后端，保留原 Vue 3 前端的接口。原 `backend/`、`frontend/` 和 `nest-backend/` 无需修改。Node.js 要求 **22.21.1 或更高版本**。

## 安装与启动

在项目根目录执行以下 PowerShell 命令：

```powershell
cd nestjs
npm install
Copy-Item .env.example .env
```

编辑 `.env`，至少填写 `DB_USER`、`DB_PASSWORD`、`JWT_SECRET`。JWT 密钥至少 32 字符，可生成：

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

默认连接 MySQL 的现有 `ai_rag` 数据库。启动只读取并检查表结构，**不自动建表、不修改表结构、不执行 migration**。连接或结构检查失败会启动失败，不会降级为内存。

```powershell
npm run start:dev
```

服务默认监听 `http://localhost:8080`，`PORT` 可覆盖。开发模式先编译，再同时运行 TypeScript 编译监视和 Node 自动重启。生产运行：

```powershell
npm run build
npm run start:prod
```

已有 Java 服务占用 8080 时先停止 Java 服务。前端保持原有启动方法与 `/api` → `http://localhost:8080` 的 Vite 代理，无需修改源码。后端没有首页，浏览器访问 `/` 不能用于判断是否启动成功；看控制台监听日志，或访问需要认证的 `/api/documents`，未登录返回 401 是正常行为。

旧 Java JWT 使用进程随机签名密钥，不能直接在 NestJS 使用；切换后重新登录。已有数据库中的 bcrypt 密码可继续使用。

### 空数据库初始化

先由数据库管理员创建空的 UTF-8 数据库并配置 `.env`，再显式执行：

```powershell
npm run migration:run
```

初始 migration 创建六张业务表。检测到任一已有业务表会拒绝执行；**已有 Java 数据库不要执行初始 migration**，直接启动进行兼容检查。MySQL DDL 不支持完整事务回滚；初始化失败时先检查报错和已创建的表，不要在业务库中尝试清表。为保护数据不提供自动删表回滚命令。

### 临时内存模式

将 `.env` 中 `STORAGE_DRIVER=memory`，保留有效 `JWT_SECRET`，即可不依赖 MySQL 启动；所有用户、文档和历史在重启后丢失。切换存储驱动不会迁移数据。

## 配置

| 变量                            | 默认/用途                                                     |
| ------------------------------- | ------------------------------------------------------------- |
| `PORT`                          | `8080`                                                        |
| `STORAGE_DRIVER`                | `mysql`；可显式改为 `memory`                                  |
| `DB_HOST`、`DB_PORT`、`DB_NAME` | `127.0.0.1`、`3306`、`ai_rag`                                 |
| `DB_USER`、`DB_PASSWORD`        | MySQL 模式必填，不内置真实凭据                                |
| `DB_TIMEZONE`                   | `+08:00`，也支持 `Z` 或数字时区偏移                           |
| `JWT_SECRET`                    | 至少 32 字符，必填                                            |
| `CHAT_API_KEY`                  | 服务端模型密钥；未配置也能启动，生成时明确报错                |
| `CHAT_BASE_URL`                 | `https://dashscope.aliyuncs.com/compatible-mode/v1`           |
| `CHAT_MODEL`                    | 沿用 Java 配置的 `qwen3.8-flash`，请替换为账号实际可用模型    |
| `EMBEDDING_MODEL`               | `Xenova/all-MiniLM-L6-v2`，本地模型，与 Chat 模型独立         |
| `EMBEDDING_REVISION`            | 示例中固定的模型提交版本                                      |
| `MODEL_CACHE_DIR`               | `.cache/models`，首次调用会下载 ONNX 模型；离线部署须提前缓存 |
| `UPLOAD_TEMP_DIR`               | `.tmp/uploads`，分片临时目录                                  |
| `MAX_DOCUMENT_BYTES`            | `134217728`，合并文档解析的资源上限，128 MiB                  |

配置阿里云百炼时，填写自己地域和账号对应的 OpenAI 兼容 Base URL、API Key 及可用 Chat 模型。Embedding 使用本地 MiniLM，不需要百炼 Embedding Key，也不能填入 Chat 模型名称冒充 Embedding 模型。更换 Embedding 模型或参数后应重启并重新激活文档，禁止混用不同向量空间。

原前端设置的 `X-Api-Key` 仅覆盖当前流式聊天、分析或思维导图请求的 Chat 密钥，不写数据库、日志或向量。普通 `/api/chat` 沿用服务端密钥行为。`.env` 已忽略，勿提交真实密钥。

## 功能及模块

使用 NestJS 12、TypeScript、TypeORM/mysql2、LangChain.js、Transformers.js、PDF.js 和 Jest，依赖版本已固定并提供锁文件。

| 模块                | 职责                                                    |
| ------------------- | ------------------------------------------------------- |
| Auth                | 注册、登录、bcrypt、JWT、资料修改、用户隔离             |
| Persistence         | 六张原表映射、MySQL/内存 Repository、事务及只读结构检查 |
| Documents           | PDF/Markdown、直接上传、分片续传、解析、切分、历史激活  |
| Embeddings          | 本地 MiniLM 384 维向量，文档和问题共用模型              |
| VectorStore         | 全量余弦检索与片段来源元数据，不是 HNSW                 |
| Rag / Llm / Chat    | 原 Prompt、OpenAI 兼容模型、普通问答及 POST SSE         |
| History             | 会话及消息保存与删除                                    |
| Analysis / MindMaps | 现有摘要、大纲、闪卡、思维导图功能                      |
| Common / Config     | 校验、错误响应、配置及统一响应包装                      |

### API 对照

普通成功响应：`{"code":200,"message":"success","data":...}`；无返回值省略 `data`。错误响应：`{"code":HTTP状态码,"message":"..."}`，不返回虚假成功内容。

| 方法及路由                          | 请求                                                 | 响应 data                                             |
| ----------------------------------- | ---------------------------------------------------- | ----------------------------------------------------- |
| POST `/api/auth/register`、`/login` | `{username,password}`                                | `{token,username}`                                    |
| POST `/api/auth/change-password`    | `{oldPassword,newPassword}`                          | `{message}`                                           |
| POST `/api/auth/change-username`    | `{newUsername}`                                      | `{message,username}`                                  |
| POST `/api/upload`                  | multipart `file`                                     | 原成功提示字符串                                      |
| GET `/api/upload/check`             | `md5,filename` 查询参数                              | `{uploaded,uploadedChunks?}`                          |
| POST `/api/upload/chunk`            | multipart `file,md5,filename,chunkIndex,totalChunks` | `{chunkIndex,received}`                               |
| POST `/api/upload/merge`            | `{md5,filename,totalChunks}`                         | `{message,filename}`                                  |
| GET `/api/documents`                | 无                                                   | `[{id,filename,uploadTime}]`                          |
| POST `/api/documents/:id/activate`  | 无                                                   | 无                                                    |
| DELETE `/api/documents/:id`         | 无                                                   | 无                                                    |
| GET/POST `/api/chats`               | POST 可带 `{title}`                                  | 会话列表/会话                                         |
| GET/DELETE `/api/chats/:id`         | 无                                                   | GET 返回含 messages 的会话                            |
| POST `/api/chat`                    | `{question}`                                         | 答案字符串                                            |
| POST `/api/stream-chat`             | `{question,chatId:null或数字}`                       | SSE，无普通包装                                       |
| POST `/api/analysis/generate`       | `{documentId,type}`                                  | `{id,documentId,documentName,type,content,createdAt}` |
| GET `/api/analysis`                 | `type` 查询参数                                      | 分析结果列表                                          |
| DELETE `/api/analysis/:id`          | 无                                                   | 无                                                    |
| POST `/api/mindmaps/generate`       | `{documentId?}`，不传使用最近文档                    | `{id,title,data,createdAt}`，data 为 JSON 字符串      |
| GET `/api/mindmaps`、`/:id`         | 无                                                   | 列表/单项                                             |
| PUT `/api/mindmaps/:id`             | `{data:JSON字符串}`                                  | 更新结果                                              |
| DELETE `/api/mindmaps/:id`          | 无                                                   | 无                                                    |

除注册、登录和 OPTIONS 外均要求 `Authorization: Bearer <token>`。分析类型为 `SUMMARY`、`OUTLINE`、`FLASHCARD`。会话消息字段为 `id,role,content,createdAt`。

SSE 新会话先发 `event: chatId` 和数字 data；答案逐 token 发 JSON 字符串 data，正确转义换行、引号和反斜杠；不发 `[DONE]` 或新引用字段。连接超时为 180 秒，断开时取消上游请求，失败保留错误/中断历史。前端原 SSE 解析器没有跨网络分块缓冲，服务端逐帧写入不能保证所有网络环境的分块边界；本次未修改前端修复这一原有局限。

## 行为与实现差异

- Java 实际使用本地 AllMiniLmL6V2 和 InMemoryEmbeddingStore；根 README 中的百炼 Embedding/HNSW 描述不能代替代码事实。新实现使用精确全量余弦检索，不宣称 HNSW。
- 检索相关度为 `(cosine+1)/2`，保持最低 0.5、先全局取 10 条、再过滤当前用户并取 5 条。保留这一原有顺序，未自行改进算法。
- 切分保持 500 字符、50 重叠，优先段落/行/句子/词边界；Java 和 Node 的具体边界处理并非逐片完全一致。ONNX 跨运行时结果也不保证逐数值一致。
- RAG 原英文 Prompt 原样迁移；无相关上下文时直接向模型提问；历史消息保存但不额外传入 Prompt。分析/思维图沿用原 Prompt 和 20000 字符截断。
- PDF.js 替代 PDFBox，排版、空格和换行提取可能不同。中文需要 PDF 自带可提取的文字/字体映射；扫描件或无文字 PDF 明确拒绝，不执行 OCR。Markdown 保留原始 UTF-8 标记。
- 原 Java 对非 PDF 默认按文本读取；新实现按前端约定只接受 `.pdf` 和 `.md`，空文件、乱码、损坏 PDF、无效分片参数返回明确错误。
- 单次 multipart 请求限制 10 MiB；合并文件支持超过 10 MiB，新增可配置的 128 MiB 解析资源上限，避免一次耗尽内存。分片采用磁盘流式合并，不在内存保留全部分片副本。
- 上传解析和 Embedding 成功后才写文档记录；秒传标记仅在本进程完成入库后有效，避免重启后误报已向量化。分片按用户隔离；失败保留分片用于重试。MD5 用作客户端上传标识，不作为安全校验或防篡改机制。
- 业务数据默认保存在原 MySQL 六张表，向量仍只在内存中。重启后需从历史文件点击“使用此文件”重新向量化；删除文档历史仍不移除已有内存向量，以保留原行为。
- 数据库日期保持原无时区 ISO 风格输出，SQL 绑定不依赖宿主时区自动转换；MySQL 每条连接设置配置的 session time_zone，兼容原库的 DATETIME/TIMESTAMP 混用。
- 思维图生成返回无效 JSON 时明确失败，不沿用原来的硬编码错误节点成功响应。未新增登录以外的权限业务，仅补齐已有资源归属检查。
- 默认不自动复制 Java LangChain4j 隐式重试/生成参数；LangChain 调用不额外设置温度，模型服务采用自身默认值，失败直接上报。

## 测试

```powershell
npm test
npm run test:e2e
npm run test:embedding
```

单元测试包含真实 PDF/Markdown 解析、切分、向量检索、RAG、内存事务、bcrypt 兼容以及本地 OpenAI HTTP/SSE 测试服务器。API 测试只替换外部模型依赖，业务和 HTTP 路由使用真实实现。中文 PDF 测试使用 Windows 黑体字体；没有该字体的平台会明确跳过该项。

默认 API 测试使用内存，真实 MySQL 测试默认跳过。运行真实 MySQL 测试前在当前 PowerShell 设置测试凭据（不要把密码提交到仓库）：

```powershell
$env:MYSQL_INTEGRATION='1'
$env:DB_HOST='127.0.0.1'
$env:DB_USER='你的测试账号'
$env:DB_PASSWORD='你的测试密码'
$env:DB_TIMEZONE='+08:00'
npm run test:e2e
```

测试账号需要创建和删除临时数据库权限。测试生成独立的 `ai_rag_nest_test_<随机值>`，仅清理本次生成的临时库，不对原业务库清表。覆盖初始化、事务回滚、唯一约束、重连持久化、跨时区往返、结构检查，以及 MySQL 模式的完整上传和聊天接口。

本地 Embedding smoke 会实际下载/加载固定模型，并检查 384 维输出和文档/问题向量一致性，不冒充真实 Chat 模型测试。没有有效百炼/OpenAI Key 时不宣称真实生成已验证。

## 后续扩展

持久化向量数据库可实现 `VectorStore` 接口替换内存实现；业务存储已有 MySQL/内存 Repository 边界；未来 Agent 可复用 Documents、Embeddings、Rag 和 Llm。本次没有加入 Agent、工具调用、外部搜索、任务队列或新业务。
