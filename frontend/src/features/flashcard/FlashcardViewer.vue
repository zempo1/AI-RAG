<template>
  <div v-if="visible" class="flashcard-overlay">
    <!-- 顶部标题栏 -->
    <div class="fc-header">
      <div class="fc-title-area">
        <div class="fc-title">
          <span class="fc-icon">🃏</span>
          <span>{{ docName }} — 学习卡片</span>
        </div>
        <div class="fc-progress">{{ current + 1 }} / {{ cards.length }}</div>
      </div>
      <button class="fc-close" @click="visible = false">✕ 关闭</button>
    </div>

    <!-- 卡片区域 -->
    <div class="fc-body">
      <div v-if="cards.length === 0" class="fc-empty">暂无卡片数据</div>

      <template v-else>
        <!-- 进度条 -->
        <div class="fc-progress-bar">
          <div class="fc-progress-fill" :style="{ width: ((current + 1) / cards.length * 100) + '%' }" />
        </div>

        <!-- 卡片 -->
        <div class="fc-card-wrap">
          <div class="fc-card" :class="{ flipped: isFlipped }" @click="isFlipped = !isFlipped">
            <div class="fc-card-front">
              <div class="fc-card-label">Q</div>
              <div class="fc-card-text">{{ cards[current]?.q }}</div>
              <div class="fc-card-hint">点击查看答案</div>
            </div>
            <div class="fc-card-back">
              <div class="fc-card-label">A</div>
              <div class="fc-card-text">{{ cards[current]?.a }}</div>
              <div class="fc-card-hint">点击回到问题</div>
            </div>
          </div>
        </div>

        <!-- 导航 -->
        <div class="fc-nav">
          <button class="fc-btn fc-btn-prev" :disabled="current === 0" @click="prev">
            ← 上一张
          </button>
          <div class="fc-dots">
            <span
              v-for="(_, i) in cards" :key="i"
              class="fc-dot" :class="{ active: i === current, answered: answered.has(i) }"
              @click="goTo(i)"
            />
          </div>
          <button class="fc-btn fc-btn-next" :disabled="current === cards.length - 1" @click="next">
            下一张 →
          </button>
        </div>

        <!-- 底部操作 -->
        <div class="fc-footer">
          <button class="fc-action fc-action-reset" @click="reset">
            🔄 重新开始
          </button>
          <div class="fc-stats">
            已浏览 <strong>{{ answered.size }}</strong> / {{ cards.length }} 张
          </div>
          <button class="fc-action fc-action-export" @click="exportCards">
            ⬇ 导出 Markdown
          </button>
        </div>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, computed } from 'vue'

interface FlashCard { q: string; a: string }

const props = defineProps<{
  modelValue: boolean
  content: string       // JSON string from backend
  docName: string
}>()
const emit = defineEmits(['update:modelValue'])

const visible = ref(false)
const current = ref(0)
const isFlipped = ref(false)
const answered = ref(new Set<number>())

watch(() => props.modelValue, (val) => {
  visible.value = val
  if (val) { reset() }
})
watch(() => visible.value, (val) => emit('update:modelValue', val))

const cards = computed<FlashCard[]>(() => {
  if (!props.content) return []
  try {
    let raw = props.content.trim()
    // 去掉可能存在的 ```json ``` 包裹
    raw = raw.replace(/^```json\n?/, '').replace(/^```\n?/, '').replace(/\n?```$/, '')
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) return parsed as FlashCard[]
  } catch (e) {
    console.warn('Flashcard parse error', e)
  }
  return []
})

function prev() {
  if (current.value > 0) { current.value--; isFlipped.value = false }
}
function next() {
  answered.value.add(current.value)
  if (current.value < cards.value.length - 1) { current.value++; isFlipped.value = false }
}
function goTo(i: number) {
  if (i !== current.value) { answered.value.add(current.value); current.value = i; isFlipped.value = false }
}
function reset() {
  current.value = 0
  isFlipped.value = false
  answered.value = new Set()
}
function exportCards() {
  const lines = [`# 学习卡片 — ${props.docName}\n`]
  cards.value.forEach((c, i) => {
    lines.push(`## 卡片 ${i + 1}\n\n**Q：** ${c.q}\n\n**A：** ${c.a}\n`)
  })
  const blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${props.docName}_学习卡片.md`
  a.click()
  URL.revokeObjectURL(url)
}
</script>

<style lang="scss" src="./FlashcardViewer.scss" scoped></style>