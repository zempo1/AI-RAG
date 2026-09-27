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

/** 激活历史文件（重新 embed 至向量 store） */
export function activateDocument(id: number): Promise<void> {
    return request.post(`/api/documents/${id}/activate`)
}

/** 删除历史文件记录 */
export function deleteDocument(id: number): Promise<void> {
    return request.delete(`/api/documents/${id}`)
}