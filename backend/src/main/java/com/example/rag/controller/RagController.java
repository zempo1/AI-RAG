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

    /**
     * 获取当前用户的所有历史上传文件（不含 content，避免响应过大）
     */
    @GetMapping("/documents")
    public ResponseEntity<?> listDocuments() {
        try {
            return ResponseEntity.ok(documentService.listDocuments());
        } catch (Exception e) {
            return ResponseEntity.status(500).body("Error: " + e.getMessage());
        }
    }

    /**
     * 激活历史文件：重新将其内容写入向量 store，使 RAG 检索生效
     */
    @PostMapping("/documents/{id}/activate")
    public ResponseEntity<?> activateDocument(@PathVariable Long id) {
        try {
            documentService.activateDocument(id);
            return ResponseEntity.ok(Map.of("message", "Document activated successfully."));
        } catch (Exception e) {
            return ResponseEntity.status(500).body(Map.of("error", e.getMessage()));
        }
    }

    /**
     * 删除历史文件记录（仅删除 DB 记录，不影响向量 store）
     */
    @DeleteMapping("/documents/{id}")
    public ResponseEntity<?> deleteDocument(@PathVariable Long id) {
        try {
            documentService.deleteDocument(id);
            return ResponseEntity.ok().build();
        } catch (Exception e) {
            return ResponseEntity.status(500).body(Map.of("error", e.getMessage()));
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

        // Handle Chat Creation / Retrieval — must be done in main thread while UserContext is valid
        final Chat finalChat;
        if (chatId == null) {
            String title = question.length() > 30 ? question.substring(0, 30) + "..." : question;
            finalChat = historyService.createChat(title);
            try {
                emitter.send(SseEmitter.event().name("chatId").data(finalChat.getId()));
            } catch (IOException e) {
                // ignore
            }
        } else {
            finalChat = historyService.getChat(chatId).orElse(null);
            if (finalChat == null) {
                try {
                    emitter.send(SseEmitter.event().data("\"[Chat not found]\""));
                    emitter.complete();
                } catch (IOException e) {
                    // ignore
                }
                return emitter;
            }
        }

        // Save User Message — still in main thread
        try {
            historyService.addMessageToChat(finalChat, "user", question);
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
                    try {
                        // Save Assistant Message — use Chat object directly, no UserContext needed
                        historyService.addMessageToChat(finalChat, "assistant", fullResponse.toString());
                    } catch (Exception e) {
                        System.err.println("Failed to save assistant message: " + e.getMessage());
                    } finally {
                        emitter.complete();
                    }
                }

                @Override
                public void onError(Throwable error) {
                    System.err.println("Streaming error: " + error.getMessage());
                    error.printStackTrace();
                    try {
                        // Save whatever was accumulated before the error
                        String savedContent = fullResponse.length() > 0
                            ? fullResponse.toString() + "\n[生成中断]"
                            : "[生成失败: " + error.getMessage() + "]";
                        historyService.addMessageToChat(finalChat, "assistant", savedContent);
                    } catch (Exception e) {
                        System.err.println("Failed to save error message: " + e.getMessage());
                    }
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
            } catch (IOException ex) {
                // ignore
            }
            emitter.completeWithError(e);
        }

        return emitter;
    }
}
