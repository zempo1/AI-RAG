import { createApp, h, ref } from 'vue'
import ConfirmDialog from '../components/ConfirmDialog/ConfirmDialog.vue'

export interface ConfirmOptions {
  title?: string
  message: string
  type?: 'warning' | 'danger' | 'success' | 'info'
  confirmText?: string
  cancelText?: string
}

let confirmInstance: ReturnType<typeof createApp> | null = null
let container: HTMLDivElement | null = null
let visible = ref(false)
let loading = ref(false)
let options = ref<ConfirmOptions>({
  message: '',
  type: 'warning'
})
let resolvePromise: ((value: boolean) => void) | null = null

const initConfirm = () => {
  if (container) return
  
  container = document.createElement('div')
  document.body.appendChild(container)
  
  const handleConfirm = () => {
    visible.value = false
    resolvePromise?.(true)
  }
  
  const handleCancel = () => {
    visible.value = false
    resolvePromise?.(false)
  }
  
  confirmInstance = createApp({
    setup() {
      return () => h(ConfirmDialog, {
        visible: visible.value,
        'onUpdate:visible': (val: boolean) => {
          visible.value = val
        },
        title: options.value.title,
        message: options.value.message,
        type: options.value.type,
        confirmText: options.value.confirmText,
        cancelText: options.value.cancelText,
        loading: loading.value,
        onConfirm: handleConfirm,
        onCancel: handleCancel
      })
    }
  })
  
  confirmInstance.mount(container)
}

export const useConfirm = () => {
  const show = async (opts: ConfirmOptions): Promise<boolean> => {
    initConfirm()
    
    return new Promise((resolve) => {
      options.value = { ...opts }
      resolvePromise = resolve
      visible.value = true
    })
  }
  
  const warning = (message: string, title?: string): Promise<boolean> => {
    return show({ message, title, type: 'warning' })
  }
  
  const danger = (message: string, title?: string): Promise<boolean> => {
    return show({ message, title, type: 'danger', confirmText: '删除' })
  }
  
  const success = (message: string, title?: string): Promise<boolean> => {
    return show({ message, title, type: 'success' })
  }
  
  const info = (message: string, title?: string): Promise<boolean> => {
    return show({ message, title, type: 'info' })
  }
  
  return {
    show,
    warning,
    danger,
    success,
    info
  }
}

export type UseConfirmReturn = ReturnType<typeof useConfirm>
