# PDF 图片文字与图表理解

PDF 索引任务保留原生文字，并将每页渲染为 PNG，调用百炼视觉模型补充图片文字、Markdown 表格和图解。正文中的 `[图片文字识别]`、`[表格识别]`、`[模型生成的图解]` 标记区分来源。模型无法辨认的内容应明确说明，仍需结合原图核对。

## 配置与部署

在 `nestjs/.env` 按需配置以下变量；新增变量的默认值已生效，不必复制真实密钥到其他位置：

```dotenv
VISION_ENABLED=true
VISION_MODEL=qwen3.8-flash
VISION_BASE_URL=
VISION_API_KEY=
VISION_TIMEOUT_MS=180000
VISION_OUTPUT_TOKENS=8192
PAGE_ASSETS_DIR=.data/pages
```

- 地址为空时继承 `CHAT_BASE_URL`；视觉密钥优先使用 `VISION_API_KEY`，其次为问答请求的密钥和服务端 `CHAT_API_KEY`。后台解析没有请求密钥，必须有服务端视觉或聊天密钥。
- API 与 Worker 必须共享持久化的 `PAGE_ASSETS_DIR` 和 `ORIGINALS_DIR`，并使用相同的视觉配置。更新依赖后重新构建、重启两者。`@napi-rs/canvas` 已作为正式依赖固定版本；安装时不要省略其平台二进制包。
- 不要将页面目录配置为公开静态目录。识别时页面会发送给所配置的视觉服务，并产生按量费用。长 PDF 的首次索引时间会增加。
- 可通过 `VISION_ENABLED=false` 关闭后续索引的视觉解析；已有视觉索引仍依赖其页面图片和视觉模型配置。
- 本次数据扩展使用既有 `location` JSON 字段，无需新增数据库迁移；旧索引仍可读取。

## 索引、缓存与兼容

页面 PNG 与成功解析清单按 `用户/文档/版本/配置指纹/页码` 保存。指纹包含模型、接口地址、解析提示词、渲染参数和输出预算，不包含密钥。重试复用成功页面，缓存损坏或配置变化时重新解析；整份文档解析和向量写入成功后才发布索引。

缓存清单记录图片字节数与 SHA-256；命中时核对完整性，截断或损坏图片以及缺少校验信息的旧清单重新生成。

临时模型故障沿用原有最多三次任务尝试；失败信息包含页码。取消、替换或删除任务时，在页面处理边界核对任务执行权，旧任务不能发布结果。删除文档后立刻拒绝原图访问，后台等待索引任务终止后清理原件及页面缓存。历史版本资源保留到文档删除，支持历史引用。

已有 PDF 需要点击文档的“重建索引”，或者使用现有 `POST /api/documents/:id/reindex`。没有原件的历史 PDF 在启用视觉解析时提示重新上传；Markdown 与原有长文分析范围保持不变。

## 问答与页面接口

检索继续使用文本向量和关键词索引。视觉块及父块保留 `location.contentType`、`location.pageImage = { versionId, page, profile }`；不同内容类型不合并为一个父块。普通及流式问答按证据顺序选择最多三张不同页面原图核对，原图不可访问时明确失败，不静默声称已核对。

页面读取接口：

```text
GET /api/documents/:id/versions/:versionId/pages/:page/image?profile=<64位指纹>
Authorization: Bearer <token>
```

接口校验用户、知识库、文档、版本和删除状态，返回 `image/png`，使用 `private, no-store`。引用抽屉通过鉴权请求创建临时 Blob URL，并在切换、关闭时释放；删除来源只显示已保存的文字快照。

## 验证

```powershell
cd nestjs
npm test
npm run test:e2e
npm run build
npm run test:vision              # 不调用模型
npm run test:vision -- --live    # 付费真实调用：一页解析及一次带图问答
npm run test:vision -- --live --scan  # 将样页变成无文字层的扫描 PDF 再验证
cd ../frontend
npm test
npm run test:e2e
npm run build
```

真实样例包含原生文字、图片代码、表格、柱状图和矢量流程图，产物位于忽略目录 `nestjs/.data/vision-smoke`。重复执行会复用页面解析缓存，但仍会进行带图问答。`vision_usage` 日志记录每次视觉调用的模型、图片数和服务端报告的 token 用量；不记录页面内容或密钥，不将 token 数折算成未经核实的费用。

2026-11-02 实测：图片代码 `IMAGE-CODE-42`、表格 `Alpha=42/Beta=18`、柱状图差值 `10`、流程 `Review → Publish` 均正确。首次解析 2,356 token，带图问答 2,143 token，共 4,499 token；这是单个清晰样例的验收结果，不代表所有资料的识别准确率。

同页栅格化为完全无文字层的扫描 PDF 后，上述检查也全部通过：解析 2,367 token，问答 2,135 token，共 4,502 token。两种样例四次实际调用共 9,001 token。
