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

<style scoped lang="scss">
@use './ListItem.scss';
</style>