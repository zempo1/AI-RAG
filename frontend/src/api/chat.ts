import request from "../utils/request";
import { SseDecoder, type SseEvent } from "../utils/sse";
import { dispatchChatEvent, type StreamChatCallbacks } from "../utils/chat-stream";
import type { Citation } from "./knowledge-bases";

export const getChatHistory = (id: number) => request.get("/api/chats/" + id);
export type QaMode = "auto" | "general" | "search" | "overview" | "compare";
export interface RetrievalContext {
  documentIds?: number[];
  mode?: QaMode;
}
export interface AcceptedAnswer {
  retrievalRunId?: number;
  taskId: number;
  chatId: number;
  requestId: string;
}
export const getRetrievalRun = (id: number) =>
  request.get<any, any>("/api/retrieval-runs/" + id);
export interface StreamChatParams {
  question: string;
  chatId: number | null;
  knowledgeBaseId: number;
  documentIds?: number[];
  mode?: QaMode;
  requestId?: string;
}
export interface FinalAnswer {
  answer: string;
  citations: Citation[];
  chatId: number;
  generationStatus: string;
  retrievalRunId?: number;
  diagnostics?: Record<string, unknown>;
}

export async function sendStreamChat(
  params: StreamChatParams,
  callbacks: StreamChatCallbacks,
  signal?: AbortSignal,
) {
  let completed = false;
  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    const token = localStorage.getItem("token");
    if (token) headers.Authorization = "Bearer " + token;
    const response = await fetch("/api/stream-chat", {
      method: "POST",
      headers,
      body: JSON.stringify(params),
      signal,
    });
    if (!response.ok) {
      if (response.status === 401)
        window.dispatchEvent(new Event("auth-expired"));
      const error = await response.json().catch(() => null);
      throw new Error(error?.message || "问答请求失败");
    }
    if (!response.body) throw new Error("响应内容为空");
    const reader = response.body.getReader(),
      decoder = new SseDecoder();
    const handle = (frame: SseEvent) => {
      if (dispatchChatEvent(frame, callbacks)) completed = true;
    };
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const frame of decoder.feed(value)) handle(frame);
      }
      for (const frame of decoder.finish()) handle(frame);
      if (!completed && !signal?.aborted)
        throw new Error("连接已中断，可重新打开会话查看已保存内容");
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  } catch (error) {
    if (!signal?.aborted) callbacks.onError(error);
  } finally {
    callbacks.onFinish();
  }
}
