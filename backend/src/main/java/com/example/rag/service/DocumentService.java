package com.example.rag.service;

import com.example.rag.config.UserContext;
import com.example.rag.entity.DocumentFile;
import com.example.rag.entity.User;
import com.example.rag.repository.DocumentFileRepository;
import dev.langchain4j.data.document.Document;
import dev.langchain4j.data.document.DocumentSplitter;
import dev.langchain4j.data.document.Metadata;
import dev.langchain4j.data.document.splitter.DocumentSplitters;
import dev.langchain4j.data.embedding.Embedding;
import dev.langchain4j.data.segment.TextSegment;
import dev.langchain4j.model.embedding.EmbeddingModel;
import dev.langchain4j.store.embedding.EmbeddingStore;
import lombok.Data;
import lombok.RequiredArgsConstructor;
import org.apache.pdfbox.Loader;
import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.text.PDFTextStripper;
import org.springframework.stereotype.Service;
import org.springframework.web.multipart.MultipartFile;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.LocalDateTime;
import java.util.List;
import java.util.stream.Collectors;

/** 文件历史摘要 DTO（不含大字段 content） */
@Data
class DocumentSummary {
    private Long id;
    private String filename;
    private LocalDateTime uploadTime;
    public DocumentSummary(DocumentFile f) {
        this.id = f.getId();
        this.filename = f.getFilename();
        this.uploadTime = f.getUploadTime();
    }
}

@Service
@RequiredArgsConstructor
public class DocumentService {

    private final EmbeddingModel embeddingModel;
    private final EmbeddingStore<TextSegment> embeddingStore;
    private final DocumentFileRepository documentFileRepository;

    public void ingest(MultipartFile file) throws IOException {
        String content = parseFile(file);
        ingestContent(content, file.getOriginalFilename());
    }

    /** 从磁盘路径读取合并后的分片文件进行 ingest（供 ChunkUploadController 调用） */
    public void ingestFromPath(Path filePath, String filename) throws IOException {
        String content = parseFilePath(filePath, filename);
        ingestContent(content, filename);
    }

    private void ingestContent(String content, String filename) {
        // Save raw content for Mind Map generation
        DocumentFile docFile = new DocumentFile(filename, content);
        docFile.setUser(UserContext.getCurrentUser());
        documentFileRepository.save(docFile);

        Document document = Document.from(content, Metadata.from("userId", UserContext.getCurrentUser().getId()));

        // Split document into segments (500 chars, 50 overlap)
        DocumentSplitter splitter = DocumentSplitters.recursive(500, 50);
        List<TextSegment> segments = splitter.split(document);

        // Embed segments and store them
        List<Embedding> embeddings = embeddingModel.embedAll(segments).content();
        embeddingStore.addAll(embeddings, segments);
    }

    private String parseFile(MultipartFile file) throws IOException {
        String filename = file.getOriginalFilename();
        if (filename != null && filename.toLowerCase().endsWith(".pdf")) {
            return parsePdf(file.getBytes());
        }
        return new String(file.getBytes(), StandardCharsets.UTF_8);
    }

    private String parseFilePath(Path path, String filename) throws IOException {
        byte[] bytes = Files.readAllBytes(path);
        if (filename.toLowerCase().endsWith(".pdf")) {
            return parsePdf(bytes);
        }
        return new String(bytes, StandardCharsets.UTF_8);
    }

    private String parsePdf(byte[] bytes) throws IOException {
        try (PDDocument document = Loader.loadPDF(bytes)) {
            PDFTextStripper stripper = new PDFTextStripper();
            return stripper.getText(document);
        }
    }

    // ——— 文件历史 ———

    /** 返回当前用户所有历史文件（不含 content） */
    public List<DocumentSummary> listDocuments() {
        User user = UserContext.getCurrentUser();
        return documentFileRepository.findAllByUserOrderByUploadTimeDesc(user)
                .stream().map(DocumentSummary::new).collect(Collectors.toList());
    }

    /** 激活历史文件：重新 embed 到向量 store（不再写 DB 记录） */
    public void activateDocument(Long id) {
        DocumentFile docFile = documentFileRepository.findById(id)
                .orElseThrow(() -> new RuntimeException("Document not found: " + id));
        // 安全校验：只允许激活自己的文件
        User current = UserContext.getCurrentUser();
        if (!docFile.getUser().getId().equals(current.getId())) {
            throw new RuntimeException("Access denied");
        }
        String content = docFile.getContent();
        Document document = Document.from(content, Metadata.from("userId", current.getId()));
        DocumentSplitter splitter = DocumentSplitters.recursive(500, 50);
        List<TextSegment> segments = splitter.split(document);
        List<Embedding> embeddings = embeddingModel.embedAll(segments).content();
        embeddingStore.addAll(embeddings, segments);
    }

    /** 删除历史文件 DB 记录 */
    public void deleteDocument(Long id) {
        DocumentFile docFile = documentFileRepository.findById(id)
                .orElseThrow(() -> new RuntimeException("Document not found: " + id));
        User current = UserContext.getCurrentUser();
        if (!docFile.getUser().getId().equals(current.getId())) {
            throw new RuntimeException("Access denied");
        }
        documentFileRepository.deleteById(id);
    }
}
