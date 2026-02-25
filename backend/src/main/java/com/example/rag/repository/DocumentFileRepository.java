package com.example.rag.repository;

import com.example.rag.entity.DocumentFile;
import com.example.rag.entity.User;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.util.Optional;

@Repository
public interface DocumentFileRepository extends JpaRepository<DocumentFile, Long> {
    // Get the latest uploaded file for a specific user
    Optional<DocumentFile> findTopByUserOrderByUploadTimeDesc(User user);
    // Get all files for a user, newest first
    java.util.List<DocumentFile> findAllByUserOrderByUploadTimeDesc(User user);
}
