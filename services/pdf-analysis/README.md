# 本地 PDF 图像分析服务

Python 3.11 / FastAPI；PaddleOCR 3.7.0、PaddleX 3.7.0、PaddlePaddle CPU 3.3.1 固定版本。原计划 PaddlePaddle 3.4.0 在当前 PyPI（Windows 与 Linux/Python 3.11）不可获取，按实施裁决改用可安装的 3.3.1，不更改模型路线。

单独的 `spawn` 模型子进程同时预载 `PP-DocLayout-M`（standard）、`PP-DocLayout_plus-L`（high）、`PP-OCRv6_small_det/rec`，CPU 4 线程。PaddlePaddle 3.3.1 的 oneDNN PIR 路径对这些模型存在属性转换异常，因此显式关闭 MKL-DNN、使用 CPU kernel。模型子进程以模型目录为 cwd 并传 ASCII 相对目录，绕开 Windows native loader 的中文绝对路径问题；HTTP 父进程 cwd 不变。两个版面模型及带真实英数文本的 OCR 均执行预热，且 OCR 必须返回识别块后 health 才报告 ready。不要开启 uvicorn 多 worker/reload。

## 安装、下载与首次信任

在本目录用已安装的 Python 3.11 创建独立虚拟环境（不需要全局安装包）：

```powershell
py -3.11 -m venv .venv
.venv/Scripts/python -m pip install -r requirements.txt
.venv/Scripts/python prepare.py download --models models
# 明确检查下载来源与模型目录后，首次生成持久化信任清单：
.venv/Scripts/python prepare.py seal --models models
.venv/Scripts/python prepare.py verify --models models
.venv/Scripts/python prepare.py warmup --models models
./start.ps1
```

本次开发工作区已准备隔离的 `.model-deps` 和 `models`。在当前开发机可直接使用已验证的解释器启动，不重新下载依赖：

```powershell
./start.ps1 -Python 'E:/CodexData/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe' -DependencyDir '.model-deps'
```

这是本开发机的路径，其他机器按前述虚拟环境或容器方式部署。

`download` 只下载固定四个模型，不自动封印，也不覆盖已有模型。`seal` 记录全部模型文件 SHA-256、模型名称、包版本；已有 manifest 时拒绝覆盖。每次服务启动和子进程重建都核对已封印内容；文件新增、缺失或变化会阻止服务。升级请使用新模型目录，审核后显式生成新的清单；保存旧清单便于回滚。不要把未审核文件的 hash 作为自动信任依据。运行阶段使用本地显式模型目录，不调用模型下载命令。

仓库的 `model-manifest.lock.json` 固定本次实测的12个模型文件SHA-256；`seal` 会比对该清单，下载源的内容变化不能被静默接受。`requirements-win-py312.lock` 固定本次Windows CPU实测环境的76个依赖版本，仅用于Windows/Python3.12复现；Docker仍使用Python3.11和requirements.txt，尚未在本机Docker daemon中验收。

默认监听 `127.0.0.1:8091`。环境变量 `PDF_ANALYSIS_MODEL_DIR`、`PDF_ANALYSIS_HOST`、`PDF_ANALYSIS_PORT` 可改变模型目录和监听地址；仅容器/明确需要时设置 `PDF_ANALYSIS_HOST=0.0.0.0`。

## 容器

```sh
docker build -t pdf-analysis .
docker run --rm -v "$PWD/models:/models" pdf-analysis python prepare.py download --models /models
docker run --rm -v "$PWD/models:/models" pdf-analysis python prepare.py seal --models /models
docker run --rm -v "$PWD/models:/models:ro" pdf-analysis python prepare.py warmup --models /models
docker run --rm -p 127.0.0.1:8091:8091 -v "$PWD/models:/models:ro" pdf-analysis
```

## HTTP

