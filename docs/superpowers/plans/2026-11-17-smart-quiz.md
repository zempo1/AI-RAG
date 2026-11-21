# 智能测验实现计划

Spec: ../specs/2026-11-17-smart-quiz-design.md

- [x] Task 1：测验后端、生成任务、迁移、原文证据、判分和解释上下文；先写 RED 测试再实现，覆盖并发、脱敏与来源生命周期。
- [x] Task 2：统一 App 面板调宽及全屏/折叠接口；先写布局边界与持久化测试，再集成分隔线。
- [x] Task 3：测验 API、配置弹窗、工作台历史、答题面板与恢复；按后端契约实现并编写浏览器测试。
- [x] Task 4：Chat 外部问题入口及 App 解释/来源返回联动；保留草稿和普通聊天行为，验证完整路径。
- [x] Task 5：独立审阅、回归修复、两端构建/测试、使用文档与迁移说明。

所有具体行为以 Spec 为准。前后端共用问题/选项稳定 ID，生成参数 singleCount+multipleCount 决定总数与比例。工作台 open-quiz(id, restart?) 事件交给 App；QuizPanel 使用 quizId/restart/chatBusy 属性，发出 close/explain/open-source/fullscreen-change 事件；App 保留面板状态与解释返回入口。Chat.sendExternalQuestion(question, {documentIds,mode,quizContext}) 不改写输入草稿和选择器。
