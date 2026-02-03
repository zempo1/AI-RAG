package com.example.rag.controller;

import com.example.rag.entity.Chat;
import com.example.rag.service.ChatService;
import com.example.rag.service.DocumentService;
import com.example.rag.service.HistoryService;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;

import java.util.List;
import java.util.Map;

import dev.langchain4j.model.StreamingResponseHandler;
import dev.langchain4j.data.message.AiMessage;
import dev.langchain4j.model.output.Response;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;
import java.io.IOException;

@RestController
@RequestMapping("/api")
@CrossOrigin(origins = "*") // Allow all origins for simplicity
@RequiredArgsConstructor
public class RagController {

    private final DocumentService documentService;
    private final ChatService chatService;
    private final HistoryService historyService;

    @GetMapping("/chats")
    public ResponseEntity<?> getChats() {
        try {
            return ResponseEntity.ok(historyService.getAllChats());
        } catch (Exception e) {
            e.printStackTrace();
            return ResponseEntity.status(500).body("Error fetching chats: " + e.getMessage());
        }
    }

    @GetMapping("/chats/{id}")
    public ResponseEntity<Chat> getChat(@PathVariable Long id) {
        return historyService.getChat(id)
                .map(ResponseEntity::ok)
                .orElse(ResponseEntity.notFound().build());
    }

    @PostMapping("/chats")
    public ResponseEntity<Chat> createChat(@RequestBody Map<String, String> payload) {
        String title = payload.getOrDefault("title", "New Chat");
        return ResponseEntity.ok(historyService.createChat(title));
    }

    @DeleteMapping("/chats/{id}")
    public ResponseEntity<Void> deleteChat(@PathVariable Long id) {
        historyService.deleteChat(id);
        return ResponseEntity.ok().build();
    }

    @PostMapping("/upload")
    public ResponseEntity<String> upload(@RequestParam("file") MultipartFile file) {
        try {
            documentService.ingest(file);
            return ResponseEntity.ok("File uploaded and ingested successfully.");
        } catch (Exception e) {
            return ResponseEntity.status(500).body("Error processing file: " + e.getMessage());
        }
    }

    @PostMapping("/chat")
    public ResponseEntity<String> chat(@RequestBody Map<String, String> payload) {
        String question = payload.get("question");
        if (question == null || question.trim().isEmpty()) {
            return ResponseEntity.badRequest().body("Question is required.");
        }
        String answer = chatService.chat(question);
        return ResponseEntity.ok(answer);
    }

    @PostMapping("/stream-chat")
    public SseEmitter streamChat(@RequestBody Map<String, Object> payload, @RequestHeader(value = "X-Api-Key", required = false) String apiKey) {
        String question = (String) payload.get("question");
        Object chatIdObj = payload.get("chatId");
        Long chatId = chatIdObj != null ? Long.valueOf(chatIdObj.toString()) : null;

        // Timeout 3 mins
        SseEmitter emitter = new SseEmitter(180000L);

        if (question == null || question.trim().isEmpty()) {
            try {
                emitter.send(SseEmitter.event().data("Question is required."));
                emitter.complete();
            } catch (IOException e) {
                // ignore
            }
            return emitter;
        }

        // Handle Chat Creation / Retrieval
        final Long finalChatId;
        if (chatId == null) {
            String title = question.length() > 30 ? question.substring(0, 30) + "..." : question;
            Chat chat = historyService.createChat(title);
            finalChatId = chat.getId();
            try {
                // Send chat ID to client
                emitter.send(SseEmitter.event().name("chatId").data(finalChatId));
            } catch (IOException e) {
                // ignore
            }
        } else {
            finalChatId = chatId;
        }

        // Save User Message
        try {
            historyService.addMessage(finalChatId, "user", question);
        } catch (Exception e) {
            System.err.println("Failed to save user message: " + e.getMessage());
        }

        StringBuilder fullResponse = new StringBuilder();

        try {
            chatService.chatStream(question, apiKey, new StreamingResponseHandler<AiMessage>() {
                @Override
                public void onNext(String token) {
                    fullResponse.append(token);
                    try {
                        String jsonToken = "\"" + token.replace("\"", "\\\"").replace("\n", "\\n").replace("\r", "\\r") + "\"";
                        emitter.send(SseEmitter.event().data(jsonToken));
                    } catch (Exception e) {
                        emitter.completeWithError(e);
                    }
                }

                @Override
                public void onComplete(Response<AiMessage> response) {
                    // Save Assistant Message
                    historyService.addMessage(finalChatId, "assistant", fullResponse.toString());
                    emitter.complete();
                }

                @Override
                public void onError(Throwable error) {
                    System.err.println("Streaming error: " + error.getMessage());
                    error.printStackTrace();
                    try {
                        String errorJson = "\"" + "[Error: " + error.getMessage() + "]" + "\"";
                        emitter.send(SseEmitter.event().data(errorJson));
                    } catch (IOException e) {
                        // ignore
                    }
                    emitter.completeWithError(error);
                }
            });
        } catch (Exception e) {
            System.err.println("Immediate streaming error: " + e.getMessage());
            e.printStackTrace();
            try {
                String errorJson = "\"" + "[System Error: " + e.getMessage() + "]" + "\"";
                emitter.send(SseEmitter.event().data(errorJson));
                emitter.completeWithError(e);
            } catch (IOException ex) {
                // ignore
            }
        }

        return emitter;
    }
}
