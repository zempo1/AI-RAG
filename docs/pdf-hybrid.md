# PDF 自适应解析

PDF 使用一条自动分流链路。PDF.js 优先保留原生文字和坐标。扫描正文使用 PaddleOCR，文字型位图在本地检测文字和结构，明确图表交给视觉模型，边界不确定时按需调用一次 PP-DocLayout-M。问答读取索引中的文字证据。

## 运行

本地模型服务位于 `services/pdf-analysis`，使用 Python 3.11。按照该目录 README 完成依赖安装、模型准备和校验后启动；默认地址为 `http://127.0.0.1:8091`。模型准备与启动分离，启动不应自动接受被替换的权重。服务 `/health` 就绪后，设置后端环境：

```dotenv
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

API 和 Worker 使用一致的配置和资源目录。请从旧环境删除 `PDF_ANALYSIS_MODE` 与 `PDF_ANALYSIS_NATIVE_FAST_PATH`，两项配置均已停用。升级本地模型服务后再启动新版 Worker。纯文字与明确矢量图无需访问本地模型，遇到需要本地模型的内容时，服务故障会让任务明确失败。`VISION_ENABLED=false` 仅提取原生文字。

## 数据与质量

- 普通或分片上传进入同一后台任务。识别完成的页面按原顺序输出，切块与后续页面的识别重叠。百炼向量请求每批最多 10 条，同一进程最多两批并行。
- 全部切块和向量写入成功后发布索引。重建中仍可查询旧索引，取消或失败不会切换可用版本。历史引用继续按原路径读取。
- 纯文字页不渲染，也不调用本地模型或百炼。确认纯文字的图片复用文字检测框做 OCR，文本密集的流程图仍需视觉理解。
- OCR 置信度或覆盖不足时，只对缺失文字区域或当前裁剪补识别。接口超时和服务错误直接报告。整页视觉保留给无法可靠分离的页面。
- 布局、OCR、图解和向量缓存按用户、文档及版本隔离，绑定输入和模型配置。缓存复用的描述和向量重新绑定本次来源及索引。

## 基准

先独立编译，避免改写开发服务正在监视的 dist：

```powershell
cd nestjs
npx tsc -p tsconfig.json --outDir .data/hybrid-build
node scripts/pdf-hybrid-benchmark.cjs --file "<PDF绝对路径>" --build-dir .data/hybrid-build --pages 39,74
```

默认只调用本地服务，视觉响应为模拟数据；报告不能用来证明图表语义识别正确。去掉 `--pages` 检测整份 PDF。脚本分别记录首次和缓存重跑。`--delay-ms` 设置模拟视觉延迟。报告只保存统计和服务提供的 token 用量，不保存提示词、正文和密钥。

本地模型未就绪时可加 `--mock-local` 检查裁剪、调度和缓存，模型结果以固定模拟响应代替。该参数会改变分流结果，只用于工程验证，不能与 `--live` 同时使用。

`--live` 才启用真实视觉请求，全次运行硬性限制 12 次调用（包括结构修复），达到上限明确失败并保存已完成报告。请仅选少量真实图表页；不要对完整旧文档发出数百次付费基线请求。

人工验收锚点在 `nestjs/test/fixtures/pdf-hybrid-gold.json`。CH3 176 页旧本地算法为 490 个候选区域（234 个面积小于 5%）；候选数量不是实际计费次数。第39页预期零视觉请求，第74页完整保留底部时隙图。应同时核对重要图表、数字、关系、页码和有效分辨率，再评估调用数、实际token、总时延和内存。

统一后的两页工程回归使用 `--mock-local --delay-ms 500`。第 39 页零识别请求，第 74 页有一个局部视觉请求（85,104 像素），裁剪保留时隙图及编号。两页合计首次约 1.00 秒，缓存重跑约 0.08 秒且没有识别请求。该数据只含解析阶段，本地和云端模型输出均为模拟响应。

2026-11-04 全量旧流程模拟基线：176页、490次模拟视觉请求，本地处理加每次5ms模拟延迟合计23.40秒；缓存重跑5.25秒、零模型请求。报告位于本地 `.data/ch3-hybrid-baseline/report.json`。该数据仅核实候选数、裁剪成本和缓存行为，绝不是百炼真实识别速度。

## 历史基线（统一前）

主要根因是 PDF.js `constructPath(endPath)` 只建立裁剪范围，其记录边界可能包含后续文字；旧算法把它当作绘图。现在 legacy/hybrid 都忽略这些非绘制操作，仍保留真正 stroke/fill、图片和图表。默认 legacy 因此也直接获得优化。

同一176页CH3、文档缓存为空、视觉响应固定模拟500ms、并发3，解析阶段结果如下（不包含向量化）：

| 流程 | 区域 | 模拟视觉调用 | 本地版面/OCR调用 | 解析耗时 |
|---|---:|---:|---:|---:|
| 改造前 | 490 | 490 | 0/0 | 91.24秒 |
| 优化后的默认兼容流程 | 86 | 86 | 0/0 | 22.14秒 |
| 混合流程，逐页模型判断 | 93 | 85 | 139/9 | 274.04秒 |
| 混合流程，开启原生图文快路径 | 82 | 79 | 74/3 | 149.58秒 |

这些历史数据只用于对照，采样内存仅包含 Node 进程，不包含 Python 模型进程。

真实本地模型验收：第39页零区域/零模型；第74页一个完整时隙图（48,111像素）；中文扫描文字2行及CRC/FCS均识别，最低置信度0.9577。真实百炼验证共3次：CH3第74页407 token，CH2第23页两次1052/975 token，合计2434 token；输入均为局部图，未对整份文件进行付费对照。图解属于模型生成内容，引用保留原图供核对。固定样例不是所有图表语义都准确的保证。

原始报告分别在 `nestjs/.data/ch3-original-delay500`、`ch3-fixed-delay500`、`ch3-final-hybrid-all`、`ch3-final-hybrid-native-regions`、`ch3-final-live`、`physics-final-live` 和 `physics-final-live-v2`。这些本地报告不提交文档正文与图片到Git。
