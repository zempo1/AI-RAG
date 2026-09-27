package com.example.rag.config;

import com.example.rag.common.ApiException;
import com.example.rag.common.ApiResponse;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.MissingServletRequestParameterException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException;
import org.springframework.web.multipart.MaxUploadSizeExceededException;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.web.bind.MissingPathVariableException;

/**
 * 全局异常处理器：将各种异常统一转换为 ApiResponse 结构，
 * 并保持 HTTP 状态码语义（4xx 客户端错误 / 5xx 服务端错误）。
 */
@Slf4j
@RestControllerAdvice
public class GlobalExceptionHandler {

    /**
     * 业务异常（携带自定义 code 与 message）
     */
    @ExceptionHandler(ApiException.class)
    public ResponseEntity<ApiResponse<Void>> handleApiException(ApiException e) {
        return build(e.getCode(), e.getMessage());
    }

    /**
     * 请求体或参数缺失/类型不匹配 -> 400
     */
    @ExceptionHandler({
            MethodArgumentNotValidException.class,
            HttpMessageNotReadableException.class,
            MissingServletRequestParameterException.class,
            MissingPathVariableException.class,
            MethodArgumentTypeMismatchException.class
    })
    public ResponseEntity<ApiResponse<Void>> handleBadRequest(Exception e) {
        return build(HttpStatus.BAD_REQUEST.value(), "参数错误: " + e.getMessage());
    }

    /**
     * 文件上传超出大小限制 -> 413
     */
    @ExceptionHandler(MaxUploadSizeExceededException.class)
    public ResponseEntity<ApiResponse<Void>> handleMaxUpload(MaxUploadSizeExceededException e) {
        return build(HttpStatus.PAYLOAD_TOO_LARGE.value(), "文件过大");
    }

    /**
     * 兜底异常 -> 500
     */
    @ExceptionHandler(Exception.class)
    public ResponseEntity<ApiResponse<Void>> handleException(Exception e) {
        log.error("Unhandled exception", e);
        return build(HttpStatus.INTERNAL_SERVER_ERROR.value(), "服务器内部错误: " + e.getMessage());
    }

    private ResponseEntity<ApiResponse<Void>> build(int code, String message) {
        return ResponseEntity.status(code).body(ApiResponse.error(code, message));
    }
}