package com.example.rag.service;

import com.example.rag.config.UserContext;
import com.example.rag.entity.Chat;
import com.example.rag.entity.Message;
import com.example.rag.entity.User;
import com.example.rag.repository.ChatRepository;
import com.example.rag.repository.MessageRepository;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;
import java.util.Optional;

@Service
@RequiredArgsConstructor
public class HistoryService {

    private final ChatRepository chatRepository;
    private final MessageRepository messageRepository;

    public List<Chat> getAllChats() {
        return chatRepository.findByUserOrderByCreatedAtDesc(UserContext.getCurrentUser());
    }

    public Optional<Chat> getChat(Long id) {
        return chatRepository.findById(id)
                .filter(chat -> chat.getUser().getId().equals(UserContext.getCurrentUser().getId()));
    }

    @Transactional
    public Chat createChat(String title) {
        Chat chat = new Chat();
        chat.setTitle(title);
        chat.setUser(UserContext.getCurrentUser());
        return chatRepository.save(chat);
    }

    @Transactional
    public Message addMessage(Long chatId, String role, String content) {
        Chat chat = getChat(chatId)
                .orElseThrow(() -> new RuntimeException("Chat not found or unauthorized"));

        Message message = new Message();
        message.setChat(chat);
        message.setRole(role);
        message.setContent(content);

        return messageRepository.save(message);
    }

    @Transactional
    public void deleteChat(Long id) {
        chatRepository.deleteById(id);
    }
}
