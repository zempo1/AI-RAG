import request from '../utils/request'

export interface MindMap {
  id: number
  title: string
  data: string // JSON string
  createdAt: string
}

export const generateMindMap = () => {
  return request.post<any, MindMap>('/api/mindmaps/generate', null, { timeout: 120000 })
}

export const getMindMaps = () => {
  return request.get<any, MindMap[]>('/api/mindmaps')
}

export const getMindMap = (id: number) => {
  return request.get<any, MindMap>(`/api/mindmaps/${id}`)
}

export const updateMindMap = (id: number, data: string) => {
  return request.put<any, MindMap>(`/api/mindmaps/${id}`, { data })
}

export const deleteMindMap = (id: number) => {
  return request.delete(`/api/mindmaps/${id}`)
}
