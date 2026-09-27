package com.example.rag.controller;

import com.example.rag.common.ApiException;
import com.example.rag.config.UserContext;
import com.example.rag.entity.User;
import com.example.rag.service.AuthService;
import lombok.RequiredArgsConstructor;
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
    public Map<String, String> register(@RequestBody Map<String, String> payload) {
        try {
            String token = authService.register(payload.get("username"), payload.get("password"));
            Map<String, String> response = new HashMap<>();
            response.put("token", token);
            response.put("username", payload.get("username"));
            return response;
        } catch (Exception e) {
            e.printStackTrace();
            throw new ApiException(500, "Registration failed: " + e.getMessage());
        }
    }

    @PostMapping("/login")
    public Map<String, String> login(@RequestBody Map<String, String> payload) {
        try {
            String token = authService.login(payload.get("username"), payload.get("password"));
            Map<String, String> response = new HashMap<>();
            response.put("token", token);
            response.put("username", payload.get("username"));
            return response;
        } catch (Exception e) {
            throw new ApiException(401, e.getMessage());
        }
    }

    @PostMapping("/change-password")
    public Map<String, String> changePassword(@RequestBody Map<String, String> payload) {
        User user = UserContext.getCurrentUser();
        if (user == null) {
            throw new ApiException(401, "未登录");
        }

        String oldPassword = payload.get("oldPassword");
        String newPassword = payload.get("newPassword");

        try {
            authService.changePassword(user.getId(), oldPassword, newPassword);
        } catch (Exception e) {
            throw new ApiException(400, e.getMessage());
        }

        Map<String, String> response = new HashMap<>();
        response.put("message", "密码修改成功");
        return response;
    }

    @PostMapping("/change-username")
    public Map<String, String> changeUsername(@RequestBody Map<String, String> payload) {
        User user = UserContext.getCurrentUser();
        if (user == null) {
            throw new ApiException(401, "未登录");
        }

        String newUsername = payload.get("newUsername");

        try {
            authService.changeUsername(user.getId(), newUsername);
        } catch (Exception e) {
            throw new ApiException(400, e.getMessage());
        }

        Map<String, String> response = new HashMap<>();
        response.put("message", "用户名修改成功");
        response.put("username", newUsername);
        return response;
    }
}
