import axios from 'axios'
import { toast } from '../composables/useToast'

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
    return response.data
  },
  (error) => {
    if (error.response?.status === 401) {
      localStorage.removeItem('token')
      localStorage.removeItem('username')
      if (!error.config.url.includes('/api/auth/')) {
        toast.error('登录已过期，请重新登录')
        window.dispatchEvent(new Event('auth-expired'))
      }
    } else {
      const msg = error.response?.data?.message || error.message || '请求错误'
      toast.error(msg)
    }
    return Promise.reject(error)
  }
)

export default service
