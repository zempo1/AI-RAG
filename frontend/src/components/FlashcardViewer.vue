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

<style scoped>
.flashcard-overlay {
  position: fixed; inset: 0;
  background: linear-gradient(135deg, #0f0c1a 0%, #1a1025 50%, #0f172a 100%);
  z-index: 2000;
  display: flex; flex-direction: column;
  font-family: 'Plus Jakarta Sans', 'Microsoft YaHei', sans-serif;
}

/* 顶部 */
.fc-header {
  height: 68px;
  background: rgba(255,255,255,0.04);
  border-bottom: 1px solid rgba(255,255,255,0.08);
  display: flex; align-items: center; justify-content: space-between;
  padding: 0 36px; flex-shrink: 0;
}
.fc-title-area { display: flex; align-items: center; gap: 24px; }
.fc-title { display: flex; align-items: center; gap: 10px; font-size: 1.1rem; font-weight: 700; color: #e2e8f0; }
.fc-icon { font-size: 1.4rem; }
.fc-progress { font-size: 0.85rem; color: rgba(255,255,255,0.4); font-weight: 500; }
.fc-close {
  background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.1);
  color: rgba(255,255,255,0.5); padding: 8px 20px; border-radius: 10px;
  cursor: pointer; font-size: 0.85rem; transition: all 0.2s;
  &:hover { background: rgba(255,255,255,0.12); color: #fff; }
}

/* 主体 */
.fc-body {
  flex: 1; display: flex; flex-direction: column;
  align-items: center; justify-content: center; padding: 24px;
  gap: 24px; overflow: hidden;
}
.fc-empty { color: rgba(255,255,255,0.4); font-size: 1rem; }

/* 进度条 */
.fc-progress-bar {
  width: 100%; max-width: 680px; height: 4px;
  background: rgba(255,255,255,0.08); border-radius: 2px; overflow: hidden;
}
.fc-progress-fill {
  height: 100%; border-radius: 2px;
  background: linear-gradient(90deg, #7c3aed, #06b6d4);
  transition: width 0.4s ease;
}

/* 卡片 */
.fc-card-wrap {
  width: 100%; max-width: 640px;
  height: 300px;
  perspective: 1200px;
  cursor: pointer;
}
.fc-card {
  width: 100%; height: 100%;
  position: relative;
  transform-style: preserve-3d;
  transition: transform 0.55s cubic-bezier(0.4, 0, 0.2, 1);
  &.flipped { transform: rotateY(180deg); }
}
.fc-card-front,
.fc-card-back {
  position: absolute; inset: 0;
  backface-visibility: hidden;
  border-radius: 20px;
  display: flex; flex-direction: column;
  align-items: center; justify-content: center;
  padding: 36px 48px; gap: 16px;
  text-align: center;
}
.fc-card-front {
  background: linear-gradient(135deg, rgba(124,58,237,0.15), rgba(124,58,237,0.05));
  border: 1px solid rgba(124,58,237,0.35);
  box-shadow: 0 20px 60px rgba(124,58,237,0.15), inset 0 1px 0 rgba(255,255,255,0.06);
}
.fc-card-back {
  background: linear-gradient(135deg, rgba(6,182,212,0.12), rgba(6,182,212,0.04));
  border: 1px solid rgba(6,182,212,0.3);
  box-shadow: 0 20px 60px rgba(6,182,212,0.1), inset 0 1px 0 rgba(255,255,255,0.06);
  transform: rotateY(180deg);
}
.fc-card-label {
  font-size: 0.7rem; font-weight: 800; letter-spacing: 0.12em;
  padding: 4px 12px; border-radius: 20px; text-transform: uppercase;
  .fc-card-front & { color: #7c3aed; background: rgba(124,58,237,0.15); }
  .fc-card-back & { color: #06b6d4; background: rgba(6,182,212,0.15); }
}
.fc-card-front .fc-card-label { color: #a78bfa; background: rgba(124,58,237,0.15); }
.fc-card-back .fc-card-label { color: #22d3ee; background: rgba(6,182,212,0.15); }
.fc-card-text {
  font-size: 1.15rem; font-weight: 600; color: #f1f5f9; line-height: 1.65;
  max-height: 180px; overflow-y: auto;
}
.fc-card-hint { font-size: 0.75rem; color: rgba(255,255,255,0.2); margin-top: auto; }

/* 导航 */
.fc-nav { display: flex; align-items: center; gap: 20px; }
.fc-btn {
  padding: 10px 24px; border-radius: 10px; font-size: 0.875rem; font-weight: 600;
  cursor: pointer; transition: all 0.2s;
  background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.12);
  color: rgba(255,255,255,0.7);
  &:hover:not(:disabled) { background: rgba(255,255,255,0.12); color: #fff; }
  &:disabled { opacity: 0.3; cursor: not-allowed; }
}
.fc-btn-next {
  background: rgba(124,58,237,0.2); border-color: rgba(124,58,237,0.4); color: #a78bfa;
  &:hover:not(:disabled) { background: rgba(124,58,237,0.35); }
}
.fc-dots { display: flex; gap: 6px; flex-wrap: wrap; max-width: 320px; justify-content: center; }
.fc-dot {
  width: 8px; height: 8px; border-radius: 50%;
  background: rgba(255,255,255,0.15); cursor: pointer; transition: all 0.2s;
  &.answered { background: rgba(124,58,237,0.5); }
  &.active { background: #7c3aed; transform: scale(1.4); }
}

/* 底部 */
.fc-footer {
  display: flex; align-items: center; gap: 24px; width: 100%; max-width: 640px;
  justify-content: space-between;
}
.fc-stats { font-size: 0.82rem; color: rgba(255,255,255,0.4); }
.fc-action {
  padding: 8px 16px; border-radius: 8px; font-size: 0.82rem; font-weight: 500;
  cursor: pointer; transition: all 0.2s; border: 1px solid;
  &-reset { background: rgba(255,255,255,0.04); border-color: rgba(255,255,255,0.1); color: rgba(255,255,255,0.5); &:hover { background: rgba(255,255,255,0.1); color: #fff; } }
  &-export { background: rgba(59,130,246,0.1); border-color: rgba(59,130,246,0.3); color: #60a5fa; &:hover { background: rgba(59,130,246,0.2); } }
}
</style>
