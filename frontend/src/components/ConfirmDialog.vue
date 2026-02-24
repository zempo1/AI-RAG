<template>
  <Teleport to="body">
    <Transition name="confirm-fade">
      <div v-if="visible" class="confirm-overlay" @click.self="handleCancel">
        <Transition name="confirm-scale">
          <div v-if="visible" class="confirm-dialog" :class="[`confirm-${type}`]">
            <div class="confirm-icon-wrapper">
              <div class="confirm-icon" :class="`icon-${type}`">
                <svg v-if="type === 'warning'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M12 9v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
                <svg v-else-if="type === 'danger'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
                <svg v-else-if="type === 'success'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
                <svg v-else-if="type === 'info'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
              </div>
            </div>
            
            <div class="confirm-content">
              <h3 v-if="title" class="confirm-title">{{ title }}</h3>
              <p class="confirm-message">{{ message }}</p>
            </div>
            
            <div class="confirm-actions">
              <button 
                class="confirm-btn btn-cancel" 
                @click="handleCancel"
                :disabled="loading"
              >
                {{ cancelText }}
              </button>
              <button 
                class="confirm-btn btn-confirm" 
                :class="`btn-${type}`"
                @click="handleConfirm"
                :disabled="loading"
              >
                <span v-if="loading" class="btn-loading">
                  <svg class="spinner" viewBox="0 0 24 24">
                    <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="3" fill="none" stroke-dasharray="31.4 31.4" stroke-linecap="round"/>
                  </svg>
                </span>
                {{ confirmText }}
              </button>
            </div>
          </div>
        </Transition>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'

export interface ConfirmDialogProps {
  visible?: boolean
  title?: string
  message: string
  type?: 'warning' | 'danger' | 'success' | 'info'
  confirmText?: string
  cancelText?: string
  loading?: boolean
}

const props = withDefaults(defineProps<ConfirmDialogProps>(), {
  visible: false,
  title: '',
  type: 'warning',
  confirmText: '确定',
  cancelText: '取消',
  loading: false
})

const emit = defineEmits<{
  (e: 'update:visible', value: boolean): void
  (e: 'confirm'): void
  (e: 'cancel'): void
}>()

const handleConfirm = () => {
  emit('confirm')
}

const handleCancel = () => {
  if (props.loading) return
  emit('update:visible', false)
  emit('cancel')
}

watch(() => props.visible, (val) => {
  if (val) {
    document.body.style.overflow = 'hidden'
  } else {
    document.body.style.overflow = ''
  }
})
</script>

<style lang="scss" scoped>
.confirm-overlay {
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

.confirm-dialog {
  background: var(--bg-card, #1c1c1f);
  border: 1px solid var(--border-color, #27272a);
  border-radius: 16px;
  padding: 24px;
  max-width: 400px;
  width: 100%;
  box-shadow: 
    0 25px 50px -12px rgba(0, 0, 0, 0.5),
    0 0 0 1px rgba(255, 255, 255, 0.05);
  
  &.confirm-danger {
    .confirm-icon-wrapper {
      background: rgba(239, 68, 68, 0.1);
    }
  }
}

.confirm-icon-wrapper {
  width: 56px;
  height: 56px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  margin: 0 auto 20px;
  background: rgba(139, 92, 246, 0.1);
}

.confirm-icon {
  width: 28px;
  height: 28px;
  
  svg {
    width: 100%;
    height: 100%;
  }
  
  &.icon-warning {
    color: #f59e0b;
  }
  
  &.icon-danger {
    color: #ef4444;
  }
  
  &.icon-success {
    color: #22c55e;
  }
  
  &.icon-info {
    color: #3b82f6;
  }
}

.confirm-content {
  text-align: center;
  margin-bottom: 24px;
}

.confirm-title {
  margin: 0 0 8px;
  font-size: 1.125rem;
  font-weight: 600;
  color: var(--text-primary, #f4f4f5);
}

.confirm-message {
  margin: 0;
  font-size: 0.9rem;
  color: var(--text-secondary, #a1a1aa);
  line-height: 1.6;
}

.confirm-actions {
  display: flex;
  gap: 12px;
  justify-content: center;
}

.confirm-btn {
  flex: 1;
  padding: 12px 24px;
  border-radius: 10px;
  font-size: 0.9rem;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
  border: none;
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
    color: var(--text-secondary, #a1a1aa);
    border: 1px solid var(--border-color, #27272a);
    
    &:hover:not(:disabled) {
      background: var(--bg-card, #1c1c1f);
      color: var(--text-primary, #f4f4f5);
      border-color: var(--text-secondary, #a1a1aa);
    }
  }
  
  &.btn-confirm {
    background: linear-gradient(135deg, #7c3aed 0%, #06b6d4 100%);
    color: white;
    
    &:hover:not(:disabled) {
      opacity: 0.9;
      transform: translateY(-1px);
    }
  }
  
  &.btn-danger {
    background: linear-gradient(135deg, #ef4444 0%, #f97316 100%);
  }
  
  &.btn-warning {
    background: linear-gradient(135deg, #f59e0b 0%, #eab308 100%);
  }
  
  &.btn-success {
    background: linear-gradient(135deg, #22c55e 0%, #10b981 100%);
  }
  
  &.btn-info {
    background: linear-gradient(135deg, #3b82f6 0%, #06b6d4 100%);
  }
}

.btn-loading {
  display: flex;
  align-items: center;
  
  .spinner {
    width: 16px;
    height: 16px;
    animation: spin 1s linear infinite;
  }
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.confirm-fade-enter-active,
.confirm-fade-leave-active {
  transition: opacity 0.2s ease;
}

.confirm-fade-enter-from,
.confirm-fade-leave-to {
  opacity: 0;
}

.confirm-scale-enter-active,
.confirm-scale-leave-active {
  transition: all 0.2s ease;
}

.confirm-scale-enter-from,
.confirm-scale-leave-to {
  opacity: 0;
  transform: scale(0.95);
}
</style>
