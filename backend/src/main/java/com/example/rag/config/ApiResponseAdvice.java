package com.example.rag.config;

import com.example.rag.common.ApiResponse;
import org.springframework.core.MethodParameter;
import org.springframework.http.MediaType;
import org.springframework.http.converter.HttpMessageConverter;
import org.springframework.http.server.ServerHttpRequest;
import org.springframework.http.server.ServerHttpResponse;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.servlet.mvc.method.annotation.ResponseBodyAdvice;

/**
 * 全局响应包裹切面：将 controller 返回的裸数据统一包装为 ApiResponse{code,data,message}。
 * <p>
 * 规则：
 * <ul>
 * <li>已返回 ApiResponse 的（如异常处理器）不再二次包裹；</li>
 * <li>SSE（SseEmitter）等非 JSON 序列化返回类型自然不受此 advice 影响；</li>
 * <li>非 2xx 成功状态（如 404）保持原样，避免被误包成成功。</li>
 * </ul>
 */
@RestControllerAdvice
public class ApiResponseAdvice implements ResponseBodyAdvice<Object> {

    @Override
    public boolean supports(MethodParameter returnType, Class<? extends HttpMessageConverter<?>> converterType) {
        // 交给 beforeBodyWrite 统一判断
        return true;
    }

    @Override
    public Object beforeBodyWrite(Object body, MethodParameter returnType, MediaType selectedContentType,
                                  Class<? extends HttpMessageConverter<?>> selectedConverterType,
                                  ServerHttpRequest request, ServerHttpResponse response) {

        // 已包装的（异常处理器返回的 ApiResponse）直接透传，避免二次包裹
        if (body instanceof ApiResponse) {
            return body;
        }

        // 其余统一包裹为 {code,data,message}（剔除响应体为空的情况，补一个空响应）
        return body == null ? ApiResponse.success() : ApiResponse.success(body);
    }
}