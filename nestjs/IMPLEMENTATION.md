# 实施记录

依据：用户确认的 NestJS + 默认 MySQL 迁移计划。

- 原 backend、frontend、nest-backend 基线已保存于本机 test/original-files.sha256.json。
- 按用户要求在当前目录新增 nestjs，不创建 worktree，不自动提交。
- MySQL 默认启用，synchronize=false，migrationsRun=false；数据库不可用不降级。
- 业务层共用 Repository 接口；内存模式显式开启。向量始终只存内存。
- 分阶段先写兼容性测试，再实现，最终执行全套验证并记录限制。

## 实施结果

- 已实现全部已有 Controller API，NestJS 模块化分离业务与传输。
- 已锁定依赖；NestJS 12 的 ESM 依赖由 Node 22 require(esm) 加载，Jest 显式使用 VM Modules。
- 未使用 Nest CLI：其当前依赖要求更高 Node 补丁版本，改用 TypeScript 编译和 Node 原生 watch，避免引擎不兼容。
- 已核对实际原 MySQL 表结构；兼容原库混用 DATETIME/TIMESTAMP，不修改原表。
- 审查修复：SQL 直接绑定日期字符串，避免 UTC 宿主下重复偏移；新增真实 MySQL 往返回归测试。
- 审查修复：磁盘流式合并分片，新增 MAX_DOCUMENT_BYTES=128MiB 可配置资源限制；仍允许超过原单次请求10MiB的文档。
- 并发内存事务、中文上传文件名、浏览器断开取消均增加回归验证。
- 原目录85个文件的SHA-256基线一致。

## 验证与限制

- npm install、生产构建、18项单元测试、9项内存API测试已执行。
- 独立随机临时MySQL数据库5项测试已执行，覆盖真实持久化、UTC时区及完整上传/SSE API；测试后仅删除自己创建的临时库。
- 本地MiniLM真实推理通过：384维，文档/问题同文本相似度0.999999994。
- 生产启动入口已实际启动并返回401认证响应；MySQL不可达退出码1，不降级内存。
- OpenAI HTTP和SSE适配使用本地测试服务验证；未配置真实Chat API Key，未验证真实百炼生成。
- 尚未在浏览器逐页面验证原Vue前端；原接口契约通过HTTP测试，原前端源码保持不变。
