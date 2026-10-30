import request from '../utils/request'

export interface DocumentSummary {
    id: number
    filename: string
    uploadTime: string // ISO string
}

/** 获取当前用户历史文件列表 */
export function listDocuments(): Promise<DocumentSummary[]> {
    return request.get<any, DocumentSummary[]>('/api/documents')
}

/** 激活历史文件：已就绪的索引直接复用，首次索引允许更长处理时间。 */
export function activateDocument(id: number): Promise<void> {
    return request.post(`/api/documents/${id}/activate`, undefined, { timeout: 180000 })
}

/** 删除历史文件记录 */
export function deleteDocument(id: number): Promise<void> {
    return request.delete(`/api/documents/${id}`)
}
