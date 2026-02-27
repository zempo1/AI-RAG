package com.example.rag.controller;

import com.example.rag.entity.DocumentAnalysis;
import com.example.rag.service.DocumentAnalysisService;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/api/analysis")
@CrossOrigin(origins = "*")
@RequiredArgsConstructor
public class DocumentAnalysisController {

    private final DocumentAnalysisService analysisService;

    @PostMapping("/generate")
    public ResponseEntity<?> generate(
            @RequestHeader(value = "X-Api-Key", required = false) String apiKey,
            @RequestBody Map<String, Object> body) {
        try {
            Long documentId = Long.valueOf(body.get("documentId").toString());
            String type = body.get("type").toString();
            return ResponseEntity.ok(analysisService.generate(apiKey, documentId, type));
        } catch (Exception e) {
            e.printStackTrace();
            return ResponseEntity.status(500).body(Map.of("error", e.getMessage()));
        }
    }

    @GetMapping
    public ResponseEntity<?> getList(@RequestParam String type) {
        try {
            return ResponseEntity.ok(analysisService.getList(type));
        } catch (Exception e) {
            return ResponseEntity.status(500).body(Map.of("error", e.getMessage()));
        }
    }

    @DeleteMapping("/{id}")
    public ResponseEntity<?> delete(@PathVariable Long id) {
        try {
            analysisService.delete(id);
            return ResponseEntity.ok().build();
        } catch (Exception e) {
            return ResponseEntity.status(500).body(Map.of("error", e.getMessage()));
        }
    }
}
