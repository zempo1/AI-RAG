import request from "../utils/request";
import type { AcceptedDocument } from "./knowledge-bases";

export interface UploadScope {
  knowledgeBaseId: number;
  uploadId: string;
  documentId?: number;
  categoryId?: number;
}
export interface CheckResult {
  uploaded: boolean;
  uploadedChunks?: number[];
  documentId?: number;
  taskId?: number;
}
export const checkUpload = (
  md5: string,
  filename: string,
  scope: UploadScope,
) =>
  request.get<any, CheckResult>("/api/upload/check", {
    params: { md5, filename, ...scope },
  });
export async function uploadChunk(
  chunk: Blob,
  md5: string,
  chunkIndex: number,
  totalChunks: number,
  filename: string,
  scope: UploadScope,
  signal?: AbortSignal,
) {
  const form = new FormData();
  form.append("file", chunk, "chunk_" + chunkIndex);
  for (const [key, value] of Object.entries({
    md5,
    chunkIndex,
    totalChunks,
    filename,
    ...scope,
  }))
    if (value != null) form.append(key, String(value));
  await request.post("/api/upload/chunk", form, {
    headers: { "Content-Type": "multipart/form-data" },
    signal,
  });
}
export const mergeChunks = (
  md5: string,
  filename: string,
  totalChunks: number,
  scope: UploadScope,
) =>
  request.post<any, AcceptedDocument>("/api/upload/merge", {
    md5,
    filename,
    totalChunks,
    ...scope,
  });
