# PDF 本地版面检测与 OCR

`PDF_ANALYSIS_MODE=legacy` 为兼容缺省值。`hybrid` 保留 PDF.js 的正文，使用本地 PaddleOCR 模型定位版面、补充扫描文字，图表关系继续由现有百炼视觉接口解释。普通及流式问答只接收检索文字。首次上传必须等完整识别和向量化成功，重建期间仍使用原可用索引。

## 运行

本地模型服务位于 `services/pdf-analysis`，使用 Python 3.11。按照该目录 README 完成依赖安装、模型准备和校验后启动；默认地址为 `http://127.0.0.1:8091`。模型准备与启动分离，启动不应自动接受被替换的权重。服务 `/health` 就绪后，设置后端环境：

```dotenv
PDF_ANALYSIS_MODE=hybrid
PDF_ANALYSIS_NATIVE_FAST_PATH=true
PDF_ANALYSIS_URL=http://127.0.0.1:8091
PDF_ANALYSIS_TIMEOUT_MS=95000
VISION_ENABLED=true
VISION_CONCURRENCY=3
```

也可初始化独立容器的模型卷后启动：

```sh
docker compose --profile pdf-analysis build pdf-analysis
docker compose --profile pdf-analysis run --rm pdf-analysis python prepare.py download --models /models
docker compose --profile pdf-analysis run --rm pdf-analysis python prepare.py seal --models /models
docker compose --profile pdf-analysis run --rm pdf-analysis python prepare.py warmup --models /models
docker compose --profile pdf-analysis up -d pdf-analysis
```

容器内模型服务地址与开发机地址不同；若 Worker 也在容器内，配置为 `http://pdf-analysis:8091`。服务端口仅绑定开发机回环地址，不提供面向浏览器的接口。

API/Worker 需使用一致解析配置和持久资源目录。用户已有 PDF 通过“重建索引”应用新策略；历史引用继续按旧路径读取。需要本地识别而服务不可用时 hybrid 明确失败，继续保留旧索引，不自动改用整页视觉识别；纯文字和明确的原生图文快速路径不依赖本地服务。需要回退时显式配置 `legacy`，不会删除缓存或索引。

## 数据与质量

- 原生文字层可靠、实际绘图边界明确的页面走快速路径，直接裁剪矢量图或局部嵌入图片交百炼，避免重复执行本地版面网络。栅格图片还要求有可靠的图外正文，不能用图片内OCR层冒充图外正文。扫描、乱码、文字不足、无框线表格疑点及无法可靠定位的页面继续走版面/OCR模型。可用 `PDF_ANALYSIS_NATIVE_FAST_PATH=false` 强制版面模型对比验证。

- 版面模型默认 PP-DocLayout-M，困难页二次使用 PP-DocLayout_plus-L；OCR 使用 PP-OCRv6_small。模型和本地推理仅使用 CPU，不要求 CUDA。
- 本地渲染页面用于定位不产生百炼图片 token；正常情况下只发送真实图表裁剪。扫描文字由本地 OCR 识别；不可靠结果允许局部视觉补识别。
- 文字快路径必须检查无框线表格等结构疑点。图中文字齐全不意味着连线、坐标轴等关系已经提取。
- 不能以区域小为由删除图，不能仅以 OCR 平均置信度为由认定正文完整。图表和文字覆盖均应在固定样例中验证。
- 布局、OCR、图解缓存使用独立指纹；执行并发不进入指纹。资源继续按用户、文档、版本隔离。缓存复用的描述必须重新绑定当前位置。

## 基准

先独立编译，避免改写开发服务正在监视的 dist：

```powershell
cd nestjs
npx tsc -p tsconfig.json --outDir .data/hybrid-build
node scripts/pdf-hybrid-benchmark.cjs --file "<PDF绝对路径>" --build-dir .data/hybrid-build --pages 39,74
```

默认只调用本地服务，视觉响应为模拟数据；报告不能用来证明图表语义识别正确。去掉 `--pages` 检测整份 PDF；`--modes legacy` 可单独建立旧流程基线。每种模式分别记录首次和缓存重跑，两模式缓存目录相互隔离。`--delay-ms` 设置模拟视觉延迟。报告只保存统计和服务提供的 token 用量，不保存提示词、正文和密钥。

`--live` 才启用真实视觉请求，全次运行硬性限制 12 次调用（包括结构修复），达到上限明确失败并保存已完成报告。请仅选少量真实图表页；不要对完整旧文档发出数百次付费基线请求。

人工验收锚点在 `nestjs/test/fixtures/pdf-hybrid-gold.json`。CH3 176 页旧本地算法为 490 个候选区域（234 个面积小于 5%）；候选数量不是实际计费次数。第39页预期零视觉请求，第74页完整保留底部时隙图。应同时核对重要图表、数字、关系、页码和有效分辨率，再评估调用数、实际token、总时延和内存。完整真实模型验收通过前保持 legacy；不承诺固定节省比例或15秒完成。

2026-11-04 全量旧流程模拟基线：176页、490次模拟视觉请求，本地处理加每次5ms模拟延迟合计23.40秒；缓存重跑5.25秒、零模型请求。报告位于本地 `.data/ch3-hybrid-baseline/report.json`。该数据仅核实候选数、裁剪成本和缓存行为，绝不是百炼真实识别速度。

## 2026-11-05 实测与默认选择

主要根因是 PDF.js `constructPath(endPath)` 只建立裁剪范围，其记录边界可能包含后续文字；旧算法把它当作绘图。现在 legacy/hybrid 都忽略这些非绘制操作，仍保留真正 stroke/fill、图片和图表。默认 legacy 因此也直接获得优化。

同一176页CH3、文档缓存为空、视觉响应固定模拟500ms、并发3，解析阶段结果如下（不包含向量化）：

| 流程 | 区域 | 模拟视觉调用 | 本地版面/OCR调用 | 解析耗时 |
|---|---:|---:|---:|---:|
| 改造前 | 490 | 490 | 0/0 | 91.24秒 |
| 优化后的默认兼容流程 | 86 | 86 | 0/0 | 22.14秒 |
| 混合流程，逐页模型判断 | 93 | 85 | 139/9 | 274.04秒 |
| 混合流程，开启原生图文快路径 | 82 | 79 | 74/3 | 149.58秒 |

这份原生课件使用优化后的兼容路径最快，因此仍保持 `PDF_ANALYSIS_MODE=legacy`，没有为了引入本地模型而默认切换更慢的流程。hybrid 已实现并可用于确需本地扫描 OCR/困难版面的场景；其收益需按文档和硬件评估。新增原生快速分流把本机混合流程从274秒降到150秒，但不能把区域减少比例当成实际总时延或token降幅。各组缓存重跑均为零视觉请求。内存报告为Node进程20ms采样峰值，未包含独立Python模型进程。

真实本地模型验收：第39页零区域/零模型；第74页一个完整时隙图（48,111像素）；中文扫描文字2行及CRC/FCS均识别，最低置信度0.9577。真实百炼验证共3次：CH3第74页407 token，CH2第23页两次1052/975 token，合计2434 token；输入均为局部图，未对整份文件进行付费对照。图解属于模型生成内容，引用保留原图供核对。固定样例不是所有图表语义都准确的保证。

原始报告分别在 `nestjs/.data/ch3-original-delay500`、`ch3-fixed-delay500`、`ch3-final-hybrid-all`、`ch3-final-hybrid-native-regions`、`ch3-final-live`、`physics-final-live` 和 `physics-final-live-v2`。这些本地报告不提交文档正文与图片到Git。
