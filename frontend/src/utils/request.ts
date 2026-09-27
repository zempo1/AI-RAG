import axios from 'axios'
import { toast } from '../composables/useToast'

let authExpiredNotified = false

const service = axios.create({
  baseURL: '',
  timeout: 30000,
  headers: {
    'Content-Type': 'application/json'
  }
})

service.interceptors.request.use(
  (config) => {
    const apiKey = localStorage.getItem('user_api_key')
    if (apiKey) {
      config.headers['X-Api-Key'] = apiKey
    }

    const token = localStorage.getItem('token')
    if (token) {
      config.headers['Authorization'] = `Bearer ${token}`
    }
    return config
  },
  (error) => {
    return Promise.reject(error)
  }
)

service.interceptors.response.use(
  (response) => {
    // 后端统一返回 {code, data, message}，此处解包出 data 供业务直接使用
    const body = response.data as { code?: number; data?: unknown }
    return (body?.data ?? response.data) as any
  },
  (error) => {
    if (error.response?.status === 401) {
      localStorage.removeItem('token')
      localStorage.removeItem('username')
      // 仅登录/注册失败（自身就是认证过程）不提示"已过期"，其余 401 一律视为登录过期
      const isAuthFlow =
        error.config.url.endsWith('/api/auth/login') ||
        error.config.url.endsWith('/api/auth/register')
      if (!isAuthFlow) {
        // 同一轮并发请求导致的多个 401 只提示一次
        if (!authExpiredNotified) {
          authExpiredNotified = true
          toast.error('登录已过期，请重新登录')
          window.dispatchEvent(new Event('auth-expired'))
          // 窗口期过后重置，下次过期可再次提示
          setTimeout(() => {
            authExpiredNotified = false
          }, 3000)
        }
      }
    } else {
      const msg = error.response?.data?.message || error.message || '请求错误'
      toast.error(msg)
    }
    return Promise.reject(error)
  }
)

export default service
