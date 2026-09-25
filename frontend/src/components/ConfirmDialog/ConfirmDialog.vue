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

<style lang="scss" src="./ConfirmDialog.scss" scoped></style>