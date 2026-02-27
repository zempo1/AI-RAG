import request from '../utils/request'

export interface DocumentAnalysis {
    id: number
    documentId: number
    documentName: string
    type: 'SUMMARY' | 'OUTLINE'
    content: string
    createdAt: string
}

export const generateAnalysis = (documentId: number, type: 'SUMMARY' | 'OUTLINE') => {
    return request.post<any, DocumentAnalysis>(
        '/api/analysis/generate',
        { documentId, type },
        { timeout: 120000 },
    )
}

export const getAnalyses = (type: 'SUMMARY' | 'OUTLINE') => {
    return request.get<any, DocumentAnalysis[]>('/api/analysis', { params: { type } })
}

export const deleteAnalysis = (id: number) => {
    return request.delete(`/api/analysis/${id}`)
}
