# NestJS 多知识库 RAG 后端

任务历史支持 `DELETE /api/tasks/:id` 移除单条已结束记录，及 `DELETE /api/tasks?knowledgeBaseId=:id` 批量清除已完成、已取消记录。仅任务所属用户可操作；进行中任务及尚未释放执行锁的任务返回 409。移除只隐藏列表记录，内部任务保留用于幂等、文档版本关联和故障恢复，不删除文档、向量或队列作业；失败记录不会自动批量清除。此功能复用任务 JSON 字段，无需额外迁移。

任务响应提供 `canDismiss`、`waitingUntil`、`waitingReason`；保留期内的清理任务显示预计执行时间。列表优先返回活动任务及最近 50 条未移除历史。前端仅在管理抽屉打开且存在活动任务，或有本次上传尚未完成时轮询；页面隐藏时暂停，纯延迟清理最多每 30 秒刷新一次，分类只在显式刷新和操作时更新。

Node.js >=22.21.1。API 与 Worker 共用代码、MySQL 和原件目录；Qdrant 保存向量，Redis/BullMQ 调度任务。

## 配置与数据库升级

    npm install
    Copy-Item .env.example .env

填写 DB_USER、DB_PASSWORD、JWT_SECRET（至少 32 字符）；CHAT_API_KEY 可以由服务端配置，也可以由前端通过 X-Api-Key 按请求提供。新索引默认使用百炼 qwen3.7-text-embedding-flash（1024 维），重排使用 qwen3.7-text-rerank；旧 MiniLM 384 维索引保留兼容。配置详情见 ../docs/rag-quality-deployment.md。

已有数据库：

    npm run schema:upgrade

此命令显式、可重复地新增知识库、分类、文档版本、索引版本、片段和任务表，并扩展聊天引用及派生产物来源版本。每个用户的历史文档、聊天归入默认知识库。MySQL DDL 不支持完整事务回滚，应备份后在维护窗口执行。启动始终只检查结构，不执行 DDL。

空数据库由管理员创建后：

    npm run migration:run

旧文档仅保留了正文，迁移为 legacy 版本，激活时异步重建；无法恢复原件或 PDF 页码。重新上传原文件后可获得页码引用。既有 bcrypt 密码继续有效。

## 启动

项目根目录：

    docker compose up -d redis qdrant

后端目录中，API 与 Worker 分别在两个终端启动：

    npm run start:dev
    npm run start:worker:dev

生产环境先 npm run build，再分别执行 npm run start:prod 和 npm run start:worker。两进程必须使用相同数据库、模型配置、QUEUE_PREFIX、QDRANT_COLLECTION 和 ORIGINALS_DIR。默认开发脚本监视已编译输出；API 的编译监视会同步更新 Worker 所用代码。

| 配置 | 默认值 / 说明 |
| --- | --- |
| PORT | 8080 |
| STORAGE_DRIVER | mysql |
| VECTOR_DRIVER | qdrant；memory 仅用于临时演示或测试 |
| QDRANT_URL / QDRANT_COLLECTION | http://127.0.0.1:6333 / rag |
| QDRANT_API_KEY | 可选，不传到浏览器 |
| QUEUE_DRIVER / REDIS_URL | bullmq / redis://127.0.0.1:6379 |
| QUEUE_PREFIX | ai-rag，多个环境应使用不同值 |
| ORIGINALS_DIR | .data/originals，必须持久化并由 API、Worker 共享 |
| UPLOAD_TEMP_DIR | .tmp/uploads，分片续传临时目录 |
| MODEL_CACHE_DIR | .cache/models，首次运行需下载模型 |
| EMBEDDING_MODEL | Xenova/all-MiniLM-L6-v2，384 维 |
| EMBEDDING_REVISION | .env.example 中固定提交版本 |
| INDEX_RETENTION_MS | 600000，旧版及删除索引保留十分钟以支持进行中的问答 |
| MAX_DOCUMENT_BYTES | 134217728；单个 HTTP multipart 请求仍限 10 MiB |
| DB_TIMEZONE | +08:00 |

MySQL 默认连接 127.0.0.1:3306/ai_rag，DB_USER、DB_PASSWORD 必填。聊天默认使用 .env.example 的 OpenAI 兼容地址及模型名称，请按账号实际可用模型设置。

临时全内存演示需同时设置 STORAGE_DRIVER=memory、VECTOR_DRIVER=memory、QUEUE_DRIVER=memory；此时 API 进程内部调度任务，不另开 Worker，重启后全部数据丢失。不会从持久化模式自动降级到内存。

## 处理与一致性规则

