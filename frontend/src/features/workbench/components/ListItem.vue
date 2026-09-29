<template>
  <div class="map-item" @click="$emit('open', item)">
    <div class="map-item-content">
      <el-icon class="map-icon"><component :is="icon" /></el-icon>
      <div class="map-info">
        <el-tooltip :content="getTitle(item)" placement="right" :show-after="400" :hide-after="0">
          <span class="map-title">{{ getTitle(item) }}</span>
        </el-tooltip>
        <span class="map-time">{{ getSubtitle(item) }}</span>
      </div>
    </div>
    <div class="map-actions">
      <el-icon class="delete-icon" @click.stop="$emit('delete', item)"><Delete /></el-icon>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { Component } from 'vue'
import { Delete } from '@element-plus/icons-vue'

export interface ListItem {
  id: number
  [key: string]: any
}

withDefaults(defineProps<{
  item: ListItem
  icon: Component
  getTitle: (item: ListItem) => string
  getSubtitle: (item: ListItem) => string
}>(), {
  getSubtitle: () => '',
})

const emit = defineEmits<{
  (e: 'open', item: ListItem): void
  (e: 'delete', item: ListItem): void
}>()
</script>

<style scoped>
.map-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px;
  border-radius: 8px;
  cursor: pointer;
  transition: background 0.15s;
  margin-bottom: 2px;

  &:hover {
    background: var(--bg-hover);

    .map-actions {
      opacity: 1;
    }
  }

  .map-item-content {
    display: flex;
    align-items: center;
    gap: 8px;
    overflow: hidden;
    flex: 1;

    .map-icon {
      font-size: 14px;
      color: var(--accent-color);
      flex-shrink: 0;
    }

    .map-info {
      display: flex;
      flex-direction: column;
      gap: 2px;
      overflow: hidden;

      .map-title {
        font-size: 0.82rem;
        color: var(--text-primary);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .map-time {
        font-size: 0.7rem;
        color: var(--text-secondary);
      }
    }
  }

  .map-actions {
    opacity: 0;
    transition: opacity 0.15s;
    flex-shrink: 0;

    .delete-icon {
      font-size: 14px;
      color: var(--text-secondary);
      padding: 4px;
      border-radius: 4px;
      transition: all 0.15s;
      cursor: pointer;

      &:hover {
        background: rgba(239, 68, 68, 0.15);
        color: #ef4444;
      }
    }
  }
}
</style>