package com.example.rag.controller;

import com.example.rag.common.ApiException;
import com.example.rag.entity.DocumentAnalysis;
import com.example.rag.service.DocumentAnalysisService;
import lombok.RequiredArgsConstructor;
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
    public DocumentAnalysis generate(
            @RequestHeader(value = "X-Api-Key", required = false) String apiKey,
            @RequestBody Map<String, Object> body) {
        try {
            Long documentId = Long.valueOf(body.get("documentId").toString());
            String type = body.get("type").toString();
            return analysisService.generate(apiKey, documentId, type);
        } catch (Exception e) {
            e.printStackTrace();
            throw new ApiException(500, e.getMessage());
        }
    }

    @GetMapping
    public List<?> getList(@RequestParam String type) {
        try {
            return analysisService.getList(type);
        } catch (Exception e) {
            throw new ApiException(500, e.getMessage());
        }
    }

    @DeleteMapping("/{id}")
    public void delete(@PathVariable Long id) {
        try {
            analysisService.delete(id);
        } catch (Exception e) {
            throw new ApiException(500, e.getMessage());
        }
    }
}
