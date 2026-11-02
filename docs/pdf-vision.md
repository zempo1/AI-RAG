# PDF 按内容分流与局部图片理解

PDF.js 在本地提取正文和位置，并检查图片及矢量绘图操作。纯文字页不调用视觉模型；混排页只把图片、表格、图表区域交给百炼，附带附近正文作为上下文。纯扫描页、文字乱码或无法可靠定位的复杂页面允许整页识别，并记录原因。

正文使用 `[图片文字识别]`、`[表格识别]`、`[模型生成的图解]` 区分来源。图片描述建立检索子块，附近正文参与向量、关键词及重排；原文证据分别保留准确偏移，命中后一起展开。普通及流式问答只发送文字证据，不再发送图片，也不会声称核对了原图。

## 配置与运行

```dotenv
VISION_ENABLED=true
VISION_MODEL=qwen3.8-flash
VISION_BASE_URL=
VISION_API_KEY=
VISION_TIMEOUT_MS=180000
VISION_OUTPUT_TOKENS=8192
PAGE_ASSETS_DIR=.data/pages
```

地址和密钥为空时分别继承服务端 `CHAT_BASE_URL`、`CHAT_API_KEY`。API 与 Worker 共享持久化的 `PAGE_ASSETS_DIR` 和 `ORIGINALS_DIR`，使用一致配置。更新代码后构建并重启两者。沿用现有 PDF.js 与 `@napi-rs/canvas`，无需部署独立 OCR。

本地可能渲染混排页以获取准确图形边界；正常情况下只上传裁剪区域。重复水印依据本地图片内容、位置、透明度和跨页重复情况判断；重复页边装饰不单独触发识别。复杂版面仍可能整页兜底，不能保证每份资料都减少调用次数。

## 缓存、引用与兼容

资源路径按用户、文档、版本、配置指纹隔离。新区域资源为 `<页码>-<区域标识>.png/json`，包含归一化边界框、区域类型、上下文及原生文字校验值、图片字节数与 SHA-256。配置指纹包含分流/裁剪版本、模型、地址、提示词和渲染预算，不含密钥。成功区域独立复用；失败重试不重复调用同页已成功的区域。模型错误不会改用整页请求重试。

取消、替换及删除会检查任务执行权。全部解析和向量写入成功后才切换索引；失败继续服务已有索引。删除后立即拒绝图片访问，后台清理资源。

新引用使用 `location.regionImage = { versionId, page, profile, regionId, bbox, kind }`。`bbox` 为旋转后页面左上角起始的归一化 `[x0,y0,x1,y1]`；`kind` 为 `region`、`scan` 或 `fallback`。附近正文通过 `relatedParagraphs` 关联。引用面板展示识别文字和对应局部图/整页来源。

```text
GET /api/documents/:id/versions/:versionId/pages/:page/regions/:regionId/image?profile=<指纹>
GET /api/documents/:id/versions/:versionId/pages/:page/image?profile=<指纹>  # 历史引用
Authorization: Bearer <token>
```

两种接口均校验用户、知识库、文档、版本和删除状态，返回 `image/png`、`private, no-store`。前端使用鉴权 Blob URL，切换或关闭引用时释放。

无需数据库迁移；保留旧 `pageImage` 和历史索引。已有 PDF 点击“重建索引”后应用新分流；缺少原件的历史 PDF 提示重新上传。关闭 `VISION_ENABLED` 后仍可提取文字。Markdown 和长文分析覆盖范围保持现有行为。

## 验证与开销观测

```powershell
cd nestjs
npm test
npm run test:e2e
npm run build
npm run test:vision -- --live       # 合成混排样例解析 + 纯文字问答
npm run test:vision -- --live --scan
node scripts/pdf-regions-benchmark.cjs --file <PDF路径> --pages 2,23
# 加 --live 对所选页面分别进行整页基线与区域解析，产生真实费用
# --build-dir 可指定独立构建目录；--output 可指定报告目录
cd ../frontend
npm test
npm run test:e2e
npm run build
```

`pdf-document-layout` 记录文字页、区域、扫描页与兜底页数；`pdf-page-layout` 记录兜底原因和本地耗时；`pdf-region` 记录缓存命中、图片像素/字节与调用耗时；`vision_usage` 记录模型服务报告的输入/输出 token。日志不记录密钥或正文。

2026-11-02 用用户物理层课件第 2、23 页真实对比：整页方式 2 次调用，输入 3,647、输出 122 token，输入图片 3,110,400 像素，约 4.45 秒；区域方式 1 次调用，输入 656、输出 131 token，393,078 像素，约 2.35 秒。第 2 页跳过视觉，第 23 页保留光纤结构与全反射关系描述。报告位于本地忽略目录 `.data/region-benchmark/physics-ready/report.json`。这是少量样例结果，耗时受网络影响，不能作为固定节省率。
