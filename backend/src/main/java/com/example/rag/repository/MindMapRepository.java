package com.example.rag.repository;

import com.example.rag.entity.MindMap;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.util.List;

@Repository
public interface MindMapRepository extends JpaRepository<MindMap, Long> {
    List<MindMap> findAllByOrderByCreatedAtDesc();
}
