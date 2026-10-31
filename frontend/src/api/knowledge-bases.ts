import request from "../utils/request";

export interface KnowledgeBase {
  id: number;
  name: string;
  description: string;
  rebuildTaskId: number | null;
}
export interface Category {
  id: number;
  name: string;
  knowledgeBaseId: number;
}
export interface ProcessingTask {
  canDismiss?: boolean;
  waitingUntil?: string | null;
  waitingReason?: string | null;
  id: number;
  kind: string;
  status: string;
  stage: string;
  completed: number;
  total: number | null;
  documentId: number | null;
  parentTaskId: number | null;
  retryable: number;
  error: string | null;
  children?: ProcessingTask[];
}
export interface ManagedDocument {
  id: number;
  filename: string;
  knowledgeBaseId: number;
  categoryId: number | null;
  status: string;
  activeIndexRevisionId: number | null;
  activeVersionId: number | null;
  latestTaskId: number | null;
  uploadTime: string;
  task?: ProcessingTask | null;
}
export interface AcceptedDocument {
  documentId: number;
  taskId: number;
  knowledgeBaseId: number;
  filename: string;
}
export interface Citation {
  number: number;
  documentId: number;
  knowledgeBaseId: number;
  versionId: number;
  indexRevisionId: number;
  chunkId: number;
  filename: string;
  text: string;
  score: number;
  sourceDeleted?: boolean;
  sourceOutdated?: boolean;
  location: {
    page: number | null;
    paragraph: number | null;
    heading: string | null;
    start: number;
    end: number;
  } | null;
}
export const listKnowledgeBases = () =>
  request.get<any, KnowledgeBase[]>("/api/knowledge-bases");
export const createKnowledgeBase = (name: string, description = "") =>
  request.post<any, KnowledgeBase>("/api/knowledge-bases", {
    name,
    description,
  });
export const updateKnowledgeBase = (
  id: number,
  name: string,
  description = "",
) => request.put("/api/knowledge-bases/" + id, { name, description });
export const deleteKnowledgeBase = (id: number) =>
  request.delete<any, { taskId: number }>("/api/knowledge-bases/" + id);
export const listCategories = (id: number) =>
  request.get<any, Category[]>("/api/knowledge-bases/" + id + "/categories");
export const createCategory = (id: number, name: string) =>
  request.post("/api/knowledge-bases/" + id + "/categories", { name });
export const updateCategory = (kbId: number, id: number, name: string) =>
  request.put("/api/knowledge-bases/" + kbId + "/categories/" + id, { name });
export const deleteCategory = (kbId: number, id: number) =>
  request.delete("/api/knowledge-bases/" + kbId + "/categories/" + id);
export const listLibraryDocuments = (
  id: number,
  params: Record<string, unknown>,
) =>
  request.get<any, { items: ManagedDocument[]; total: number }>(
    "/api/knowledge-bases/" + id + "/documents",
    { params },
  );
export const updateDocument = (
  id: number,
  values: { filename?: string; categoryId?: number | null },
) => request.put("/api/documents/" + id, values);
export const getDocument = (id: number) =>
  request.get<any, ManagedDocument>("/api/documents/" + id);
export const removeDocument = (id: number) =>
  request.delete<any, { taskId: number }>("/api/documents/" + id);
export const reindexDocument = (id: number) =>
  request.post<any, AcceptedDocument>("/api/documents/" + id + "/reindex");
export const reindexKnowledgeBase = (id: number) =>
  request.post<any, { taskId: number }>(
    "/api/knowledge-bases/" + id + "/reindex",
  );
export const getTask = (id: number) =>
  request.get<any, ProcessingTask>("/api/tasks/" + id);
export const listTasks = (knowledgeBaseId: number) =>
  request.get<any, ProcessingTask[]>("/api/tasks", {
    params: { knowledgeBaseId },
  });
export const retryTask = (id: number) =>
  request.post("/api/tasks/" + id + "/retry");
export const dismissTask = (id: number) => request.delete("/api/tasks/" + id);
export const clearCompletedTasks = (knowledgeBaseId: number) =>
  request.delete("/api/tasks", { params: { knowledgeBaseId } });
