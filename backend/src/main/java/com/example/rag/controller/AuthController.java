package com.example.rag.controller;

import com.example.rag.config.UserContext;
import com.example.rag.entity.User;
import com.example.rag.service.AuthService;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.HashMap;
import java.util.Map;

@RestController
@RequestMapping("/api/auth")
@CrossOrigin(origins = "*")
@RequiredArgsConstructor
public class AuthController {

    private final AuthService authService;

    @PostMapping("/register")
    public ResponseEntity<?> register(@RequestBody Map<String, String> payload) {
        try {
            String token = authService.register(payload.get("username"), payload.get("password"));
            Map<String, String> response = new HashMap<>();
            response.put("token", token);
            response.put("username", payload.get("username"));
            return ResponseEntity.ok(response);
        } catch (Exception e) {
            e.printStackTrace();
            return ResponseEntity.status(500).body("Registration failed: " + e.getMessage());
        }
    }

    @PostMapping("/login")
    public ResponseEntity<?> login(@RequestBody Map<String, String> payload) {
        try {
            String token = authService.login(payload.get("username"), payload.get("password"));
            Map<String, String> response = new HashMap<>();
            response.put("token", token);
            response.put("username", payload.get("username"));
            return ResponseEntity.ok(response);
        } catch (Exception e) {
            return ResponseEntity.status(401).body(e.getMessage());
        }
    }

    @PostMapping("/change-password")
    public ResponseEntity<?> changePassword(@RequestBody Map<String, String> payload) {
        try {
            User user = UserContext.getCurrentUser();
            if (user == null) {
                return ResponseEntity.status(401).body("未登录");
            }
            
            String oldPassword = payload.get("oldPassword");
            String newPassword = payload.get("newPassword");
            
            authService.changePassword(user.getId(), oldPassword, newPassword);
            
            Map<String, String> response = new HashMap<>();
            response.put("message", "密码修改成功");
            return ResponseEntity.ok(response);
        } catch (Exception e) {
            return ResponseEntity.status(400).body(e.getMessage());
        }
    }

    @PostMapping("/change-username")
    public ResponseEntity<?> changeUsername(@RequestBody Map<String, String> payload) {
        try {
            User user = UserContext.getCurrentUser();
            if (user == null) {
                return ResponseEntity.status(401).body("未登录");
            }
            
            String newUsername = payload.get("newUsername");
            
            authService.changeUsername(user.getId(), newUsername);
            
            Map<String, String> response = new HashMap<>();
            response.put("message", "用户名修改成功");
            response.put("username", newUsername);
            return ResponseEntity.ok(response);
        } catch (Exception e) {
            return ResponseEntity.status(400).body(e.getMessage());
        }
    }
}
