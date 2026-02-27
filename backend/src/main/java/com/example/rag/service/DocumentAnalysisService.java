package com.example.rag.service;

import com.example.rag.config.UserContext;
import com.example.rag.entity.DocumentAnalysis;
import com.example.rag.entity.DocumentFile;
import com.example.rag.repository.DocumentAnalysisRepository;
import com.example.rag.repository.DocumentFileRepository;
import dev.langchain4j.model.chat.ChatLanguageModel;
import dev.langchain4j.model.openai.OpenAiChatModel;
import dev.langchain4j.model.openai.OpenAiTokenizer;
import lombok.RequiredArgsConstructor;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.util.List;

@Service
@RequiredArgsConstructor
public class DocumentAnalysisService {

    private final DocumentAnalysisRepository analysisRepository;
    private final DocumentFileRepository documentFileRepository;
    private final ChatLanguageModel defaultChatLanguageModel;

    @Value("${openai.base-url}")
    private String defaultBaseUrl;

    @Value("${openai.model-name}")
    private String defaultModelName;

    public DocumentAnalysis generate(String apiKey, Long documentId, String type) {
        // 查找文档
        DocumentFile docFile = documentFileRepository.findById(documentId)
                .filter(f -> f.getUser().getId().equals(UserContext.getCurrentUser().getId()))
                .orElseThrow(() -> new RuntimeException("Document not found: " + documentId));

        String content = docFile.getContent();
        if (content == null || content.isEmpty()) {
            throw new RuntimeException("Document content is empty");
        }
        // 截断保护
        if (content.length() > 20000) {
            content = content.substring(0, 20000);
        }

        String prompt = buildPrompt(type, content);

        ChatLanguageModel model = defaultChatLanguageModel;
        if (apiKey != null && !apiKey.trim().isEmpty()) {
            model = OpenAiChatModel.builder()
                    .apiKey(apiKey)
                    .baseUrl(defaultBaseUrl)
                    .modelName(defaultModelName)
                    .tokenizer(new OpenAiTokenizer("gpt-3.5-turbo"))
                    .build();
        }

        String result = model.generate(prompt).trim();

        DocumentAnalysis analysis = new DocumentAnalysis(
                docFile.getId(),
                docFile.getFilename(),
                type,
                result
        );
        analysis.setUser(UserContext.getCurrentUser());
        return analysisRepository.save(analysis);
    }

    private String buildPrompt(String type, String content) {
        if ("SUMMARY".equals(type)) {
            return "请对以下文档进行结构化摘要，使用 Markdown 格式输出。" +
                    "要求：\n" +
                    "1. 首先用一句话概括文档主题\n" +
                    "2. 然后分 3-5 个核心要点（加粗标题 + 简洁说明）\n" +
                    "3. 最后给出一句总结\n" +
                    "只输出 Markdown 正文，不要额外解释。\n\n" +
                    "文档内容：\n\n" + content;
        } else if ("OUTLINE".equals(type)) {
            return "请根据以下文档内容生成层级大纲，使用 Markdown ATX 标题格式（# ## ###）。" +
                    "要求：\n" +
                    "1. 提取文档的主要章节和子章节\n" +
                    "2. 每个标题下可用简短一行描述该章节主要内容\n" +
                    "3. 层级不超过 3 级\n" +
                    "只输出 Markdown 大纲，不要额外解释。\n\n" +
                    "文档内容：\n\n" + content;
        }
        throw new RuntimeException("Unknown analysis type: " + type);
    }

    public List<DocumentAnalysis> getList(String type) {
        return analysisRepository.findByUserAndTypeOrderByCreatedAtDesc(
                UserContext.getCurrentUser(), type);
    }

    public void delete(Long id) {
        DocumentAnalysis analysis = analysisRepository.findById(id)
                .orElseThrow(() -> new RuntimeException("Analysis not found: " + id));
        if (!analysis.getUser().getId().equals(UserContext.getCurrentUser().getId())) {
            throw new RuntimeException("Access denied");
        }
        analysisRepository.deleteById(id);
    }
}
