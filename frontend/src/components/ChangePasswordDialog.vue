<template>
  <Teleport to="body">
    <Transition name="modal-fade">
      <div v-if="visible" class="modal-overlay" @click.self="handleClose">
        <Transition name="modal-scale">
          <div v-if="visible" class="modal-container">
            <div class="modal-header">
              <h3>修改密码</h3>
              <button class="close-btn" @click="handleClose">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M18 6L6 18M6 6l12 12" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
              </button>
            </div>
            
            <div class="modal-body">
              <div class="form-group">
                <label>原密码</label>
                <div class="input-wrapper">
                  <input
                    v-model="form.oldPassword"
                    :type="showOldPassword ? 'text' : 'password'"
                    placeholder="请输入原密码"
                  />
                  <button class="toggle-btn" @click="showOldPassword = !showOldPassword">
                    <svg v-if="showOldPassword" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                      <circle cx="12" cy="12" r="3"/>
                    </svg>
                    <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24"/>
                      <line x1="1" y1="1" x2="23" y2="23"/>
                    </svg>
                  </button>
                </div>
              </div>
              
              <div class="form-group">
                <label>新密码</label>
                <div class="input-wrapper">
                  <input
                    v-model="form.newPassword"
                    :type="showNewPassword ? 'text' : 'password'"
                    placeholder="请输入新密码（至少6位）"
                  />
                  <button class="toggle-btn" @click="showNewPassword = !showNewPassword">
                    <svg v-if="showNewPassword" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                      <circle cx="12" cy="12" r="3"/>
                    </svg>
                    <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24"/>
                      <line x1="1" y1="1" x2="23" y2="23"/>
                    </svg>
                  </button>
                </div>
              </div>
              
              <div class="form-group">
                <label>确认新密码</label>
                <div class="input-wrapper">
                  <input
                    v-model="form.confirmPassword"
                    :type="showConfirmPassword ? 'text' : 'password'"
                    placeholder="请再次输入新密码"
                  />
                  <button class="toggle-btn" @click="showConfirmPassword = !showConfirmPassword">
                    <svg v-if="showConfirmPassword" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                      <circle cx="12" cy="12" r="3"/>
                    </svg>
                    <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24"/>
                      <line x1="1" y1="1" x2="23" y2="23"/>
                    </svg>
                  </button>
                </div>
              </div>
            </div>
            
            <div class="modal-footer">
              <button class="btn btn-cancel" @click="handleClose">取消</button>
              <button class="btn btn-confirm" @click="handleSubmit" :disabled="loading">
                <span v-if="loading" class="loading-spinner"></span>
                {{ loading ? '提交中...' : '确认修改' }}
              </button>
            </div>
          </div>
        </Transition>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, reactive, watch, computed } from 'vue'
import { changePassword } from '../api/auth'
import { useToast } from '../composables/useToast'

const props = defineProps<{
  modelValue: boolean
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void
  (e: 'success'): void
}>()

const toast = useToast()

const visible = computed({
  get: () => props.modelValue,
  set: (val) => emit('update:modelValue', val)
})

const form = reactive({
  oldPassword: '',
  newPassword: '',
  confirmPassword: ''
})

const showOldPassword = ref(false)
const showNewPassword = ref(false)
const showConfirmPassword = ref(false)
const loading = ref(false)

const resetForm = () => {
  form.oldPassword = ''
  form.newPassword = ''
  form.confirmPassword = ''
  showOldPassword.value = false
  showNewPassword.value = false
  showConfirmPassword.value = false
}

const handleClose = () => {
  visible.value = false
  resetForm()
}

const handleSubmit = async () => {
  if (!form.oldPassword) {
    toast.warning('请输入原密码')
    return
  }
  
  if (!form.newPassword || form.newPassword.length < 6) {
    toast.warning('新密码长度不能少于6位')
    return
  }
  
  if (form.newPassword !== form.confirmPassword) {
    toast.warning('两次输入的新密码不一致')
    return
  }
  
  loading.value = true
  
  try {
    await changePassword(form.oldPassword, form.newPassword)
    toast.success('密码修改成功')
    emit('success')
    handleClose()
  } catch (e: any) {
    toast.error(e.message || '密码修改失败')
  } finally {
    loading.value = false
  }
}

