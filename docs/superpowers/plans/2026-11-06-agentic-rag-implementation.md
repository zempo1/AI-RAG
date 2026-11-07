# Agentic RAG Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** 在现有知识库中实现可选择工具、判断证据、限制预算并能后台恢复的 Agent。

**Architecture:** NestJS 内使用 LangGraph JS StateGraph；共享检索原语与原文证据协议。复用现有任务和诊断JSON存储，不增加Agent平台或数据库列。

**Tech Stack:** TypeScript、NestJS、LangGraph JS、LangChain OpenAI兼容模型、MySQL、BullMQ、Vue。

**Spec:** docs/superpowers/specs/2026-11-06-agentic-rag-design.md

## Global Constraints

- 用户已批准直接实施，无需再次询问执行方式；不调用真实付费模型。
- 当前功能分支含用户暂存的PDF改动：不重置、暂存、提交或移动这些改动。在当前工作区增量实现。
- 预算默认6决策/8工具/2并发/2证据检查/32模型请求/100000 token/600秒；工具2000、最终证据8000 token。
- 每次工具、恢复、提交校验授权和固定索引版本；所有模型子调用和失败尝试计入预算；取消与超限不能被摘要catch吞掉。
- 生产默认Agent，固定RAG仅作离线基线；旧API、引用和历史QA任务兼容。
- 不自动commit。验证使用隔离outDir，避免触发用户正在使用的dist监视进程。

## Review Focus

- 工具返回有效tool_calls但空content，应接受；非法工具或参数不能执行。
- 摘要缓存[n]在跨工具合并后不得错位，局部摘要不能冒充全文覆盖。
- 并发调用前预留预算并持久化；任务重试不能恢复到调用前的计数。
- 恢复和最后提交时索引切换、删除或取消应终止，不追加错误答案。
- 前台断连发生在prepare期间也应abort；已后台受理则应继续且不重复用户消息。

### Task 1: 共享检索与模型调用协议

**Files:** 新增rag检索原语/类型和测试；修改rag.service/module、LLM、Embedding/重排取消接口、package依赖。

**Interfaces:** 输出可授权快照、加载会话、hybrid/keyword/vector检索、范围读取、原文打包的RetrievalService；LlmService新增typed tool invocation、usage/调用观测，complete/stream原调用兼容。

- [x] 写并运行失败测试：关键词检索零Embedding；父块/图解正文引用；固定scope越权/版本切换；空content有效toolcall及usage/signal。
- [x] 抽取共享原语，baseline复用；安装并锁定与现有core兼容的LangGraph，按peer要求对齐core。
- [x] 实现模型工具接口和统一调用观测，Embedding/重排支持取消。
- [x] 运行相关检索、LLM测试和隔离编译；报告实际导出的接口供Task2使用。

### Task 2: Agent状态图、工具、预算与可恢复摘要

**Files:** 新增modules/agent下类型、工具、预算、运行时、模块及相关测试；扩展SummaryService的signal/预算/稳定引用缓存。

**Interfaces:** AgentService.prepare(question,userId,kbId?,options)产出与现有RetrievalResult兼容的上下文及可序列化continuation；resume(snapshot,options)从phase恢复；最终生成入口必须经过同一预算/权限控制。

- [x] 写并运行失败测试：精确检索分支、语义补查、证据拒绝、最大步数/无进展、预算和取消、summary引用/缓存。
- [x] 实现StateGraph与5个只读工具；schema严格拒绝越权和未知参数，工具结果有界且保留稳定原文refs。
- [x] 实现调用预算/时间预留、最终生成保留、可序列化phase和工具结果journal；摘要所有子调用使用相同执行上下文并保留成功缓存。
- [x] 前台30秒边界/超上下文摘要返回continuation；后台参数恢复并继承预算，不直接在Agent模块入队。
- [x] 运行Agent、Summary和检索测试及隔离编译，报告Chat/QA集成契约。

### Task 3: Chat与QA后台集成及取消

**Files:** chat service/controller/module、qa-tasks service/module、tasks controller/service、API与任务测试。

**Interfaces:** 现有chat/SSE返回保持；agent_step事件；qa payload.engine=agentic-v1；POST/tasks/:id/cancel。

- [x] 写并运行失败测试：生产入口使用Agent、普通/SSE同源、prepare断连、后台恢复不重复工具/消息、取消和重试预算继承。
- [x] 接入prepare/最终生成与agent_step；开始prepare前建立连接生命周期和心跳。
- [x] 复用QA租约/加密/去重，按engine恢复Agent；checkpoint包含调用开始预留及已完成步骤，保留旧summary任务。
- [x] 本人Agent任务取消立即停止新调用、abort在途、禁止发布；最终提交事务复核执行权/授权/版本。
- [x] 运行任务/Chat/API回归和隔离编译。

### Task 4: 前端、实验样例和部署文档

**Files:** frontend chat API/types/Chat/RetrievalDebug/进度组件及测试；新增40题、Agent评估脚本；env/config/docs。

- [x] 写并运行失败测试：agent_step解码/去重、历史trace兼容、后台取消和终止说明。
- [x] 显示实时步骤和持久化时间线，保留来源页码及旧检索诊断，支持显式停止后台任务。
- [x] 生成40题（20调参20验收）、四组评估入口，模拟默认、--live显式，保留人工审核与费用未知标记。
- [x] 更新环境例子、预算说明、部署/实验文档；运行前端单测/构建、相关后端/API、评估dry-run。
- [x] 独立review整套改动并修复重要问题；记录实际验证结果与限制，不声称已做人工或付费验收。

## 实施验证

- 后端 48 个测试套件共 236 项通过。API 回归 17 项通过，依赖外部 MySQL 与处理链路服务的 14 项集成测试跳过。
- 前端 6 项单测、13 项模拟浏览器回归通过。前后端隔离构建通过。
- 调参集、独立验收集各 50 题，四种编排共 400 次模拟运行，执行错误为 0。
- 独立复审验证了原文覆盖检查、末尾读取引用及后台续跑检查点的回归修复。
- 真实模型效果、人工评分、费用及外部服务集成仍需验收。模拟结果仅用于验证功能与执行流程。
