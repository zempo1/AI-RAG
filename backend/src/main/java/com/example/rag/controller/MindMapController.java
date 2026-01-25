package com.example.rag.controller;

import com.example.rag.entity.MindMap;
import com.example.rag.service.MindMapService;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
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
    public ResponseEntity<MindMap> generateMindMap(
            @RequestHeader(value = "X-Api-Key", required = false) String apiKey) {
        return ResponseEntity.ok(mindMapService.generateMindMap(apiKey));
    }

    @GetMapping
    public ResponseEntity<List<MindMap>> getAllMindMaps() {
        return ResponseEntity.ok(mindMapService.getAllMindMaps());
    }

    @GetMapping("/{id}")
    public ResponseEntity<MindMap> getMindMap(@PathVariable Long id) {
        return ResponseEntity.ok(mindMapService.getMindMap(id));
    }

    @PutMapping("/{id}")
    public ResponseEntity<MindMap> updateMindMap(@PathVariable Long id, @RequestBody Map<String, Object> payload) {
        String data = (String) payload.get("data"); // Expecting JSON string
        // Or if frontend sends object, we might need to serialize it back to string if
        // entity stores string
        // But here we assumed Entity stores JSON string directly.
        // If frontend sends actual JSON object, Spring converts it to Map/List.
        // Let's assume frontend sends the raw JSON string or object.
        // To be safe, let's accept object and convert to string.

        Object dataObj = payload.get("data");
        String dataStr;
        if (dataObj instanceof String) {
            dataStr = (String) dataObj;
        } else {
            // Simple fallback, though typically we want a proper serializer
            // For now, assume frontend sends stringified JSON or we rely on simple toString
            // (risky)
            // Better: payload.get("data") should be the JSON string.
            dataStr = String.valueOf(dataObj);
            // Actually, if it comes as a Map/List, toString won't produce valid JSON.
            // We should change signature to accept Object and use Jackson manually if
            // needed.
            // But let's assume frontend sends stringified JSON for now.
            if (!(dataObj instanceof String)) {
                // Return bad request or try to serialize
                // For simplicity in this iteration, let's rely on frontend sending string.
                return ResponseEntity.badRequest().build();
            }
        }

        return ResponseEntity.ok(mindMapService.updateMindMap(id, dataStr));
    }

    @DeleteMapping("/{id}")
    public ResponseEntity<Void> deleteMindMap(@PathVariable Long id) {
        mindMapService.deleteMindMap(id);
        return ResponseEntity.ok().build();
    }
}
