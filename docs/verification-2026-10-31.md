# 多知识库改造验收记录

日期：2026-10-31。工作分支：codex/knowledge-base-pipeline。全部变更保留在工作区，未提交、未推送；未执行业务数据库迁移。

| 验证 | 结果 |
| --- | --- |
| NestJS TypeScript 构建 | 通过 |
| 后端单元测试 | 14 suites，39 tests 通过 |
| HTTP/SSE 接口回归 | 10 tests 通过 |
| 真实 MySQL / Redis / Qdrant 集成 | 2 suites，12 tests 通过 |
| 前端 SSE 解码测试 | 2 tests 通过 |
| Edge 无头浏览器验收 | 6 tests 通过 |
| Vue 类型检查与 Vite 生产构建 | 通过 |
| 本地 MiniLM 实际推理烟测 | 384 维，同文本余弦 0.999999994 |
| git diff --check | 通过 |

真实服务测试使用专用 Compose 测试容器以及随机命名的数据库、collection 和队列，覆盖独立 Worker 进程、Worker 重启、Redis 实际停止恢复、版本替换、重建、清理和引用 JSON 持久化。外部 Embedding/LLM 在这组测试中使用确定性测试响应，真实本地 Embedding 由单独烟测验证。没有调用用户的在线聊天模型，也没有伪造真实问答质量分数。

浏览器测试覆盖正常答案只显示一次、引用抽屉、流式失败终态、跨库分类筛选重置、替换完成刷新、失败后手动重试刷新、已删除知识库历史只读。已查看生成的文档管理截图，修正浅色抽屉继承深色主题文字导致的对比度问题。

独立审阅发现的迟到执行清除生效索引、删除破坏进行中请求快照、派生产物删除竞态，以及前端恢复流程问题均已修正并验证。

构建仍提示现有 Sass legacy API 与大体积前端 bundle；不影响构建结果。扫描 PDF 不支持 OCR，旧数据无原件时无法还原页码。更换 Embedding 模型需要单独迁移向量。

测试结束后，已停止本次创建的 mysql-test、redis-test、qdrant-test 容器。正式启动前按 nestjs/README.md 配置服务，并显式执行适用于已有库或空库的迁移命令。
