package com.example.rag.repository;

import com.example.rag.entity.DocumentFile;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.util.Optional;

@Repository
public interface DocumentFileRepository extends JpaRepository<DocumentFile, Long> {
    // Get the latest uploaded file
    Optional<DocumentFile> findTopByOrderByUploadTimeDesc();
}
