# PDF 表格识别可靠性修复计划

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** 原生表格不被重复生成，视觉裁剪与引用区域一致，非法结果不进入缓存，重试有总时限。

**Architecture:** 沿用 PDF.js 原生文字和坐标作为权威来源。版面识别后跳过已被可靠原生文字覆盖、且没有遗漏图像几何的表格/未知文字区；视觉表格保留自身边界，模型使用 JSON 模式并兼容明确不支持该参数的服务。视觉请求及修复共享总时限。

**Tech Stack:** NestJS、TypeScript、PDF.js 6.4.299、LangChain OpenAI adapter、Jest。

**Spec:** 本次对话的第 12 页排查及用户修复授权；证据位于 `.shared/stroke-pdf-diagnosis/diagnosis.md`。

## Global Constraints

- 在当前 `codex/pdf-show` 工作区修复，保留现有修改；不提交、不重建用户索引，不改写历史引用。
- 不调用外部付费 OCR/视觉模型；测试使用本地 HTTP 服务及固定版面夹具。
- 不通过猜测或字符串替换修补医学内容；原生提取结果始终保留。
- 新策略须使已有不合格最终解析缓存失效，但复用有效 OCR/版面识别缓存。

## Review Focus

- 仅有表头或缺失中间行的文字层不能掩盖扫描表格内容。
- 相邻表格、旁栏与邻表正文不得被绑定到同一个错误证据框。
- 服务只在明确拒绝 response_format 时降级；认证、限流和连接故障不得伪装为兼容问题。
- 双重转义输出须修复重试或失败，不能保存为成功结果；合法 JSON 的正常 Unicode 转义仍可用。
- 总时限和用户取消必须终止请求及后续重试；不影响共享队列释放。

### Task 1: 原生覆盖与表格边界

**Files:** `nestjs/src/modules/documents/parsers/adaptive-layout.ts`、`pdf-layout.ts`；`nestjs/test/hybrid-layout.spec.ts`。

- [x] 加入相邻表格、完整原生表格、稀疏文字层的 RED 回归测试。
- [x] 保留表格边界；对具备可靠原生覆盖且没有遗漏图像的区域省去视觉补充；表格上下文仅取框内文字。
- [x] 运行版面与 PDF 解析测试；用实际第 12 页和已有版面结果本地复核，无模型调用。

### Task 2: JSON 返回与缓存校验

**Files:** `nestjs/src/modules/llm/llm.types.ts`、`llm.service.ts`、`nestjs/src/modules/documents/parsers/pdf-visual.service.ts`；`nestjs/test/llm.spec.ts`、`pdf-hybrid-pipeline.spec.ts`。

- [x] 加入 JSON 参数实际 HTTP 请求、明确不支持时兼容、转义残留拒绝及缓存复核的 RED 测试。
- [x] 添加请求级 JSON 对象格式选项；仅明确的参数不支持错误允许一次无该参数重发。
- [x] 拒绝视觉输出中的 Unicode 转义残留；记录错误原因、输出长度和指纹，不记录原始文档内容或密钥。
- [x] 更新解析策略版本使最终解析结果缓存失效，同时保留独立 OCR 缓存。

### Task 3: 有界重试与验证

**Files:** `nestjs/src/modules/documents/parsers/pdf-visual.service.ts`、最终解析缓存实现及相关测试；`docs/pdf-source-viewer.md`。

- [x] 加入跨重试总时限、取消、请求日志结果的 RED 测试。
- [x] 单区域视觉处理以 `VISION_TIMEOUT_MS` 作为所有调用和修复共享总预算；为各次请求记录开始、结果及格式校验失败事件。
- [x] 跑后端完整 Jest、构建、API 测试；审查差异并记录真实 PDF 复核结果。

本轮直接执行修复，采用当前工作区及已有依赖；仅交付可审阅更改，不自动提交或合并。
