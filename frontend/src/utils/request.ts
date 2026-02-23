import axios from 'axios'
import { ElMessage } from 'element-plus'

const service = axios.create({
  baseURL: '', // Using relative path proxy
  timeout: 30000,
  headers: {
    'Content-Type': 'application/json'
  }
})

// Request interceptor
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

// Response interceptor
service.interceptors.response.use(
  (response) => {
    return response.data
  },
  (error) => {
    if (error.response?.status === 401) {
      // Clear token and redirect or show login
      localStorage.removeItem('token')
      localStorage.removeItem('username')
      // Only show message if it's not the auth endpoint itself failing
      if (!error.config.url.includes('/api/auth/')) {
        ElMessage.error('登录已过期，请重新登录')
        // We can emit a custom event or rely on App.vue watching the state
        window.dispatchEvent(new Event('auth-expired'))
      }
    } else {
      const msg = error.response?.data?.message || error.message || '请求错误'
      ElMessage.error(msg)
    }
    return Promise.reject(error)
  }
)

export default service
