# Agentic RAG 运行与验收

生产问答使用单 Agent 的 `agentic-v1` 状态图。模型先规划，再选择知识库工具，依据原文检查各子问题的证据覆盖，最后统一生成引用。现有 `mode` 仍表达查询意图。原固定 `RagService` 保留为离线实验基线；评估的 `single-round`、`no-feedback` 选项不作为公开引擎切换开关。

自动判断模式只在问题明确要求概览整份文档时采用全文覆盖检查。选中文档后询问其中一个概念或流程，按专题检索处理。手动选择「文档概览」仍会要求全文覆盖。

可调用工具只有 `list_documents`、`knowledge_search`、`keyword_search`、`read_document`、`summarize_document`。它们读取开始时固定的用户、知识库、文档和已发布索引版本；每个工具、恢复和最终发布均重新核验权限与版本。关键词工具不请求 Embedding。全文摘要按章节/窗口分组，派生摘要引用必须映射原文；问答阶段复用已发布的 PDF 文字证据。

## 预算配置

API 与 Worker 使用相同的 `.env`。`AGENT_MODEL` 留空时继承 `CHAT_MODEL`；模型必须支持 OpenAI 兼容的 function calling，不能只提供 JSON 文本模拟工具调用。

| 变量 | 默认 | 校验范围/作用 |
| --- | --- | --- |
| AGENT_DECISIONS | 6 | 1–32，模型工具决策轮数 |
| AGENT_TOOLS | 8 | 1–64，未命中请求内缓存的业务工具调用 |
| AGENT_TOOL_CONCURRENCY | 2 | 1–8，且不超过工具总数 |
| AGENT_ASSESSMENTS | 2 | 1–8，证据反馈检查次数 |
| AGENT_MODEL_CALLS | 32 | 2–128，含规划、决策、摘要子调用、核查、修复、失败尝试及最终生成 |
| AGENT_TOKEN_BUDGET | 100000 | 2048–2000000，且至少为 CHAT_CONTEXT_TOKENS+1024 |
| AGENT_ACTIVE_MS | 600000 | 1000–3600000，执行时间，不含排队 |
| AGENT_SYNC_MS | 30000 | 1–600000，且不超过执行总时长 |
| AGENT_TOOL_TOKENS | 2000 | 128–16000，单个工具文本上限 |
| RAG_EVIDENCE_TOKENS | 8000 | 沿用最终原文证据上限，并受实际模型上下文限制 |

数值须为整数；空字符串、小数、负数、指数表示和不合理数值导致启动校验失败。模型请求先预留并持久化预算，至少为最终生成保留一次调用及上下文额度。供应商 usage 缺失时保留保守估算，不将估算当作计费量。格式修复最多一次，两轮无新增证据后停止；超限是不可自动重试的业务终止。

## 部署与 Worker

1. 配置 MySQL、Qdrant、Redis，按仓库现有数据库升级流程升级。无需新增 Agent 表或列；复用 `processing_tasks(kind=qa)`、`retrieval_runs` 和消息存储。
2. API 与 Worker 共享 `ORIGINALS_DIR`、`PAGE_ASSETS_DIR`、聊天/Embedding/分块配置和上述 Agent 预算；生产使用 `QUEUE_DRIVER=bullmq`。内存存储不能跨 API/Worker 进程共享。
3. 执行后端及前端现有构建流程，分别启动 `npm run start:prod` 与 `npm run start:worker`。API/Worker 同步发布，避免旧 Worker 解析新 continuation。
4. 前台超过同步窗口在节点边界移交后台；超上下文全文摘要在调用前移交。续跑继承 phase、pending tools、messages、已完成工具 journal 和已消耗预算。旧的无 engine 摘要任务仍走原流程。
5. 普通问答与 SSE 保留 sources/citations/done；SSE 增加 `agent_step`。前台断连传递取消信号，已受理后台任务继续；显式停止通过 `POST /api/tasks/:id/cancel`，只允许本人 Agent 问答任务。确认取消后不得发布最终答案。

## 模型工具兼容与功能验证

从 `nestjs` 执行隔离构建，避免更改正在被开发服务监视的 `dist`：

```powershell
npx tsc -p tsconfig.json --outDir .data/agentic-build
npm test -- --runTestsByPath test/agentic-foundation.spec.ts test/agent-service.spec.ts test/agent-budget.spec.ts test/agentic-config.spec.ts test/agentic-evaluation-cli.spec.ts test/agentic-evaluation-fixtures.spec.ts
npm run eval:agentic -- --mock --limit 2 --output .data/agentic-smoke.json
```

自动测试覆盖工具协议，包括空 content 携带有效 tool calls，以及请求观测/预算计数。模拟器通过真实 AgentService/StateGraph 和检索原语运行，但不证明配置模型已支持工具。真实兼容验证需操作者显式使用下述会产生外部调用费用的命令；本次实施未执行：

```powershell
npm run eval:agentic -- --live --tune --limit 1 --output .data/agentic-live-smoke.json
```

`--live` 要求显式配置 CHAT_API_KEY、EMBEDDING_API_KEY、CHAT_TOKENIZER、EMBEDDING_TOKENIZER；规划与重排密钥可按现有配置继承 CHAT_API_KEY。tokenizer 使用 `estimate:utf8-v1` 的保守预算，或事先验证的本地绝对路径。脚本在首次远程调用前检查 tokenizer；禁止 test tokenizer。真实兼容性检查应审阅每组失败、降级、工具步骤及供应商 usage，不能仅凭进程成功判断通过。

## 对照与上线门槛

详见 [评估说明](evaluation/agentic/README.md)。100 道合成题中调参、独立验收各 50 道，四组使用同一六份资料与同一批内存索引；固定组直接运行原 RagService，与 Agent 共用 RetrievalService。脚本手动构造 MemoryStore/InMemoryVectorStore，临时生成合成 PDF 并清理，不启动 MySQL/Qdrant 模块，不读取用户 PDF。为启用真实规划/重排，配置中的 STORAGE_DRIVER 使用生产检索分支标记；具体存储仍只在内存。

模拟报告只证明功能执行，答案正确性、完整性、子任务覆盖、引用支持、拒答合理性均留空。真实模型质量、冷/热缓存性能及费用尚未验收；上线前须固定模型版本/索引、先在调参集校准，再对独立验收集完成原文逐项人工审核，保留错误题和失败分母，并对账供应商 usage。未完成这些步骤时 releaseGate 保持 `not_accepted`，不承诺 Agent 优于固定 RAG。
