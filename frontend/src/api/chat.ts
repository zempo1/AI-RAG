import request from "../utils/request";
import { SseDecoder, type SseEvent } from "../utils/sse";
import type { Citation } from "./knowledge-bases";

export const getChatHistory = (id: number) => request.get("/api/chats/" + id);
export type QaMode = "auto" | "general" | "search" | "overview" | "compare";
export interface RetrievalContext {
  documentIds?: number[];
  mode?: QaMode;
}
export interface AcceptedAnswer {
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
  callbacks: {
    onMessage: (text: string) => void;
    onChatId: (id: number) => void;
    onSources?: (sources: Citation[]) => void;
    onStatus?: (stage: string) => void;
    onAccepted?: (accepted: AcceptedAnswer) => void;
    onCitations?: (citations: Citation[]) => void;
    onDone: (answer: FinalAnswer) => void;
    onError: (error: unknown) => void;
    onFinish: () => void;
  },
  signal?: AbortSignal,
) {
  let completed = false;
  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    const token = localStorage.getItem("token"),
      apiKey = localStorage.getItem("user_api_key");
    if (token) headers.Authorization = "Bearer " + token;
    if (apiKey) headers["X-Api-Key"] = apiKey;
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
      const value = JSON.parse(frame.data);
      if (frame.event === "status") callbacks.onStatus?.(String(value.stage));
      else if (frame.event === "chatId") callbacks.onChatId(Number(value));
      else if (frame.event === "accepted") {
        completed = true;
        callbacks.onAccepted?.(value);
      } else if (frame.event === "sources") callbacks.onSources?.(value);
      else if (frame.event === "citations") callbacks.onCitations?.(value);
      else if (frame.event === "done") {
        completed = true;
        callbacks.onDone(value);
      } else if (frame.event === "error") {
        if (typeof value.answer === "string") callbacks.onDone(value);
        throw new Error(value.message || "生成失败");
      } else if (frame.event === "message") callbacks.onMessage(String(value));
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
