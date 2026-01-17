import request from '../utils/request'

export const getChatHistory = (id: number) => {
  return request.get(`/api/chats/${id}`)
}

export interface StreamChatParams {
  question: string
  chatId: number | null
}

export const sendStreamChat = async (
  params: StreamChatParams,
  callbacks: {
    onMessage: (text: string) => void
    onChatId: (id: number) => void
    onError: (err: any) => void
    onFinish: () => void
  }
) => {
  try {
    const apiKey = localStorage.getItem('user_api_key')
    const headers: Record<string, string> = {
      'Content-Type': 'application/json'
    }
    if (apiKey) {
      headers['X-Api-Key'] = apiKey
    }

    const response = await fetch('/api/stream-chat', {
      method: 'POST',
      headers,
      body: JSON.stringify(params)
    })

    if (!response.ok) throw new Error('Network response was not ok')
    if (!response.body) throw new Error('Response body is null')

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let eventType = 'message'

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      const chunk = decoder.decode(value, { stream: true })
      const lines = chunk.split('\n')
      
      for (const line of lines) {
        if (line.startsWith('event:')) {
          eventType = line.slice(6).trim()
        } else if (line.startsWith('data:')) {
          const data = line.slice(5).trim()
          if (data) {
            if (eventType === 'chatId') {
              const newChatId = parseInt(data)
              if (!isNaN(newChatId)) {
                callbacks.onChatId(newChatId)
              }
            } else {
              try {
                const token = JSON.parse(data)
                callbacks.onMessage(token)
              } catch (e) {
                console.error('Error parsing SSE data', e)
              }
            }
          }
        } else if (line.trim() === '') {
          eventType = 'message'
        }
      }
    }
    callbacks.onFinish()
  } catch (error) {
    callbacks.onError(error)
  }
}
