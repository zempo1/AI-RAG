# 账号级模型设置

侧边栏顶部的钥匙按钮打开「模型设置」。每类用途保存当前一套配置，切换无需修改环境文件或重启服务。配置仅对当前账号生效。

## 使用

1. 选择对话、Agent、图片理解、查询规划、向量化或重排。
2. 选择接口协议，填写 API 地址、完整模型名称和对应的 Key。聊天和向量化填写 Base URL；重排填写完整接口 URL。
3. 点击「保存当前配置」。Key 不回显；同一地址留空表示保持原 Key。修改地址必须填写对应 Key。
4. 「恢复服务端默认」删除当前用途的账号设置。Agent 未单独配置时跟随自定义对话配置，其余用途保持各自的环境默认配置。

对话模型负责最终回答、文档分析和思维导图；Agent 模型负责规划、工具调用、证据评估和章节摘要。

硅基流动 BGE-M3 示例：

| 字段 | 内容 |
| --- | --- |
| 用途 | 向量化 |
| 接口协议 | 硅基流动 |
| API 地址 | `https://api.siliconflow.cn/v1` |
| 模型名称 | `BAAI/bge-m3` |
| API Key | 你在硅基流动创建的 Key |
| 向量维度 | 1024 |
| 发送 dimensions | 关闭 |

保存后，已有文档需要从文档管理中「重新索引」或「重建知识库」。系统不会自动重建。只更换同一服务的 Key 无需重建。重建逐文档发布，失败文件保留旧索引；检索范围包含不兼容旧索引时会提示先重建，通用聊天、原文和历史回答仍可使用。

已有任务继续使用接收时的配置，包括重试。修改配置后请新建任务，或通过重新索引/重建使用新配置；「重试」继续使用旧任务的配置。

旧浏览器中的 `user_api_key` 不再随请求自动发送。可在对话设置中主动点击「导入旧浏览器 Key」，保存成功后清除浏览器旧 Key。

## 数据库升级

已有安装在 `nestjs` 目录执行 `npm run schema:upgrade`，新增 `user_model_settings` 表；全新数据库执行原有 `npm run migration:run`。升级不重建业务索引。

Key 与后台任务的模型快照使用 AES-256-GCM 加密，密钥由现有 `JWT_SECRET` 按独立用途派生。API 和 Worker 必须使用相同且稳定的 `JWT_SECRET`；更换它会使既有加密凭据无法解密。出现解密错误时，可打开设置重新填写 Key 或恢复默认；设置管理、历史和原文读取不依赖凭据解密。接口仅返回 `hasApiKey`，不返回 Key 或密文。

## 接口

- `GET /api/model-settings`：返回当前账号六类用途的有效非敏感配置，来源为 `system`、`custom` 或 `chat`。
- `PUT /api/model-settings/:role`：保存当前用途，字段为 `provider`、`baseUrl`、`model` 和可选 `apiKey`；向量化另需 `dimensions`、`sendDimensions`。
- `DELETE /api/model-settings/:role`：恢复服务端默认。

`role` 为 `chat`、`agent`、`vision`、`queryPlan`、`embedding`、`rerank`。自定义协议为 `dashscope`、`siliconflow`、`openai-compatible`；重排仅支持前两种。`baseUrl` 在重排用途表示完整接口 URL。

请求通过 AsyncLocalStorage 绑定账号和不可变配置快照。后台问答及索引任务恢复加密快照，不依赖 API 进程的内存配置。索引记录非敏感模型身份；旧索引指纹保持兼容，历史远程索引的地址按原环境地址解释。

本次不提供多套配置管理、额度监控、自动切换、模型列表发现或自动重建。
