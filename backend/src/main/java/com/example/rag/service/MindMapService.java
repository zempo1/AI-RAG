package com.example.rag.service;

import com.example.rag.config.UserContext;
import com.example.rag.entity.DocumentFile;
import com.example.rag.entity.MindMap;
import com.example.rag.repository.DocumentFileRepository;
import com.example.rag.repository.MindMapRepository;
import dev.langchain4j.model.chat.ChatLanguageModel;
import dev.langchain4j.model.openai.OpenAiChatModel;
import dev.langchain4j.model.openai.OpenAiTokenizer;
import lombok.RequiredArgsConstructor;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.util.List;

@Service
@RequiredArgsConstructor
public class MindMapService {

    private final MindMapRepository mindMapRepository;
    private final DocumentFileRepository documentFileRepository;
    private final ChatLanguageModel defaultChatLanguageModel;

    @Value("${openai.base-url}")
    private String defaultBaseUrl;

    @Value("${openai.model-name}")
    private String defaultModelName;

    public MindMap generateMindMap(String apiKey, Long documentId) {
        DocumentFile latestFile;
        if (documentId != null) {
            latestFile = documentFileRepository.findById(documentId)
                    .filter(f -> f.getUser().getId().equals(UserContext.getCurrentUser().getId()))
                    .orElseThrow(() -> new RuntimeException("Document not found: " + documentId));
        } else {
            latestFile = documentFileRepository
                    .findTopByUserOrderByUploadTimeDesc(UserContext.getCurrentUser())
                    .orElseThrow(() -> new RuntimeException("No uploaded file found to generate mind map"));
        }

        String content = latestFile.getContent();
        // Truncate if too long (simple protection, though better to use LLM context
        // window mgmt)
        if (content.length() > 20000) {
            content = content.substring(0, 20000);
        }

        String prompt = "Generate a mind map structure based on the following text. " +
                "The output must be a valid JSON object strictly following this format: " +
                "{ \"root\": { \"data\": { \"text\": \"Main Topic\" }, \"children\": [ { \"data\": { \"text\": \"Subtopic\" }, \"children\": [] } ] } }. "
                +
                "Do not include any markdown formatting (like ```json). Just the raw JSON string. " +
                "Text content: \n\n" + content;

        ChatLanguageModel model = defaultChatLanguageModel;
        if (apiKey != null && !apiKey.trim().isEmpty()) {
            model = OpenAiChatModel.builder()
                    .apiKey(apiKey)
                    .baseUrl(defaultBaseUrl)
                    .modelName(defaultModelName)
                    .tokenizer(new OpenAiTokenizer("gpt-3.5-turbo"))
                    .build();
        }

        String jsonResponse = model.generate(prompt);

        // Clean up markdown code blocks if present (Robust Regex)
        java.util.regex.Pattern pattern = java.util.regex.Pattern.compile("(\\{.*\\})", java.util.regex.Pattern.DOTALL);
        java.util.regex.Matcher matcher = pattern.matcher(jsonResponse);
        if (matcher.find()) {
            jsonResponse = matcher.group(1);
        } else {
            // Fallback cleanup
            if (jsonResponse.startsWith("```json")) {
                jsonResponse = jsonResponse.substring(7);
            }
            if (jsonResponse.startsWith("```")) {
                jsonResponse = jsonResponse.substring(3);
            }
            if (jsonResponse.endsWith("```")) {
                jsonResponse = jsonResponse.substring(0, jsonResponse.length() - 3);
            }
        }
        jsonResponse = jsonResponse.trim();

        // Ensure it's not empty or invalid
        if (jsonResponse.isEmpty() || !jsonResponse.startsWith("{")) {
            // Fallback minimal JSON
            jsonResponse = "{ \"root\": { \"data\": { \"text\": \"Error Generating Map\" }, \"children\": [] } }";
        }

        MindMap mindMap = new MindMap(latestFile.getFilename() + " - Mind Map", jsonResponse);
        mindMap.setUser(UserContext.getCurrentUser());
        return mindMapRepository.save(mindMap);
    }

    public List<MindMap> getAllMindMaps() {
        return mindMapRepository.findByUserOrderByCreatedAtDesc(UserContext.getCurrentUser());
    }

    public MindMap getMindMap(Long id) {
        return mindMapRepository.findById(id)
                .filter(map -> map.getUser().getId().equals(UserContext.getCurrentUser().getId()))
                .orElseThrow(() -> new RuntimeException("Mind Map not found"));
    }

    public MindMap updateMindMap(Long id, String data) {
        MindMap mindMap = getMindMap(id);
        mindMap.setData(data);
        return mindMapRepository.save(mindMap);
    }

    public void deleteMindMap(Long id) {
        MindMap mindMap = getMindMap(id);
        mindMapRepository.delete(mindMap);
    }
}
