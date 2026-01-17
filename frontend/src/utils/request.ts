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
    const msg = error.response?.data?.message || error.message || 'Request Error'
    ElMessage.error(msg)
    return Promise.reject(error)
  }
)

export default service
