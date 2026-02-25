import axios from 'axios'

const authHeader = () => ({
    Authorization: `Bearer ${localStorage.getItem('token')}`,
})

export interface DocumentSummary {
    id: number
    filename: string
    uploadTime: string // ISO string
}

/** 获取当前用户历史文件列表 */
export function listDocuments(): Promise<DocumentSummary[]> {
    return axios.get('/api/documents', { headers: authHeader() }).then((r) => r.data)
}

/** 激活历史文件（重新 embed 至向量 store） */
export function activateDocument(id: number): Promise<void> {
    return axios.post(`/api/documents/${id}/activate`, null, { headers: authHeader() }).then(() => { })
}

/** 删除历史文件记录 */
export function deleteDocument(id: number): Promise<void> {
    return axios.delete(`/api/documents/${id}`, { headers: authHeader() }).then(() => { })
}
