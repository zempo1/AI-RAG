import request from "../utils/request";
import type { ProcessingTask } from "./knowledge-bases";

export interface MindMap {
  versionId?: number | null;
  sourceOutdated?: boolean;
  documentId?: number | null;
  id: number;
  title: string;
  data: string; // JSON string
  createdAt: string;
}

export const generateMindMap = (documentId: number, requestId = crypto.randomUUID()) => {
  return request.post<any, { taskId: number; status: string }>("/api/mindmaps/generate", {
    documentId,
    requestId,
  });
};

export const getMindMapWorkspace = (knowledgeBaseId?: number | null) =>
  request.get<any, { items: MindMap[]; generationTasks: ProcessingTask[] }>(
    "/api/mindmaps/workspace",
    { params: knowledgeBaseId ? { knowledgeBaseId } : {} },
  );

export const getMindMaps = () => {
  return request.get<any, MindMap[]>("/api/mindmaps");
};

export const getMindMap = (id: number) => {
  return request.get<any, MindMap>(`/api/mindmaps/${id}`);
};

export const updateMindMap = (id: number, data: string) => {
  return request.put<any, MindMap>(`/api/mindmaps/${id}`, { data });
};

export const deleteMindMap = (id: number) => {
  return request.delete(`/api/mindmaps/${id}`);
};
