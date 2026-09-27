package com.example.rag.common;

import lombok.Getter;

/**
 * 业务异常，携带 HTTP 状态码信息。
 * 由 GlobalExceptionHandler 统一转换为 ApiResponse。
 */
@Getter
public class ApiException extends RuntimeException {

    private final int code;

    public ApiException(int code, String message) {
        super(message);
        this.code = code;
    }

    public ApiException(int code, String message, Throwable cause) {
        super(message, cause);
        this.code = code;
    }
}