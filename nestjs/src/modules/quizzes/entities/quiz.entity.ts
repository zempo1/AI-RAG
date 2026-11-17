import { Entity, Column, PrimaryGeneratedColumn, Index } from "typeorm";
import type { QuizQuestion, Answers } from "../quiz-data";
@Entity("quizzes")
@Index(["userId", "knowledgeBaseId"])
export class Quiz {
  @PrimaryGeneratedColumn({ type: "bigint" }) id: number;
  @Column({ type: "bigint", name: "user_id" }) userId: number;
  @Column({ type: "bigint", name: "knowledge_base_id" }) knowledgeBaseId: number;
  @Column({ type: "bigint", name: "document_id" }) documentId: number;
  @Column({ type: "bigint", name: "version_id" }) versionId: number;
  @Column({ type: "bigint", name: "index_revision_id" }) indexRevisionId: number;
  @Column({ type: "varchar", length: 255 }) title: string;
  @Column({ type: "varchar", length: 255 }) filename: string;
  @Column({ type: "int", name: "single_count" }) singleCount: number;
  @Column({ type: "int", name: "multiple_count" }) multipleCount: number;
  @Column({ type: "json" }) questions: QuizQuestion[];
  @Column({ type: "datetime", precision: 6, name: "created_at" }) createdAt: string;
}
@Entity("quiz_attempts")
@Index(["userId", "requestId"], { unique: true })
@Index(["quizId"])
export class QuizAttempt {
  @PrimaryGeneratedColumn({ type: "bigint" }) id: number;
  @Column({ type: "bigint", name: "user_id" }) userId: number;
  @Column({ type: "bigint", name: "quiz_id" }) quizId: number;
  @Column({ type: "varchar", length: 100, name: "request_id" }) requestId: string;
  @Column({ type: "int", name: "current_index" }) currentIndex: number;
  @Column({ type: "varchar", length: 20 }) status: string;
  @Column({ type: "json" }) answers: Answers;
  @Column({ type: "double" }) score: number;
  @Column({ type: "int", name: "correct_count" }) correctCount: number;
  @Column({ type: "int", name: "answered_count" }) answeredCount: number;
  @Column({ type: "int", name: "total_count" }) totalCount: number;
  @Column({ type: "datetime", precision: 6, name: "created_at" }) createdAt: string;
  @Column({ type: "datetime", precision: 6, name: "completed_at", nullable: true }) completedAt:
    string | null;
}
