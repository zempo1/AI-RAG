import request from '../utils/request'

export const changePassword = async (oldPassword: string, newPassword: string) => {
  return request.post('/api/auth/change-password', {
    oldPassword,
    newPassword
  })
}
