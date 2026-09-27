package com.example.rag.config;

import com.example.rag.entity.User;
import com.example.rag.service.AuthService;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.jsonwebtoken.Claims;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Component;
import org.springframework.web.servlet.HandlerInterceptor;

@Component
@RequiredArgsConstructor
public class AuthInterceptor implements HandlerInterceptor {

    private final JwtUtils jwtUtils;
    private final AuthService authService;
    private final ObjectMapper objectMapper;

    @Override
    public boolean preHandle(HttpServletRequest request, HttpServletResponse response, Object handler) throws Exception {
        // Skip auth for login and register endpoints only
        String uri = request.getRequestURI();
        if (uri.equals("/api/auth/login") || uri.equals("/api/auth/register")) {
            return true;
        }

        // Skip OPTIONS
        if ("OPTIONS".equalsIgnoreCase(request.getMethod())) {
            return true;
        }

        String authHeader = request.getHeader("Authorization");
        if (authHeader == null || !authHeader.startsWith("Bearer ")) {
            writeUnauthorized(response);
            return false;
        }

        String token = authHeader.substring(7);
        try {
            Claims claims = jwtUtils.validateToken(token);
            Object userIdObj = claims.get("userId");
            if (userIdObj == null) {
                writeUnauthorized(response);
                return false;
            }
            Long userId = Long.valueOf(userIdObj.toString());
            User user = authService.findById(userId).orElse(null);
            if (user == null) {
                writeUnauthorized(response);
                return false;
            }
            UserContext.setCurrentUser(user);
            return true;
        } catch (Exception e) {
            writeUnauthorized(response);
            return false;
        }
    }

    /**
     * 输出统一格式的 401 错误响应：{code, message, data}
     */
    private void writeUnauthorized(HttpServletResponse response) throws Exception {
        response.setStatus(401);
        response.setContentType("application/json;charset=UTF-8");
        response.getWriter().write(objectMapper.writeValueAsString(
                new com.example.rag.common.ApiResponse<>(401, "未登录或登录已过期", null)));
    }

    @Override
    public void afterCompletion(HttpServletRequest request, HttpServletResponse response, Object handler, Exception ex) {
        UserContext.clear();
    }
}
