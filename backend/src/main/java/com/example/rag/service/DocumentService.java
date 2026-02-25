package com.example.rag.service;

import com.example.rag.config.UserContext;
import com.example.rag.entity.DocumentFile;
import com.example.rag.repository.DocumentFileRepository;
import dev.langchain4j.data.document.Document;
import dev.langchain4j.data.document.DocumentSplitter;
import dev.langchain4j.data.document.Metadata;
import dev.langchain4j.data.document.splitter.DocumentSplitters;
import dev.langchain4j.data.embedding.Embedding;
import dev.langchain4j.data.segment.TextSegment;
import dev.langchain4j.model.embedding.EmbeddingModel;
import dev.langchain4j.store.embedding.EmbeddingStore;
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
import java.util.List;

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
}
