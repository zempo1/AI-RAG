# 通用问答质量评估

本目录包含 6 份合成文档和 60 道可审计题，覆盖技术手册、研究报告、教材、制度、设备手册和简单表格 PDF。PDF 根据 `documents.json` 在评估时生成，不依赖系统中文字体。没有使用私人简历。

**标注状态为 `authored_requires_human_review`：答案要点和证据已经编写，但尚未完成独立人工核对，不能宣传为人工验收通过。** 前 30 道为调参集，其余 30 道为独立验收集；不得根据验收结果反复调参后仍称独立测试。

在 `nestjs` 目录运行：

```powershell
npm run build
node scripts/evaluate-quality.cjs
# 阅读和审核题目、配置付费模型密钥与匹配的本地 tokenizer 后，才显式运行：
node scripts/evaluate-quality.cjs --live --tune
node scripts/evaluate-quality.cjs --live
```

默认仅输出 `not_run`，不会调用外部模型。`--live` 会调用真实 Embedding、查询规划、重排和聊天 API，可能发生费用；只处理本目录合成资料，不连接 MySQL 或 Qdrant，不读取真实用户文档。业务结构使用内存存储，原件使用运行结束即删除的临时目录。

模型配置沿用 `.env` 的独立服务地址、模型与密钥。必须提供 `EMBEDDING_API_KEY`、`CHAT_API_KEY`、`EMBEDDING_TOKENIZER`、`CHAT_TOKENIZER`；重排和规划可使用各自独立密钥。Tokenizer 必须与模型匹配，不以字符数估算 token。没有匹配配置则退出，不静默替代。

三个比较配置为：`vector`（当前向量模型直取前五片段，不扩展邻段）、`hybrid`（RRF 融合）、`hybrid-rerank`（混合后重排）。它们使用相同语料、当前 Embedding 与切分结果，比较的是检索策略；不是旧 MiniLM 与新模型的因果对照实验。

报告写入忽略目录 `.tmp/quality-evaluation-*.json`，包括逐题结果与分策略汇总：

- Recall@20、二值相关性 NDCG@20：使用标注原文片段映射到本次索引；证据无法映射时不得当作有效标注。
- 答案要点字符串匹配、拒答关键词匹配仅为启发式诊断，不能替代事实正确性评审。
- 引用编号/片段有效性只证明编号来自候选原文，不能证明原文支持回答。
- `correctness`、`completeness`、`citationSupport` 留空，等待人工按原文逐条审查；发布门禁保持 `uncalibrated / requires_human_review_and_threshold_calibration`。
- 记录响应耗时、P95 与本地 tokenizer 计数。供应商实际账单未对账时 `cost.status=not_available`，不将 token 数伪装成费用。

逐题错误、降级、模型超时必须保留，不能从分母剔除后宣称整体达标。90% 召回和正确率、95% 引用支持率是待验证目标；只有完成标注审核、真实模型执行与人工判分后才能判断是否达标。
