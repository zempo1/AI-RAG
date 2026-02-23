package com.example.rag.service;

import com.example.rag.config.UserContext;
import dev.langchain4j.data.embedding.Embedding;
import dev.langchain4j.data.segment.TextSegment;
import dev.langchain4j.model.StreamingResponseHandler;
import dev.langchain4j.data.message.AiMessage;
import dev.langchain4j.model.chat.ChatLanguageModel;
import dev.langchain4j.model.chat.StreamingChatLanguageModel;
import dev.langchain4j.model.embedding.EmbeddingModel;
import dev.langchain4j.store.embedding.EmbeddingMatch;
import dev.langchain4j.store.embedding.EmbeddingStore;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;

import java.util.List;
import java.util.stream.Collectors;

import dev.langchain4j.model.openai.OpenAiStreamingChatModel;
import dev.langchain4j.model.openai.OpenAiTokenizer;
import org.springframework.beans.factory.annotation.Value;

@Service
@RequiredArgsConstructor
public class ChatService {

    private final EmbeddingStore<TextSegment> embeddingStore;
    private final EmbeddingModel embeddingModel;
    private final ChatLanguageModel chatLanguageModel;
    private final StreamingChatLanguageModel defaultStreamingChatLanguageModel;

    @Value("${openai.base-url}")
    private String defaultBaseUrl;

    @Value("${openai.model-name}")
    private String defaultModelName;

    public String chat(String question) {
        String prompt = createPrompt(question);
        if (prompt == null) {
            prompt = question;
        }
        return chatLanguageModel.generate(prompt);
    }

    public void chatStream(String question, String apiKey, StreamingResponseHandler<AiMessage> handler) {
        String prompt = createPrompt(question);
        if (prompt == null) {
            prompt = question;
        }

        StreamingChatLanguageModel model = defaultStreamingChatLanguageModel;

        if (apiKey != null && !apiKey.trim().isEmpty()) {
            model = OpenAiStreamingChatModel.builder()
                    .apiKey(apiKey)
                    .baseUrl(defaultBaseUrl)
                    .modelName(defaultModelName)
                    .tokenizer(new OpenAiTokenizer("gpt-3.5-turbo"))
                    .build();
        }

        model.generate(prompt, handler);
    }

    // Expose this so controller can check if context exists before streaming
    public boolean hasContext(String question) {
        return createPrompt(question) != null;
    }

    private String createPrompt(String question) {
        // 1. Embed the question
        Embedding questionEmbedding = embeddingModel.embed(question).content();

        // 2. Find relevant segments
        int maxResults = 10; // Get more results to filter manually
        double minScore = 0.5;
        List<EmbeddingMatch<TextSegment>> matches = embeddingStore.findRelevant(questionEmbedding, maxResults,
                minScore);

        // 3. Filter by userId
        Long currentUserId = UserContext.getCurrentUser().getId();
        List<EmbeddingMatch<TextSegment>> relevant = matches.stream()
                .filter(match -> {
                    Object userId = match.embedded().metadata().get("userId");
                    return userId != null && userId.toString().equals(currentUserId.toString());
                })
                .limit(5)
                .collect(Collectors.toList());

        if (relevant.isEmpty()) {
            return null;
        }

        // 4. Create a prompt with context
        String context = relevant.stream()
                .map(match -> match.embedded().text())
                .collect(Collectors.joining("\n\n"));

        return "You are a helpful assistant. Answer the user's question based strictly on the context provided below.\n"
                +
                "If the answer is not in the context, say you don't know.\n\n" +
                "Context:\n" + context + "\n\n" +
                "Question: " + question;
    }
}
