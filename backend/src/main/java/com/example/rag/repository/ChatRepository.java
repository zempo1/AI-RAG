package com.example.rag.repository;

import com.example.rag.entity.Chat;
import com.example.rag.entity.User;
import org.springframework.data.jpa.repository.EntityGraph;
import org.springframework.data.jpa.repository.JpaRepository;
import java.util.List;

public interface ChatRepository extends JpaRepository<Chat, Long> {
    @EntityGraph(attributePaths = { "messages" })
    List<Chat> findByUserOrderByCreatedAtDesc(User user);
}
