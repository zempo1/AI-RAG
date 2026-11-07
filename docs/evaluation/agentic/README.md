# Agentic RAG 对照实验

本目录新增40道可审计题，复用 `../accuracy/documents.json` 的六份合成文档。精确查找、多跳、跨文档比较、概览、证据不足和澄清分别有8、8、8、6、5、5题；按题目交替分为20道调参题及20道独立验收题。加上原有60道题后，两组各50题。

`annotationStatus=authored_requires_human_review`：期望要点和引文已经编写，并有自动检查确认引用文字确实存在于指定资料；这不等于独立人工判分。不得把 `research-paper.md` 中72%、84%、89%的合成报告数据当作本系统实测结果，也不得把自动字符串匹配当作答案正确率。

对照四种配置：

| 配置 | 行为 |
| --- | --- |
| fixed | 原有固定RAG，包含混合检索、重排和证据预算 |
| single-round | Agent只允许一轮业务工具执行，保留引用和权限检查 |
| agentic | 完整工具循环和证据反馈 |
| no-feedback | 保留工具循环与安全边界，移除模型证据反馈，用于消融 |

`preferredTools` 是审阅工具选择合理性的标签，不是模型必须照抄的固定执行序列。相同问题可能存在多条正确路径，不能以是否完全匹配预设路径代替答案质量评估。`evidence` 列出必须可核查的原文，`expectedPoints` 仅作辅助覆盖诊断；不足与澄清题须人工核对是否错误借用了相似型号、其他版本或未说明的事实。

实验须固定文档与已发布索引、Embedding/分块/模型配置，分别报告冷/热缓存。保留逐题输出、错误和降级，不从分母删除失败题。记录原文证据覆盖、引用支持、答案正确/完整性、拒答/澄清合理性、工具与模型请求次数、首次正文和总耗时、P50/P95以及供应商实际usage。

模拟运行只验证控制流和工程行为，不提供模型语义质量或真实调用费用结论。真实运行必须显式 `--live`，只使用本目录合成资料和内存业务存储，不连接生产MySQL/Qdrant、不读取用户文件。没有供应商usage或对账数据时，费用标记为未知，保守token估算单独列示。真实运行前可通过 `--limit` 限制样本数，调参只看调参集，最终验收不能反复用于调参。

重要质量核对：

- TS-999、E-17、AX-204/205的精确标识不能被语义近似替代。
- AX-206、v2.4.2、证书有效期及管理员手机号未给出，不能由常识补全。
- 扫描件实验明确未包含，不能推测其准确率。
- “它”“这份文档”等没有可靠指代时应澄清。
- 比较任务的每个目标来源均需提供支持，参数单位和场景不能混同。
- 任务达到上限后应说明证据不足或部分覆盖，不伪造完整总结。

## 可复现入口

从 `nestjs` 目录执行：

```powershell
npx tsc -p tsconfig.json --outDir .data/agentic-build
npm run eval:agentic -- --mock --limit 2 --output .data/agentic-smoke.json
npm run eval:agentic -- --tune --output .data/agentic-tune.json
npm run eval:agentic -- --output .data/agentic-acceptance.json
```

默认 `--mock`、默认独立验收集；`--limit` 限制每组题数。`--build-dir` 或 `AGENT_EVAL_BUILD_DIR` 可指定已编译目录，缺构建时给出隔离构建命令；脚本不编译、不修改 `dist`。`--output` 指定 JSON 报告路径。`--mock` 与 `--live` 不能同时使用，未知参数和无效 limit 直接失败。

模拟 Embedding 使用文本词项的确定性哈希向量，辅助规划/重排使用问题启发式；聊天模型只看问题、工具结果和已打包原文。期望要点、原文标签和 preferredTools 不传入模型生成器。实际 AgentService 状态图、五工具协议、预算 observer 的 before/settle、引用和原文读取仍实际执行。mock 全局禁止 fetch，并且不加载 `.env`，即使环境存在密钥也不会请求供应商。

真实运行须显式加 `--live`；例如先用 `--live --tune --limit 1` 检查配置模型工具支持。需要显式密钥与 tokenizer，详见 [运行与部署文档](../../agentic-rag.md)。四组手动共用 MemoryStore、InMemoryVectorStore 及同批发布索引；STORAGE_DRIVER 标记只用于启用现有检索实现中的规划/重排生产分支，不创建 SQL/Qdrant 客户端。只有临时目录中的合成原件会被读取，生成的简单 PDF 只来自 `documents.json`。

报告为每题保存输出、引用/证据、错误、降级、工具步骤、Agent预算、调用次数和总耗时；失败题保留，存在逐题失败时退出码非零。每组给出包含失败题的 P50/P95 与调用总数。当前使用一次性完整回答入口，首次正文时间留空；索引初始化调用单列。共享内存索引和进程缓存可能已热，摘要缓存每题清空，因此不将该运行解释为冷/热缓存基准。

providerUsage 保存供应商实际返回的 usage，缺失项为 null；本地请求预留估算、回答 token 计数与 Agent providerTokens 分开。cost.amount 保持 null、status=unknown，须另行对账。mock 的 scope=`functional_only`，质量指标全部为 null。live 同样不自动输出正确率，humanReview=`required`、releaseGate=`not_accepted`；人工审阅引用支持、子问题覆盖及拒答后才能给出质量结论。
