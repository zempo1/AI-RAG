# 通用问答链路运行与验收

## 升级与配置

1. 备份业务数据库，停止 API 和 Worker。在 nestjs 执行 `npm run schema:upgrade`；空数据库使用 `npm run migration:run`。启动不自动改表。本轮没有执行用户业务数据库升级。
2. 对照 `.env.example` 配置 `EMBEDDING_PROVIDER=dashscope`、`EMBEDDING_MODEL=qwen3.7-text-embedding-flash`、`EMBEDDING_DIMENSIONS=1024`、`EMBEDDING_BASE_URL/EMBEDDING_API_KEY`。规划使用 `QUERY_PLAN_BASE_URL/QUERY_PLAN_MODEL/QUERY_PLAN_API_KEY`，重排使用 `RERANK_URL/RERANK_MODEL/RERANK_API_KEY`；规划和重排可回退服务端聊天密钥，Embedding 密钥单独配置。
3. 提供核实与实际模型匹配的本地 tokenizer 目录，设置 `EMBEDDING_TOKENIZER`、`CHAT_TOKENIZER`。不自动下载，不使用字符数冒充 token；外部模型未必公开精确 tokenizer，不能随便选择其他模型的资源后宣称匹配。
4. 运行 `npm run quality:preflight`。local_loadable 只代表能加载；verified=false/requires_verification 仍需核实供应商对应关系。`--live` 可付费对比样本 usage，样本一致也不证明所有文本均匹配。
5. API 和 Worker 使用相同数据库、JWT_SECRET、模型配置与原件目录，分别启动 `npm run start:dev`、`npm run start:worker:dev`。JWT_SECRET 同时保护异步任务的临时加密凭据，不能在作业执行中随意更换。
6. 旧索引继续使用 MiniLM 384 维；新上传/重建使用独立1024维空间。逐文档成功切换，失败保留旧版；不能直接改原 collection 维度，迁移完成前保留旧模型资源。

## 页面与接口

聊天区独立选择问答来源和 auto/search/overview/compare 模式，不与工作台来源耦合。默认当前知识库所有可用文档。检索过程显示范围、版本、候选、排序、最终证据、token 预算及降级原因。分数不是正确概率。

长文档概览返回后台任务，关闭页面不取消任务，刷新会话恢复进度；完成或部分失败后载入历史，部分覆盖不能宣称全文完成。Worker 使用已接受请求的原文快照，任务接口不返回内部快照或加密凭据。

- `/api/chat`、`/api/stream-chat` 支持 chatId、knowledgeBaseId、documentIds、mode 和 UUID requestId。
- 短问答返回答案、引用、chatId、retrievalRunId、diagnostics；异步普通接口返回202及 taskId/chatId/requestId。
- SSE 保留原事件，新增 accepted；接受后台任务后结束连接，前端轮询 `/api/tasks/:id` 后载入历史。
- requestId 对异步 QA 作业持久幂等，同 ID 换问题或来源返回409；普通同步生成不承诺幂等。
- `/api/retrieval-runs/:id` 仅本人可读，14天后不可访问并定时物理清理。聊天引用历史继续保留。

## 验证边界

功能测试使用隔离数据和受控模型响应。真实存储集成使用专用 MySQL、Redis、Qdrant 容器，覆盖384/1024真实空间隔离，不调用付费模型。

60道合成标注题见 `docs/evaluation/accuracy`，状态为 authored_requires_human_review。`npm run eval:quality` 默认 dry-run 返回 not_run。配置服务与匹配 tokenizer、完成人工核对后，执行 `npm run eval:quality -- --live --tune` 调参，再执行 `npm run eval:quality -- --live` 验收；结果写入忽略目录，不连接业务数据库。

正确性、完整性和引用支持率仍需人工判分。90%召回/正确率、95%引用支持率是目标，不能将构建和功能测试通过当作真实准确率达标。

## Qwen3.7 适配

默认 Embedding 为 qwen3.7-text-embedding-flash（1024 维），使用 OpenAI 兼容接口；重排为 qwen3.7-text-rerank，使用 DashScope 接口及 top_n/instruct 参数。旧 GTE 模型继续使用原有参数。

分别配置 EMBEDDING_API_KEY、RERANK_API_KEY；重启 API 与 Worker 后重建文档索引。即使维度相同，不同模型也属于独立向量空间，旧索引按保存的模型配置读取，直到新版成功发布。

EMBEDDING_TOKENIZER 必须指向经核实与新模型匹配的本地 tokenizer，不能把普通 Qwen tokenizer 当作已验证匹配。CHAT_TOKENIZER 对应聊天模型。此次适配不附带官方 tokenizer 文件；缺少资源时预检仍会失败。

接口依据：https://help.aliyun.com/en/model-studio/embedding-interfaces-compatible-with-openai 和 https://help.aliyun.com/zh/model-studio/text-rerank-api 。

## 无本地分词器的运行模式（当前默认）

EMBEDDING_TOKENIZER 与 CHAT_TOKENIZER 默认 estimate:utf8-v1，可直接运行，无需下载文件。按 UTF-8 字节数保守估算预算，并沿用输出预留和安全余量；这不是远端真实 token 数，较长中文文档会更早切片或进入异步总结。诊断中 tokenCounting 标记估算，计费应以服务端 usage 为准。显式配置不存在的本地路径仍报错，不静默替换。索引保存估算器版本，可重建切换到核实过的 tokenizer。

Embedding 密钥优先 EMBEDDING_API_KEY，未填则使用 CHAT_API_KEY（须为有模型权限的百炼密钥）；Rerank 同样支持专用密钥与聊天密钥回退。重启 API 和 Worker 后生效。早前要求本地 tokenizer 的说明适用于精确分词模式，当前默认不再需要。