- `GET /health` → `{ready:boolean,manifest:string,models:{schema,versions,models,files}}`。manifest 由规范化权重清单和服务算法版本共同生成 SHA-256，Node 缓存可直接使用；files 为每个模型文件的 SHA-256。
- `POST /v1/layout`：multipart `file`（PNG/JPEG/WEBP 单帧图像）、`precision=standard|high`（默认 standard），可选 `request_id` 或 `X-Request-ID`。返回 `{regions:[{kind,bbox,score}],manifest}`。
- `POST /v1/ocr`：相同 `file` 上传；返回 `{blocks:[{text,bbox,score}],manifest}`。

响应 `X-Request-ID` 回显请求标识。bbox 均为相对于整张输入图像的 `[x0,y0,x1,y1]`，范围 `[0,1]`。布局种类为 text/title/table/figure/caption/decoration/unknown；脚注、页眉页脚保守保留为 text，公式编号保留为 caption。拒绝路径、URL、额外字段、重复 multipart 字段。服务不执行视觉大模型调用。

页码分类仅在页边的小区域作为装饰；正文中的数字仍按文字保留。服务算法版本变动也会改变运行指纹，避免沿用旧的类别映射缓存。权重锁文件保持只描述模型本身。

默认请求体上限 40 MiB（含 chunked 流式计数）、图像 8 MP 加 20,000 像素的尺寸向上取整余量、最长边 4096；最多一个执行中推理、4 个排队任务及有界上传请求。推理硬时限 60 秒，请求总时限 90 秒（包含上传和排队）；队列满返回 503，大小超限返回 413，推理超时返回 504。客户端断开取消请求；执行中的取消、超时或模型进程异常会终止该子进程，以有上限的 join/kill 回收后重建预热，旧 native 调用不会占住推理槽。若 OS 无法杀死进程则服务失败关闭，不生成更多模型进程。

HTTP 不记录正文、OCR 文本或上传文件名；禁用 uvicorn access log 和模型子进程第三方 stdout/stderr。上传及结果只在有界内存内存活，不落临时用户文件、不建立用户数据缓存。模型校验清单和下载的权重单独持久化。

## 测试与验收

```sh
python -m pip install -r requirements-test.txt
python -m pytest
```

测试使用独立 spawn 的 fake backend，不导入 Paddle、不下载模型；覆盖 HTTP 契约、图像/流式 body 限制、校验清单漂移、运行中/排队取消、进程卡死硬超时、进程崩溃重建和排队总时限。真实模型须另外运行 `prepare.py warmup`、HTTP health/图像 smoke 与文档基准；fake 通过不表示 OCR 准确率或真实推理性能已经验收。当前执行环境只有 bundled Python 3.12，可运行 fake 测试；生产 Python 3.11 Docker 仍须在有 Docker daemon 的环境验证。

当前工作区已使用隔离依赖完成 Windows / bundled Python 3.12 的固定版本 import、四个官方 BOS 权重下载/封印、独立子进程四模型预热和 OCR 文本识别回归。原生回归通过设置 `PDF_ANALYSIS_REAL_MODELS` 为已封印权重目录后运行 `python -m pytest tests/test_real_models.py` 重现；默认测试会跳过此项，不下载权重。该结果不替代 Python 3.11/Linux 容器验收及用户文档端到端基准。

2026-11-04 真实 TCP HTTP smoke：health ready、12 个文件 SHA-256、request_id 回显、standard/high 布局与 OCR 及归一化 bbox 均通过。合成 720×256 英数文本图的单次时间分别为 standard 1.218 秒、high 3.547 秒、OCR 1.766 秒；这些数值仅说明接口可执行，不代表 PDF 吞吐或准确率。该次 manifest 为 `47d7f1287f208c504c203d6b824701e79bdedd3c9c4855ecf39c6c05cd72658a`。

API 参数依据官方源码及文档：[OCR pipeline](https://github.com/PaddlePaddle/PaddleOCR/blob/main/paddleocr/_pipelines/ocr.py)、[版面检测](https://github.com/PaddlePaddle/PaddleOCR/blob/main/docs/version3.x/module_usage/layout_detection.en.md)。实际包版本兼容性以固定依赖安装与模型 smoke 输出为准。
