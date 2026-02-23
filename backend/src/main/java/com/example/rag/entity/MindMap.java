package com.example.rag.entity;

import jakarta.persistence.*;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.time.LocalDateTime;

@Entity
@Data
@NoArgsConstructor
@Table(name = "mind_maps")
public class MindMap {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @ManyToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "user_id", nullable = true)
    @com.fasterxml.jackson.annotation.JsonIgnore
    private User user;

    private String title;

    @Lob
    @Column(columnDefinition = "LONGTEXT")
    private String data; // JSON structure for the mind map

    private LocalDateTime createdAt;

    public MindMap(String title, String data) {
        this.title = title;
        this.data = data;
        this.createdAt = LocalDateTime.now();
    }
}
