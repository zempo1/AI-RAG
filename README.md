# AI RAG System

这是一个基于 **Vue 3 + TypeScript** 和 **Spring Boot + LangChain4j** 构建的 RAG (检索增强生成) 系统。
用户可以上传 PDF 或 Markdown 文件，系统会自动解析并向量化，然后用户可以针对文件内容进行提问。

## 项目结构

- `frontend/`: Vue 3 前端项目
- `backend/`: Spring Boot 后端项目

## 快速开始

### 1. 后端配置 (Backend)

首先配置 API Key。本项目默认配置为使用 **阿里云百炼 (通义千问)**，也支持 OpenAI。

打开 `backend/src/main/resources/application.properties` 文件：

```properties
# 阿里云百炼配置 (默认)
# 请将 sk-xxxxxxxxxxxxxxxxxxxxxxxxxx 替换为您在阿里云百炼控制台获取的 API Key
openai.api.key=sk-xxxxxxxxxxxxxxxxxxxxxxxxxx
openai.base-url=https://dashscope.aliyuncs.com/compatible-mode/v1
openai.model-name=qwen-plus

# 如果您想使用 OpenAI
# openai.api.key=sk-your-openai-key
# openai.base-url=https://api.openai.com/v1
# openai.model-name=gpt-3.5-turbo
```

### 2. 运行后端

确保你安装了 Java 17+ 和 Maven。

```bash
cd backend
mvn spring-boot:run
```

后端将在 `http://localhost:8080` 启动。

### 3. 运行前端

确保你安装了 Node.js。

```bash
cd frontend
npm install
npm run dev
```

前端将在 `http://localhost:5173` 启动。

### 4. 使用

1. 打开浏览器访问前端地址。
2. 在上传区域拖入 PDF 或 Markdown 文件。
3. 等待上传成功提示。
4. 在下方聊天框输入问题，AI 将根据文档回答。

## 技术栈

- **前端**: Vue 3, TypeScript, Vite, Element Plus, SCSS
- **后端**: Java 17, Spring Boot 3, LangChain4j
- **RAG**: In-memory Embedding Store (HNSW), OpenAI Chat Model, PDFBox
