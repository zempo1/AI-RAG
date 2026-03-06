/**
 * md5.worker.ts
 * 在 Web Worker 中运行 SparkMD5 计算，避免阻塞主线程 UI。
 *
 * 消息协议（主线程 → Worker）：
 *   { file: File, chunkSize: number }
 *
 * 消息协议（Worker → 主线程）：
 *   { type: 'progress', percent: number }   — 每读完一片更新进度
 *   { type: 'done', md5: string }           — 计算完毕
 *   { type: 'error', message: string }      — 出错
 */
import SparkMD5 from 'spark-md5'

// 在 Worker 上下文里用类型断言替代 declare，避免与 DOM lib 的 self 冲突
const ctx = self as unknown as DedicatedWorkerGlobalScope

ctx.onmessage = (e: MessageEvent<{ file: File; chunkSize: number }>) => {
    const { file, chunkSize } = e.data
    const spark = new SparkMD5.ArrayBuffer()
    const totalChunks = Math.ceil(file.size / chunkSize)
    let currentChunk = 0

    const readNext = () => {
        const start = currentChunk * chunkSize
        const blob = file.slice(start, Math.min(start + chunkSize, file.size))

        blob
            .arrayBuffer()
            .then((buf) => {
                spark.append(buf)
                currentChunk++

                const percent = Math.round((currentChunk / totalChunks) * 100)
                ctx.postMessage({ type: 'progress', percent })

                if (currentChunk < totalChunks) {
                    readNext()
                } else {
                    ctx.postMessage({ type: 'done', md5: spark.end() })
                }
            })
            .catch((err) => {
                ctx.postMessage({ type: 'error', message: String(err) })
            })
    }

    readNext()
}
