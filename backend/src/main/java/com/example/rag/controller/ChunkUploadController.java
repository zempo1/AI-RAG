package com.example.rag.controller;

import com.example.rag.service.DocumentService;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;

import java.io.IOException;
import java.io.OutputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.StandardOpenOption;
import java.util.*;
import java.util.stream.Collectors;

@Slf4j
@RestController
@RequestMapping("/api/upload")
@CrossOrigin(origins = "*")
@RequiredArgsConstructor
public class ChunkUploadController {

    private final DocumentService documentService;

    /** 临时分片存储根目录，改为系统 temp 目录下 */
    private static final String TEMP_DIR = System.getProperty("java.io.tmpdir") + "/rag-chunks/";

    /**
     * 秒传检测 + 断点续传：查询已上传的分片索引列表
     *
     * GET /api/upload/check?md5=xxx&filename=xxx
     *
     * Response:
     *   { "uploaded": true }                      — 文件已完整上传过（秒传）
     *   { "uploaded": false, "uploadedChunks": [0,1,2] }  — 返回已上传分片
     */
    @GetMapping("/check")
    public ResponseEntity<Map<String, Object>> checkUpload(
            @RequestParam String md5,
            @RequestParam String filename) {

        Map<String, Object> result = new HashMap<>();

        // 检查是否已经完成合并（秒传）
        Path mergedFile = getMergedFilePath(md5, filename);
        if (Files.exists(mergedFile)) {
            result.put("uploaded", true);
            return ResponseEntity.ok(result);
        }

        // 返回已上传的分片列表
        Path chunkDir = getChunkDir(md5);
        List<Integer> uploadedChunks = new ArrayList<>();
        if (Files.exists(chunkDir)) {
            try {
                uploadedChunks = Files.list(chunkDir)
                        .filter(p -> p.getFileName().toString().startsWith("chunk_"))
                        .map(p -> {
                            try {
                                return Integer.parseInt(p.getFileName().toString().replace("chunk_", ""));
                            } catch (NumberFormatException e) {
                                return -1;
                            }
                        })
                        .filter(i -> i >= 0)
                        .sorted()
                        .collect(Collectors.toList());
            } catch (IOException e) {
                log.warn("Failed to list chunks for md5={}", md5, e);
            }
        }

        result.put("uploaded", false);
        result.put("uploadedChunks", uploadedChunks);
        return ResponseEntity.ok(result);
    }

    /**
     * 接收单个分片
     *
     * POST /api/upload/chunk
     *   file         — 分片二进制
     *   md5          — 整个文件的 MD5
     *   chunkIndex   — 当前分片序号（从 0 开始）
     *   totalChunks  — 总分片数
     *   filename     — 原始文件名
     */
    @PostMapping("/chunk")
    public ResponseEntity<Map<String, Object>> uploadChunk(
            @RequestParam("file") MultipartFile file,
            @RequestParam String md5,
            @RequestParam int chunkIndex,
            @RequestParam int totalChunks,
            @RequestParam String filename) {

        try {
            Path chunkDir = getChunkDir(md5);
            Files.createDirectories(chunkDir);

            Path chunkPath = chunkDir.resolve("chunk_" + chunkIndex);
            file.transferTo(chunkPath.toFile());

            log.info("Received chunk {}/{} for file={} md5={}", chunkIndex + 1, totalChunks, filename, md5);

            Map<String, Object> result = new HashMap<>();
            result.put("chunkIndex", chunkIndex);
            result.put("received", true);
            return ResponseEntity.ok(result);
        } catch (IOException e) {
            log.error("Failed to save chunk {} for md5={}", chunkIndex, md5, e);
            return ResponseEntity.status(500).body(Map.of("error", e.getMessage()));
        }
    }

    /**
     * 合并所有分片，完成后触发 RAG ingest
     *
     * POST /api/upload/merge
     *   { "md5": "xxx", "filename": "doc.pdf", "totalChunks": 10 }
     */
    @PostMapping("/merge")
    public ResponseEntity<Map<String, Object>> mergeChunks(@RequestBody Map<String, Object> payload) {
        String md5 = (String) payload.get("md5");
        String filename = (String) payload.get("filename");
        int totalChunks = Integer.parseInt(payload.get("totalChunks").toString());

        Path chunkDir = getChunkDir(md5);
        Path mergedFile = getMergedFilePath(md5, filename);

        // 校验所有分片是否存在
        for (int i = 0; i < totalChunks; i++) {
            Path chunkPath = chunkDir.resolve("chunk_" + i);
            if (!Files.exists(chunkPath)) {
                return ResponseEntity.status(400).body(
                        Map.of("error", "Missing chunk: " + i));
            }
        }

        // 合并
        try {
            Files.createDirectories(mergedFile.getParent());
            try (OutputStream out = Files.newOutputStream(mergedFile,
                    StandardOpenOption.CREATE, StandardOpenOption.TRUNCATE_EXISTING)) {
                for (int i = 0; i < totalChunks; i++) {
                    Path chunkPath = chunkDir.resolve("chunk_" + i);
                    Files.copy(chunkPath, out);
                }
            }
            log.info("Merged {} chunks into {}", totalChunks, mergedFile);
        } catch (IOException e) {
            log.error("Failed to merge chunks for md5={}", md5, e);
            return ResponseEntity.status(500).body(Map.of("error", "Merge failed: " + e.getMessage()));
        }

        // 触发 RAG ingest
        try {
            documentService.ingestFromPath(mergedFile, filename);
            log.info("Ingest completed for file={}", filename);
        } catch (Exception e) {
            log.error("Ingest failed for file={}", filename, e);
            // 清理合并文件，让用户可以重试
            try { Files.deleteIfExists(mergedFile); } catch (IOException ignored) {}
            return ResponseEntity.status(500).body(
                    Map.of("error", "Ingest failed: " + e.getMessage()));
        }

        // 清理临时分片（异步，不阻塞响应）
        cleanupChunks(chunkDir);

        return ResponseEntity.ok(Map.of("message", "File uploaded and ingested successfully.", "filename", filename));
    }

    // ——— 工具方法 ———

    private Path getChunkDir(String md5) {
        return Paths.get(TEMP_DIR, md5);
    }

    private Path getMergedFilePath(String md5, String filename) {
        return Paths.get(TEMP_DIR, "merged", md5 + "_" + filename);
    }

    private void cleanupChunks(Path chunkDir) {
        new Thread(() -> {
            try {
                if (Files.exists(chunkDir)) {
                    Files.walk(chunkDir)
                            .sorted(Comparator.reverseOrder())
                            .forEach(p -> {
                                try { Files.delete(p); } catch (IOException ignored) {}
                            });
                }
            } catch (IOException e) {
                log.warn("Failed to cleanup chunk dir: {}", chunkDir, e);
            }
        }, "chunk-cleanup").start();
    }
}
