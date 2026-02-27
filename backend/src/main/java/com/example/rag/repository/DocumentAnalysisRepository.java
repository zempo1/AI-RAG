package com.example.rag.repository;

import com.example.rag.entity.DocumentAnalysis;
import com.example.rag.entity.User;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.util.List;

@Repository
public interface DocumentAnalysisRepository extends JpaRepository<DocumentAnalysis, Long> {
    List<DocumentAnalysis> findByUserAndTypeOrderByCreatedAtDesc(User user, String type);
}
