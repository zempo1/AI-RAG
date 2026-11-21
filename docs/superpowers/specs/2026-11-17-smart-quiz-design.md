# 智能测验与可调宽工作区

用户已批准：将工作台 AI 摘要标签替换为智能测验；选中单份就绪文档，配置 1～20 题（默认 10）、单选/多选或混合及整数题数比例。默认混合均分，奇数多一道单选。每题四个选项，多选 2～3 个正确答案。单选点击判题、多选提交判题；提交前不下发答案，提交后展示逐项解析。多选完全匹配得分，每题等权百分制。保存题集、草稿选择、当前题号和每次练习成绩，刷新可继续，重新练习保留旧记录。

默认右侧扩展面板保留聊天，可全屏及 Esc 退出。从来源阅读器返回原题。已提交题可点击解释：同库可写会话继续，否则新建；保留输入草稿与检索选择，聊天忙碌时禁用。全屏解释恢复双栏，窄屏显示聊天和返回测验入口。既有 stream-chat 增加可选 quizContext={attemptId,questionId}，后端构造权威题目上下文并限定来源，不改变普通聊天。

全局两根拖拽分隔线，覆盖左侧栏和所有右侧面板。桌面 >=1200px：左侧 240～420 默认300，窄工作台280～480默认300，右侧测验/阅读器/导图默认剩余区域50%、最小360，聊天最小360，动态钳制。折叠宽度沿用已有视觉尺寸，隐藏相应分隔线。分账号、分面板保存宽度；支持 pointer capture、键盘16px调整、Home/End、双击复位。窄屏禁拖拽、右侧覆盖显示。退出全屏恢复宽度与状态，PDF/导图重排和未保存离开确认继续生效。

独立 QuizzesModule，题集与练习记录两张表；复用 LlmService、Tokenizer、现有 SQL/BullMQ/memory 后台任务、模型快照和加密凭据。读取固定文档版本的原文分块，去重后按章节与位置分层选材，按上下文预算每批最多两题。验证题数比例、答案基数、四选项、逐项解析、证据归属及重复题干，每批最多一次修复，不足则明确失败，整套通过原子保存。未提交题不下发答案解析。

接口：POST /api/quizzes/generate {documentId,singleCount,multipleCount,requestId} ->202 {taskId,status}；GET /api/quizzes/workspace?knowledgeBaseId ->{items,generationTasks}；GET/DELETE /api/quizzes/:id；POST /api/quizzes/:id/attempts {requestId}；GET /api/quiz-attempts/:id；PATCH /api/quiz-attempts/:id/progress {currentIndex?,questionId?,selectedOptionIds?,submit?}。前端串行保存，后端原子锁、重复提交幂等。题集内问题 id=q1…，选项 id=A…D，题型 SINGLE/MULTIPLE。所有权隔离，删源级联取消任务/删除题集与练习；来源更新旧题可练习但禁 AI 解释；生成期间版本/索引改变终止。旧 SUMMARY 接口、历史数据和 RAG 摘要保留。

使用既有深色主题及 UI/UX Pro Max；无难度、分享导出、错题本、排行榜。增加迁移，覆盖空库和 schema:upgrade。验收覆盖判分/脱敏/权限/恢复/幂等/取消删源更新竞态，Playwright完整作答解释流程、双侧拖拽与三个右面板/全屏/窄屏。两端测试、构建与实际来源质量核对。
