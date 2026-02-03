package com.example.rag.repository;

import com.example.rag.entity.MindMap;
import com.example.rag.entity.User;
import org.springframework.data.jpa.repository.EntityGraph;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.util.List;

@Repository
public interface MindMapRepository extends JpaRepository<MindMap, Long> {
    @EntityGraph(attributePaths = {"user"})
    List<MindMap> findByUserOrderByCreatedAtDesc(User user);
}
