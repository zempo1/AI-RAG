import { createApp, h, ref } from 'vue'
import Toast from '../components/Toast.vue'

export type ToastType = 'success' | 'error' | 'warning' | 'info'

interface ToastItem {
  id: number
  message: string
  type: ToastType
}

const toasts = ref<ToastItem[]>([])
let toastId = 0
let initialized = false

const initToast = () => {
  if (initialized) return
  
  const container = document.createElement('div')
  document.body.appendChild(container)
  
  const app = createApp({
    setup() {
      return () => h(Toast, { toasts: toasts.value })
    }
  })
  
  app.mount(container)
  initialized = true
}

const show = (message: string, type: ToastType = 'info', duration = 3000) => {
  initToast()
  
  const id = ++toastId
  toasts.value.push({ id, message, type })
  
  setTimeout(() => {
    const index = toasts.value.findIndex(t => t.id === id)
    if (index > -1) {
      toasts.value.splice(index, 1)
    }
  }, duration)
}

export const toast = {
  show,
  success: (message: string, duration = 3000) => show(message, 'success', duration),
  error: (message: string, duration = 3000) => show(message, 'error', duration),
  warning: (message: string, duration = 3000) => show(message, 'warning', duration),
  info: (message: string, duration = 3000) => show(message, 'info', duration)
}

export const useToast = () => toast

export type UseToastReturn = typeof toast
