import request from "../utils/request";
import type { ProcessingTask } from "./knowledge-bases";
export type QuizQuestionType = "SINGLE" | "MULTIPLE";
export interface QuizEvidence {
  chunkId: number;
  quote: string;
  location: Record<string, any> | null;
}
export interface QuizQuestion {
  id: string;
  type: QuizQuestionType;
  stem: string;
  options: { id: string; text: string }[];
  evidence: QuizEvidence[];
  correctOptionIds?: string[];
  explanation?: string;
  optionExplanations?: Record<string, string>;
}
export interface QuizAnswer {
  selectedOptionIds: string[];
  submitted: boolean;
  isCorrect?: boolean;
  submittedAt?: string;
}
export interface QuizAttemptSummary {
  id: number;
  status: "in_progress" | "completed";
  score: number;
  correctCount: number;
  answeredCount: number;
  totalCount: number;
  currentIndex: number;
  createdAt: string;
  completedAt: string | null;
}
export interface Quiz {
  attempts?: QuizAttemptSummary[];
  id: number;
  knowledgeBaseId: number;
  documentId: number;
  versionId: number;
  indexRevisionId: number;
  title: string;
  filename: string;
  singleCount: number;
  multipleCount: number;
  questionCount: number;
  createdAt: string;
  sourceOutdated: boolean;
  questions: QuizQuestion[];
  latestAttempt: QuizAttemptSummary | null;
}
export interface QuizAttempt extends QuizAttemptSummary {
  quizId: number;
  answers: Record<string, QuizAnswer>;
  quiz: Quiz;
  questions: QuizQuestion[];
}
export interface QuizTask extends ProcessingTask {
  quizResult?: { quizId: number };
  filename?: string;
}
export interface QuizProgress {
  currentIndex?: number;
  questionId?: string;
  selectedOptionIds?: string[];
  submit?: boolean;
}
export interface QuizExplainRequest {
  attemptId: number;
  questionId: string;
  documentId: number;
  knowledgeBaseId: number;
  question: string;
}
export const getQuizWorkspace = (knowledgeBaseId: number, signal?: AbortSignal) =>
  request.get<unknown, { items: Quiz[]; generationTasks: QuizTask[] }>("/api/quizzes/workspace", {
    params: { knowledgeBaseId },
    signal,
    silentError: true,
  });
export const generateQuiz = (data: {
  documentId: number;
  singleCount: number;
  multipleCount: number;
  requestId: string;
}) => request.post<unknown, { taskId: number; status: string }>("/api/quizzes/generate", data);
export const getQuiz = (id: number) => request.get<unknown, Quiz>(`/api/quizzes/${id}`);
export const deleteQuiz = (id: number) => request.delete(`/api/quizzes/${id}`);
export const createQuizAttempt = (id: number, requestId: string) =>
  request.post<unknown, QuizAttempt>(`/api/quizzes/${id}/attempts`, { requestId });
export const getQuizAttempt = (id: number) =>
  request.get<unknown, QuizAttempt>(`/api/quiz-attempts/${id}`);
export const saveQuizProgress = (id: number, progress: QuizProgress) =>
  request.patch<unknown, QuizAttempt>(`/api/quiz-attempts/${id}/progress`, progress, {
    silentError: true,
  });
