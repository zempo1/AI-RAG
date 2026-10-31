<template>
  <div class="history-scroll">
    <div class="section-label">历史记录</div>
    <div v-if="loading" class="list-empty">加载中…</div>
    <div v-else-if="items.length === 0" class="list-empty">{{ emptyText }}</div>
    <ListItem
      v-for="item in items"
      :key="item.id"
      :item="item"
      :icon="icon"
      :get-title="() => getTitle(item)"
      :get-subtitle="() => getSubtitle(item)"
      @open="$emit('open', item)"
      @delete="$emit('delete', item)"
    />
  </div>
</template>

<script setup lang="ts" generic="T extends ListItemType">
import type { Component } from "vue";
import type { ListItem as ListItemType } from "../ListItem/ListItem.vue";
import ListItem from "../ListItem/ListItem.vue";

withDefaults(
  defineProps<{
    items: T[];
    icon: Component;
    emptyText: string;
    loading?: boolean;
    getTitle: (item: T) => string;
    getSubtitle?: (item: T) => string;
  }>(),
  {
    loading: false,
    getSubtitle: () => "",
  },
);

const emit = defineEmits<{
  (e: "open", item: T): void;
  (e: "delete", item: T): void;
}>();
</script>

<style scoped lang="scss">
@use "./HistoryList.scss";
</style>
