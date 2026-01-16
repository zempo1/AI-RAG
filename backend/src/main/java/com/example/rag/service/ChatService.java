package com.example.rag.service;

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
            return "抱歉，我没有在上传的文档中找到相关内容。请确认文档已成功上传，或尝试换一种提问方式。";
        }
        return chatLanguageModel.generate(prompt);
    }

    public void chatStream(String question, String apiKey, StreamingResponseHandler<AiMessage> handler) {
        String prompt = createPrompt(question);
        if (prompt == null) {
            handler.onError(new RuntimeException("No context found"));
            return;
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
        int maxResults = 5;
        double minScore = 0.5;
        List<EmbeddingMatch<TextSegment>> relevant = embeddingStore.findRelevant(questionEmbedding, maxResults,
                minScore);

        if (relevant.isEmpty()) {
            return null;
        }

        // 3. Create a prompt with context
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
