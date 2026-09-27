package com.example.rag.controller;

import com.example.rag.common.ApiException;
import com.example.rag.entity.MindMap;
import com.example.rag.service.MindMapService;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/api/mindmaps")
@CrossOrigin(origins = "*")
@RequiredArgsConstructor
public class MindMapController {

    private final MindMapService mindMapService;

    @PostMapping("/generate")
    public MindMap generateMindMap(
            @RequestHeader(value = "X-Api-Key", required = false) String apiKey,
            @RequestBody(required = false) Map<String, Object> body) {
        try {
            Long documentId = body != null && body.get("documentId") != null
                    ? Long.valueOf(body.get("documentId").toString())
                    : null;
            return mindMapService.generateMindMap(apiKey, documentId);
        } catch (Exception e) {
            e.printStackTrace();
            String detail = e.getCause() != null ? e.getCause().getMessage() : e.getMessage();
            throw new ApiException(500, detail == null ? "生成失败" : detail);
        }
    }

    @GetMapping
    public List<MindMap> getAllMindMaps() {
        return mindMapService.getAllMindMaps();
    }

    @GetMapping("/{id}")
    public MindMap getMindMap(@PathVariable Long id) {
        return mindMapService.getMindMap(id);
    }

    @PutMapping("/{id}")
    public MindMap updateMindMap(@PathVariable Long id, @RequestBody Map<String, Object> payload) {
        Object dataObj = payload.get("data");
        String dataStr;
        if (dataObj instanceof String) {
            dataStr = (String) dataObj;
        } else {
            // 若非字符串格式，则要求前端发送字符串化的 JSON
            throw new ApiException(400, "data 字段必须是 JSON 字符串");
        }
        return mindMapService.updateMindMap(id, dataStr);
    }

    @DeleteMapping("/{id}")
    public void deleteMindMap(@PathVariable Long id) {
        mindMapService.deleteMindMap(id);
    }
}
