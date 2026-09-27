import request from '../utils/request'

const BASE = '/api/upload'

export interface CheckResult {
    uploaded: boolean
    uploadedChunks?: number[]
}

/** 秒传检测 + 查询已上传分片 */
export function checkUpload(md5: string, filename: string): Promise<CheckResult> {
    return request.get<any, CheckResult>(`${BASE}/check`, {
        params: { md5, filename },
    })
}

/** 上传单个分片 */
export function uploadChunk(
    chunk: Blob,
    md5: string,
    chunkIndex: number,
    totalChunks: number,
    filename: string,
    onProgress?: (percent: number) => void,
): Promise<void> {
    const form = new FormData()
    form.append('file', chunk, `chunk_${chunkIndex}`)
    form.append('md5', md5)
    form.append('chunkIndex', String(chunkIndex))
    form.append('totalChunks', String(totalChunks))
    form.append('filename', filename)

    return request
        .post(`${BASE}/chunk`, form, {
            headers: {
                'Content-Type': 'multipart/form-data',
            },
            onUploadProgress: (e) => {
                if (onProgress && e.total) {
                    onProgress(Math.round((e.loaded / e.total) * 100))
                }
            },
        })
        .then(() => { })
}

/** 通知后端合并分片 */
export function mergeChunks(
    md5: string,
    filename: string,
    totalChunks: number,
): Promise<{ message: string; filename: string }> {
    return request.post<any, { message: string; filename: string }>(`${BASE}/merge`, {
        md5,
        filename,
        totalChunks,
    })
}