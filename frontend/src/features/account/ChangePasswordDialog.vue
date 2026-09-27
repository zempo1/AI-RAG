<template>
  <Teleport to="body">
    <Transition name="modal-fade">
      <div v-if="visible" class="modal-overlay" @click.self="handleClose">
        <Transition name="modal-scale">
          <div v-if="visible" class="modal-container">
            <div class="modal-header">
              <h3>账户设置</h3>
              <button class="close-btn" @click="handleClose">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M18 6L6 18M6 6l12 12" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
              </button>
            </div>
            
            <div class="modal-tabs">
              <button 
                class="tab-btn" 
                :class="{ active: activeTab === 'username' }"
                @click="activeTab = 'username'"
              >
                修改用户名
              </button>
              <button 
                class="tab-btn" 
                :class="{ active: activeTab === 'password' }"
                @click="activeTab = 'password'"
              >
                修改密码
              </button>
            </div>
            
            <div class="modal-body">
              <div v-if="activeTab === 'username'" class="form-group">
                <label>新用户名</label>
                <div class="input-wrapper">
                  <input
                    v-model="usernameForm.newUsername"
                    type="text"
                    placeholder="请输入新用户名（2-20个字符）"
                  />
                </div>
              </div>
              
              <template v-else>
                <div class="form-group">
                  <label>原密码</label>
                  <div class="input-wrapper">
                    <input
                      v-model="passwordForm.oldPassword"
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
                      v-model="passwordForm.newPassword"
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
                      v-model="passwordForm.confirmPassword"
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
              </template>
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
import { changePassword, changeUsername } from '../../api/auth'
import { useToast } from '../../composables/useToast'

const props = defineProps<{
  modelValue: boolean
  currentUsername?: string
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void
  (e: 'success'): void
  (e: 'username-changed', username: string): void
}>()

const toast = useToast()

const visible = computed({
  get: () => props.modelValue,
  set: (val) => emit('update:modelValue', val)
})

const activeTab = ref<'username' | 'password'>('username')

const usernameForm = reactive({
  newUsername: ''
})

const passwordForm = reactive({
  oldPassword: '',
  newPassword: '',
  confirmPassword: ''
})

const showOldPassword = ref(false)
const showNewPassword = ref(false)
const showConfirmPassword = ref(false)
const loading = ref(false)

const resetForm = () => {
  usernameForm.newUsername = ''
  passwordForm.oldPassword = ''
  passwordForm.newPassword = ''
  passwordForm.confirmPassword = ''
  showOldPassword.value = false
  showNewPassword.value = false
  showConfirmPassword.value = false
}

const handleClose = () => {
  visible.value = false
  resetForm()
}

const handleSubmit = async () => {
  if (activeTab.value === 'username') {
    await handleUsernameSubmit()
  } else {
    await handlePasswordSubmit()
  }
}

const handleUsernameSubmit = async () => {
  const newUsername = usernameForm.newUsername.trim()
  
  if (!newUsername) {
    toast.warning('请输入新用户名')
    return
  }
  
  if (newUsername.length < 2 || newUsername.length > 20) {
    toast.warning('用户名长度需要在2-20个字符之间')
    return
  }
  
  if (newUsername === props.currentUsername) {
    toast.warning('新用户名与当前用户名相同')
    return
  }
  
  loading.value = true
  
  try {
    await changeUsername(newUsername)
    localStorage.setItem('username', newUsername)
    toast.success('用户名修改成功')
    emit('username-changed', newUsername)
    emit('success')
    handleClose()
  } catch (e: any) {
    toast.error(e?.response?.data?.message || e.message || '用户名修改失败')
  } finally {
    loading.value = false
  }
}

const handlePasswordSubmit = async () => {
  if (!passwordForm.oldPassword) {
    toast.warning('请输入原密码')
    return
  }
  
  if (!passwordForm.newPassword || passwordForm.newPassword.length < 6) {
    toast.warning('新密码长度不能少于6位')
    return
  }
  
  if (passwordForm.newPassword !== passwordForm.confirmPassword) {
    toast.warning('两次输入的新密码不一致')
    return
  }
  
  loading.value = true
  
  try {
    await changePassword(passwordForm.oldPassword, passwordForm.newPassword)
    toast.success('密码修改成功')
    emit('success')
    handleClose()
  } catch (e: any) {
    toast.error(e?.response?.data?.message || e.message || '密码修改失败')
  } finally {
    loading.value = false
  }
}

watch(() => props.modelValue, (val) => {
  if (val) {
    resetForm()
    activeTab.value = 'username'
  }
})
</script>

<style lang="scss" src="./ChangePasswordDialog.scss" scoped></style>