watch(() => props.modelValue, (val) => {
  if (!val) {
    resetForm()
  }
})
</script>

<style lang="scss" scoped>
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.7);
  backdrop-filter: blur(4px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 9999;
  padding: 20px;
}

.modal-container {
  background: var(--bg-card, #1c1c1f);
  border: 1px solid var(--border-color, #27272a);
  border-radius: 16px;
  width: 100%;
  max-width: 420px;
  box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);
}

.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 20px 24px;
  border-bottom: 1px solid var(--border-color, #27272a);
  
  h3 {
    margin: 0;
    font-size: 1.125rem;
    font-weight: 600;
    color: var(--text-primary, #f4f4f5);
  }
  
  .close-btn {
    width: 32px;
    height: 32px;
    border: none;
    background: transparent;
    color: var(--text-secondary, #a1a1aa);
    cursor: pointer;
    border-radius: 8px;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.2s;
    
    &:hover {
      background: var(--bg-hover, #27272a);
      color: var(--text-primary, #f4f4f5);
    }
    
    svg {
      width: 18px;
      height: 18px;
    }
  }
}

.modal-body {
  padding: 24px;
  
  .form-group {
    margin-bottom: 20px;
    
    &:last-child {
      margin-bottom: 0;
    }
    
    label {
      display: block;
      font-size: 0.875rem;
      font-weight: 500;
      color: var(--text-secondary, #a1a1aa);
      margin-bottom: 8px;
    }
    
    .input-wrapper {
      position: relative;
      display: flex;
      align-items: center;
      
      input {
        width: 100%;
        height: 44px;
        padding: 0 44px 0 16px;
        background: var(--bg-hover, #27272a);
        border: 1px solid var(--border-color, #27272a);
        border-radius: 10px;
        color: var(--text-primary, #f4f4f5);
        font-size: 0.9rem;
        transition: all 0.2s;
        
        &::placeholder {
          color: var(--text-secondary, #a1a1aa);
        }
        
        &:focus {
          outline: none;
          border-color: var(--accent-color, #8b5cf6);
          background: var(--bg-card, #1c1c1f);
        }
      }
      
      .toggle-btn {
        position: absolute;
        right: 12px;
        width: 24px;
        height: 24px;
        border: none;
        background: transparent;
        color: var(--text-secondary, #a1a1aa);
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        
        &:hover {
          color: var(--text-primary, #f4f4f5);
        }
        
        svg {
          width: 18px;
          height: 18px;
        }
      }
    }
  }
}

.modal-footer {
  display: flex;
  gap: 12px;
  padding: 16px 24px;
  border-top: 1px solid var(--border-color, #27272a);
  
  .btn {
    flex: 1;
    height: 44px;
    border-radius: 10px;
    font-size: 0.9rem;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.2s;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    
    &:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }
    
    &.btn-cancel {
      background: var(--bg-hover, #27272a);
      border: 1px solid var(--border-color, #27272a);
      color: var(--text-secondary, #a1a1aa);
      
      &:hover:not(:disabled) {
        background: var(--bg-card, #1c1c1f);
        color: var(--text-primary, #f4f4f5);
      }
    }
    
    &.btn-confirm {
      background: linear-gradient(135deg, #7c3aed 0%, #06b6d4 100%);
      border: none;
      color: white;
      
      &:hover:not(:disabled) {
        opacity: 0.9;
        transform: translateY(-1px);
      }
    }
  }
  
  .loading-spinner {
    width: 16px;
    height: 16px;
    border: 2px solid rgba(255, 255, 255, 0.3);
    border-top-color: white;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.modal-fade-enter-active,
.modal-fade-leave-active {
  transition: opacity 0.2s ease;
}

.modal-fade-enter-from,
.modal-fade-leave-to {
  opacity: 0;
}

.modal-scale-enter-active,
.modal-scale-leave-active {
  transition: all 0.2s ease;
}

.modal-scale-enter-from,
.modal-scale-leave-to {
  opacity: 0;
  transform: scale(0.95);
}
</style>
