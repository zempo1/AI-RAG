import axios from "axios";
import { toast } from "../composables/useToast";
declare module "axios" {
  interface AxiosRequestConfig { silentError?: boolean }
}

let authExpiredNotified = false;

export function getAuthHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  const token = localStorage.getItem('token');
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

/** Axios 与 PDF.js 的流式/Range 请求共享一次登录失效处理。 */
export function handleUnauthorized() {
  localStorage.removeItem('token');
  localStorage.removeItem('username');
  if (authExpiredNotified) return;
  authExpiredNotified = true;
  toast.error('登录已过期，请重新登录');
  window.dispatchEvent(new Event('auth-expired'));
  setTimeout(() => { authExpiredNotified = false; }, 3000);
}

const service = axios.create({
  baseURL: "",
  timeout: 30000,
  headers: {
    "Content-Type": "application/json",
  },
});

service.interceptors.request.use(
  (config) => {
    Object.assign(config.headers, getAuthHeaders());
    return config;
  },
  (error) => {
    if (axios.isCancel(error)) return Promise.reject(error);
    return Promise.reject(error);
  },
);

service.interceptors.response.use(
  (response) => {
    // 后端统一返回 {code, data, message}，此处解包出 data 供业务直接使用
    const body = response.data as { code?: number; data?: unknown };
    return (body?.data ?? response.data) as any;
  },
  (error) => {
    if (axios.isCancel(error)) return Promise.reject(error);
    if (error.response?.status === 401) {
      localStorage.removeItem("token");
      localStorage.removeItem("username");
      // 仅登录/注册失败（自身就是认证过程）不提示"已过期"，其余 401 一律视为登录过期
      const isAuthFlow =
        error.config?.url?.endsWith("/api/auth/login") ||
        error.config?.url?.endsWith("/api/auth/register");
      if (!isAuthFlow) {
        handleUnauthorized();
      }
    } else if (!error.config?.silentError) {
      const msg = error.response?.data?.message || error.message || "请求错误";
      toast.error(msg);
    }
    return Promise.reject(error);
  },
);

export default service;
