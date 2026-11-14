# Agentic RAG 运行与验收

生产问答统一使用 LangGraph v2 持久化图。任务的 `agentic-v1` 字段是供历史记录和队列识别使用的引擎标识，执行版本由任务的 `graphVersion` 标记。模型先规划，再选择知识库工具，依据原文检查各子问题的证据覆盖，最后生成引用。现有 `mode` 仍表达查询意图。原固定 `RagService` 保留为离线实验基线；评估的 `single-round`、`no-feedback` 选项不作为公开引擎切换开关。

自动判断模式只在问题明确要求概览整份文档时采用全文覆盖检查。选中文档后询问其中一个概念或流程，按专题检索处理。手动选择「文档概览」仍会要求全文覆盖。

单份简历的“总结写了什么，并分析技术亮点”等多目标请求属于全文概览；面试官等角色要求不会改变文档范围。即使规划模型初步返回普通检索，明确的全文目标也会进入 `summarize_document`，按游标读完各页后分组核查。只问某项目、技术点或指定页/章节仍走局部检索；同一问题另外明确要求总结整份文档时，保留全文覆盖目标。恢复旧任务时也会检查该范围，不能把单个文本片段当作全篇已读完。

短文档读完各页后，如果完整原文、历史和输出预留可共同放入上下文，直接以全部原文生成最终回答，不再依赖中间分组摘要，也不受专题检索的 `RAG_EVIDENCE_TOKENS` 上限截掉尾页。直接路径同时检查 tokenizer 预算和保守 UTF-8 字节上限；超出时仍使用长文分组摘要。摘要调用的输出上限沿用 `CHAT_OUTPUT_TOKENS`（最多4096），单次时限最多90秒且不超过剩余执行预算，不再套用规划调用的1024输出/20秒时限。

普通文档问答对百炼原生 `kimi-k3` / `kimi-k3.1-pro` 显式使用 `enable_thinking=false`，避免默认思考耗用正文输出额度；通用聊天沿用模型默认设置。该参数只发送给文档明确支持的模型路由，不发送给 `kimi/kimi-k3` 等只支持思考的路由。参见[百炼 OpenAI 兼容参数](https://help.aliyun.com/en/model-studio/qwen-api-via-openai-chat-completions)和[Kimi 模型参数](https://help.aliyun.com/zh/model-studio/kimi-api)。

流式文字回答在尚未输出正文时遇到 SDK 超时，最多等待250ms再尝试一次；每次请求分别预留和结算 Agent 调用/token预算，重试等待及请求建立使用同一截止时间，在预算落库后和发送前重新检查剩余时限。正文开始后仍由现有 SSE 静默超时控制。用户取消、认证错误、已输出正文、视觉请求或预算不足时不自动重新请求。两次都超时显示中文提示；日志 `llm-stream-retry` 仅记录原因和次数，不记录提示词、文档或凭据。该恢复逻辑不能替代模型服务本身的可用性。

PDF 引用在原生坐标完整时按版面恢复阅读顺序，并利用标题、经历日期行等结构，将同一段实习、同一项目组织成完整引用。重叠检索块先去重，不按每次换行或每个文字项编号；同一项目可以跨页。编号列表职责仍归属于其项目。明显分栏或结构不可靠时保守回退，单段有长度上限。识别补充仍保留原文标签和来源区域，冲突时明确以原生文字为准。

检索块用于携带上下文，不直接等同于引用段落。结构引用的 `sectionTitle` 是标题，`sourceSegments` 保存每个原文连续切片及其精确范围、坐标和 chunkIds；顶层 `text` 是阅读顺序快照，顶层 location 是位置包络，不能把它当作连续原文范围来扩展上下文或证明全文覆盖。全文核查逐一验证内部切片，历史直接保存完整快照；模型及历史预算剥离坐标和重复内部快照。`read_document` 游标和 offset 仍按原检索块计算。无结构标题时沿用精确段落切分；有行框的 OCR 将标签绑定正文，整图区域证据不伪造文字精度。不需要重建索引，也不改写历史回答。

聊天中的“参考段落”仅展示答案实际使用的 `citations`，同段可在多个结论处复用相同编号，默认收起，历史也可回看。候选 `sources` 留给调试，在正文生成时不逐条铺开。候选段落数量与最终引用数量是两个概念，不固定凑成四条。

回答须区分“本次证据未覆盖”与“文档确实没有”。升级此判断逻辑后重启 API 与 Worker 并重新提问即可，无需重新上传或重建已完整入库的资料；已有历史回答不会自动改写。

前台处理超过 `AGENT_SYNC_MS`（默认30秒），或预判未缓存的全文分组摘要无法在前台完成时，任务会转到后台；重新打开会话也会恢复未完成任务。界面在对应回答旁显示简洁后台标记和阶段，完成、失败或取消后移除；顶部不再显示整块状态横幅。任务转后台后离开页面不会取消，显式停止才请求取消。

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

1. 配置 MySQL、Qdrant 和 Redis。部署 API 和 Worker 前，在 `nestjs` 目录为已有数据库执行 `npm run schema:upgrade`，为空库执行 `npm run migration:run`。Agent v2 的 `agent_checkpoints` 和 `agent_checkpoint_writes` 与任务表使用同一 MySQL。
2. API 与 Worker 共享 `ORIGINALS_DIR`、`PAGE_ASSETS_DIR`、聊天/Embedding/分块配置和上述 Agent 预算；生产使用 `QUEUE_DRIVER=bullmq`。内存存储不能跨 API/Worker 进程共享。
3. 升级时停止旧版 API 和 Worker，执行数据库升级，再分别用 `npm run start:prod` 与 `npm run start:worker` 启动新版。新任务直接使用 v2。待处理和可重试的旧 Agent 任务由新版 Worker 在领取时导入断点，继承已用预算和工具结果，并在图状态首次落库的同一事务中移除旧快照。
4. 前台超过同步窗口或需要长摘要时暂停图，检查点落库后再移交后台。Worker 按任务线程恢复计划、待执行工具和已保存的证据；已扣预算随任务继承。模型调用完成到结果落库之间发生故障时，重试可能再次调用。可重试任务保留检查点，任务完成、取消或不可重试失败时清理。
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