- 上传和分片合并返回 HTTP 202，data 中含 documentId、taskId、knowledgeBaseId、filename；这只表示原件已接收。任务完成后文档才可检索。
- MySQL 任务是持久 outbox。分发器每秒补投，队列只保存任务 ID，支持 Redis 暂不可用及 Worker 重启恢复。默认每个 Worker 同时处理一份文档，Embedding 每批 16 个片段。
- 任务报告 queued/parsing/chunking/embedding/indexing/completed 等阶段及 completed/total；不能计量的阶段 total=null。
- 可恢复错误最多自动尝试三次，指数退避；格式错误直接失败。手动重试复用索引版本，稳定 point ID 避免重复向量。全库失败子任务通过父任务重试。
- 每份文档有 active 与 desired 索引版本，最后接受的替换为目标。新版本所有写入成功并确认可查询后发布；失败继续使用旧版。
- 全库重建逐文档切换，可部分失败。期间拒绝同库上传、替换与重复重建，允许删除和使用旧索引问答。
- 删除立即从新请求的检索范围移除，并删除关联摘要、闪卡及导图；后台等待保留窗口和进行中写任务结束后清理原件、片段和向量。历史聊天引用保留原文快照。删除库后原会话只读。
- 新旧索引按用户、知识库、生效 revision 过滤后检索；小规模知识库使用 MySQL 返回的 revision 集合，不宣称适用于无限规模。
- collection 名称包含模型、revision、维度、pooling 等配置指纹；配置不匹配的任务不会发布。更换 Embedding 模型需单独迁移全部向量，不属于本次升级。
- 扫描 PDF 无 OCR，解析任务明确失败。片段位置基于 PDF 提取文本或 Markdown 正文，未实现 PDF 坐标高亮。

## 接口与前端

所有业务接口要求 Bearer JWT，沿用 {code,data,message} 响应封装。

| 接口 | 功能 |
| --- | --- |
| GET/POST /api/knowledge-bases | 列表、新建 |
| PUT/DELETE /api/knowledge-bases/:id | 编辑、删除 |
| GET/POST /api/knowledge-bases/:id/categories | 分类列表、新建 |
| PUT/DELETE /api/knowledge-bases/:id/categories/:categoryId | 编辑、删除分类 |
| GET /api/knowledge-bases/:id/documents | page/pageSize/name/status/categoryId 筛选；categoryId=0 为未分类 |
| POST /api/upload | file + knowledgeBaseId/categoryId/uploadId |
| GET /api/upload/check | md5/filename/knowledgeBaseId/uploadId，可带 documentId |
| POST /api/upload/chunk | 原分片参数 + 同一上传作用域 |
| POST /api/upload/merge | 合并并创建任务，重复提交返回同一文档与任务 |
| PUT /api/documents/:id | filename/categoryId；categoryId=null 清除分类 |
| PUT /api/documents/:id/file | 替换文件，返回 202 |
| POST /api/documents/:id/reindex | 单文档重建 |
| POST /api/knowledge-bases/:id/reindex | 全库重建 |
| GET /api/tasks?knowledgeBaseId=... | 最近任务 |
| GET /api/tasks/:id | 进度及全库子任务 |
| POST /api/tasks/:id/retry | 重试失败任务 |

旧上传请求省略知识库时归入默认库。新会话省略知识库也使用默认库；已有会话省略时沿用绑定知识库，显式传入不匹配的库会拒绝。

POST /api/chat 返回 answer/citations；POST /api/stream-chat 保留默认 token 和 chatId 事件，新增 sources、citations、done、error。done 携带规范化完整 answer/citations/chatId/generationStatus，前端用它替换临时输出。非法引用编号删除；编号有效不代表引用在语义上支持结论，仍需核对原文。没有上下文时直接提示资料不足。

分析、闪卡、导图继续按文档 ID 生成，记录回答时的生效版本；来源更新后历史产物标记为旧版。

## 验证

    npm run build
    npm test
    npm run test:e2e
    npm run test:embedding

真实服务集成测试，项目根目录先启动专用测试容器：

    docker compose --profile test up -d mysql-test redis-test qdrant-test

回后端目录：

    npm run test:integration

测试默认使用专用端口 13306/16379/16333，仅创建和删除本次随机命名的测试数据库、collection 及队列；不会读取 .env 业务数据库凭据。测试中的 MySQL、Redis、Qdrant 与独立 Worker 均为真实服务，Embedding 和 LLM 使用固定测试响应；真实本地模型另由 test:embedding 验证。可使用 TEST_DB_HOST/TEST_DB_PORT/TEST_DB_PASSWORD/TEST_REDIS_URL/TEST_QDRANT_URL 覆盖测试服务连接。

前端执行 npm test 验证 SSE 跨块和中文解码，npm run build 验证 Vue/TypeScript 与生产打包。答辩评估样例见 ../docs/evaluation。

前端 npm run test:e2e 使用本机 Edge 无头浏览器，验证引用抽屉、流式中断、跨库筛选重置、替换完成及失败重试、已删除知识库的历史只读。接口为受控测试响应，不访问用户账号。

默认集成测试会短暂停止并恢复专用 redis-test 容器，验证 MySQL outbox 补投；不操作日常 redis 服务。设置 TEST_REDIS_RESTART=0 可跳过该项；覆盖 TEST_REDIS_URL 时默认跳过。测试结束后可在项目根目录执行 docker compose --profile test stop mysql-test redis-test qdrant-test 停止专用测试容器。
