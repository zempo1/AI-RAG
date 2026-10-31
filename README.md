# 多知识库 RAG 系统

毕业设计项目，使用 Vue 3、NestJS、MySQL、Qdrant 和 Redis/BullMQ，支持 PDF/Markdown 的上传、异步解析、检索问答与引用溯源。

- 用户私有知识库、一级文档分类、文档筛选和管理。
- 分片续传、后台处理进度、失败重试和独立 Worker。
- 文件级增量更新、新旧索引切换、文档删除、单文档及全库重建。
- 按指定知识库问答，先过滤后 TopK；回答引用可查看原文、页码和段落。
- 历史引用快照，以及摘要、大纲、学习卡片和思维导图。

## 本地运行

要求 Node.js >=22.21.1、MySQL、Docker Compose。

在项目根目录启动向量库和队列：

    docker compose up -d redis qdrant

后端配置、现有数据库升级和详细测试说明见 [nestjs/README.md](nestjs/README.md)。现有数据库需要显式升级；应用启动不会自动改表。

    cd nestjs
    npm install
    Copy-Item .env.example .env
    # 填写数据库连接、JWT_SECRET 和模型配置
    npm run schema:upgrade
    npm run start:dev

另开终端启动 Worker：

    cd nestjs
    npm run start:worker:dev

再开终端启动前端：

    cd frontend
    npm install
    npm run dev

前端默认通过 /api 代理访问 localhost:8080。空数据库应使用 npm run migration:run 初始化；不要对已有数据库运行空库初始化。

答辩用资料与评估流程见 [docs/evaluation](docs/evaluation/README.md)。
