package com.example.rag.entity;

import jakarta.persistence.*;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.time.LocalDateTime;

@Entity
@Data
@NoArgsConstructor
@Table(name = "document_analyses")
public class DocumentAnalysis {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @ManyToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "user_id", nullable = true)
    @com.fasterxml.jackson.annotation.JsonIgnore
    private User user;

    private Long documentId;

    private String documentName;

    /** SUMMARY 或 OUTLINE */
    private String type;

    @Lob
    @Column(columnDefinition = "LONGTEXT")
    private String content;

    private LocalDateTime createdAt;

    public DocumentAnalysis(Long documentId, String documentName, String type, String content) {
        this.documentId = documentId;
        this.documentName = documentName;
        this.type = type;
        this.content = content;
        this.createdAt = LocalDateTime.now();
    }
}
