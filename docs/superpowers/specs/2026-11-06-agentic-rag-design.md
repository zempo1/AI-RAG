# 基于 LangGraph JS 的 Agentic RAG

状态：用户于 2026-11-06 明确要求实施；本文记录已批准的设计契约。

## 目标

单 Agent、LangGraph JS、仅项目知识库工具，长文任务转现有后台问答队列续跑。问题分类辅助模型选择工具，模型依据工具结果决定继续检索或申请作答。复用 PDF 已发布的 native/ocr/table/figure 文字证据，不在问答中识图。

## 架构

StateGraph：授权范围 → 一次结构化任务规划 → Function Calling 决策 → 工具 → 决策；申请作答 → 证据检查 → 反馈决策或最终生成。通用问题直接回答，歧义请求澄清。生产使用 Agent，原 RagService 作为离线基线；现有 mode 仍是意图提示，不是引擎选择。

共享检索原语负责授权快照、向量/BM25/RRF/重排、父块/图解关联正文、精确位置与证据打包。Agent 工具不能调用整个 RagService.prepare。首版工具：list_documents、knowledge_search（默认8，最多20）、keyword_search（不调用Embedding）、read_document（页/章节/游标）、summarize_document（单文档章节/全文/聚焦）。摘要使用 SummaryService 分组、缓存、覆盖与原文核查，禁止前20000字符截断冒充全文。

证据使用稳定 evidenceId，派生摘要必须映射原始证据；最终统一编号。旧摘要缓存局部[n]必须通过格式版本与编号映射隔离，不能直接跨工具复用。检查每个子问题 supported/missing/conflicting、原文引用和目标覆盖；相似度不是答案正确概率。冲突可并列引用，不可靠的完整计数不保证。

## 执行和权限

默认：决策6步、业务工具8次、独立工具并发2、证据检查2次、聊天模型请求32次（含所有子调用/修复/失败尝试）、聊天输入输出累计100000 token、执行600秒（不含队列等待）、工具文本2000 token、最终证据8000 token且受实际上下文限制。预留最终生成预算。SDK无隐式重试，格式最多修复一次；两轮无新增证据停止；请求内相同工具参数复用，重复决策仍计步。超限为不可自动重试的业务终止。

用户、知识库、文档和 activeIndexRevisionId 在开始固定，模型只可缩小。每次工具、恢复、最终提交复核；删除、版本切换或清理停止本轮，禁止混版。原文/历史/工具内容是不可信数据，不可提升为系统指令。不提供写操作、代码执行、任意文件/URL、联网搜索工具。

## 持久化、后台、协议

复用 MySQL processing_tasks(kind=qa)、retrieval_runs、消息及 BullMQ；payload.engine=agentic-v1，记录 phase、pending tools、messages、evidence、预算和成功结果。未缓存的超上下文全文摘要在调用前移交后台，其他前台执行超过30秒在下一个节点边界移交。恢复原phase，不重跑已持久化的步骤，重试不清预算。请求开始前先持久化调用计数；远程响应与持久化之间崩溃允许有界补发，不宣称exactly-once。旧无engine任务仍按旧摘要处理，凭据仍加密且不进trace。

保持 /api/chat、/api/stream-chat、accepted、sources、citations、done；增加 agent_step SSE、diagnostics.agent、POST /api/tasks/:id/cancel（本人Agent问答）。GET /api/retrieval-runs/:id复用轨迹权限与过期策略。断连终止前台；已受理后台任务继续，显式停止调用cancel。规划、工具、摘要、生成全链路传递AbortSignal；执行权检查及最终事务禁止取消后发布。

保留 LlmService.complete/stream 兼容签名，新增工具消息/调用ID/usage/预算观测。控制器默认CHAT配置和请求凭据，AGENT_MODEL可覆盖模型。前端检索抽屉扩展为问题类型、子任务、工具/页码、缺口、停止原因、耗时/token的时间线，展示简短操作说明，不展示隐藏思维链、密钥或完整提示词。

### 集成协议（实施时固定）

`agent_step` 的 JSON 为 `{runId:number, sequence:number, kind:string, summary:string, tool?:string, evidenceCount?:number, elapsedMs?:number, sources?:{filename:string,page:number|null}[]}`。kind 使用 plan/tool_start/tool_end/assessment/handoff/stop，sequence 在同一 run 内严格递增。`diagnostics.agent` 至少含 `{plan,steps,budget,stopReason,status}`；plan 含 intent、complexity、subQuestions。accepted 和任务 qaResult 可额外携带 retrievalRunId，任务公开表示可额外返回 agentProgress（只含上述公开轨迹，不含内部messages/凭据）。前端按runId+sequence去重，旧记录没有agent字段继续显示原检索诊断。

## 验证

模拟响应优先，验证真实分支和补查、精确关键词零Embedding、高分无关不充分、目标文档覆盖、摘要部分覆盖、各类预算/取消/后台恢复/请求去重/跨用户/索引更新/普通流式一致性。后端/API/前端/编译回归。

原60题（未完成人工审核）加40题（20调参、20独立验收），四组：固定RAG、Agent单轮、完整Agent、去掉证据反馈。固定语料/索引/模型，报告引用支持、答案/子任务覆盖、拒答、调用数、P50/P95、实际usage和人工审核状态，不预承诺提升。默认模拟，--live才调用真实API；本轮不自动付费验证。
