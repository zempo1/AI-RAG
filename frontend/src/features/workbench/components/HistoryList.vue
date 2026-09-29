<template>
  <div class="history-scroll">
    <div class="section-label">历史记录</div>
    <div v-if="loading" class="list-empty">加载中…</div>
    <div v-else-if="items.length === 0" class="list-empty">{{ emptyText }}</div>
    <ListItem
      v-for="item in items" :key="item.id"
      :item="item" :icon="icon"
      :get-title="getTitle"
      :get-subtitle="getSubtitle"
      @open="$emit('open', item)"
      @delete="$emit('delete', item)"
    />
  </div>
</template>

<script setup lang="ts">
import type { Component } from 'vue'
import type { ListItem as ListItemType } from './ListItem.vue'
import ListItem from './ListItem.vue'

withDefaults(defineProps<{
  items: ListItemType[]
  icon: Component
  emptyText: string
  loading?: boolean
  getTitle: (item: ListItemType) => string
  getSubtitle?: (item: ListItemType) => string
}>(), {
  loading: false,
  getSubtitle: () => '',
})

const emit = defineEmits<{
  (e: 'open', item: ListItemType): void
  (e: 'delete', item: ListItemType): void
}>()
</script>

<style scoped>
.history-scroll {
  flex: 1;
  overflow-y: auto;
  padding: 10px 6px 6px;

  .section-label {
    font-size: 0.68rem;
    font-weight: 700;
    color: var(--text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    margin-bottom: 6px;
    padding: 0 6px;
  }

  .list-empty {
    font-size: 0.8rem;
    color: var(--text-secondary);
    text-align: center;
    padding: 20px 0;
  }
}
</style>