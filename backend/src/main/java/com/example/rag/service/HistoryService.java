package com.example.rag.service;

import com.example.rag.entity.Chat;
import com.example.rag.entity.Message;
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
        return chatRepository.findAllByOrderByCreatedAtDesc();
    }

    public Optional<Chat> getChat(Long id) {
        return chatRepository.findById(id);
    }

    @Transactional
    public Chat createChat(String title) {
        Chat chat = new Chat();
        chat.setTitle(title);
        return chatRepository.save(chat);
    }

    @Transactional
    public Message addMessage(Long chatId, String role, String content) {
        Chat chat = chatRepository.findById(chatId)
                .orElseThrow(() -> new RuntimeException("Chat not found"));
        
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
