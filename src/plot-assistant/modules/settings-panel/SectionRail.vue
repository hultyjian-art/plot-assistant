<script setup lang="ts">
/**
 * 面板左侧的功能列。
 *
 * 为什么单独拆成一个组件：面板正文有好几页，功能列单独放着好找也好改。
 * 这里只管"选哪个大功能"，不碰设置数据。
 */

interface SectionItem {
  key: string;
  label: string;
}

const props = defineProps<{
  items: SectionItem[];
  active: string;
}>();

const emit = defineEmits<{
  (e: 'pick', key: string): void;
}>();
</script>

<template>
  <nav class="rh-rail" role="tablist">
    <button
      v-for="item in props.items"
      :key="item.key"
      type="button"
      role="tab"
      class="rh-rail-btn"
      :class="{ active: props.active === item.key }"
      :aria-selected="props.active === item.key"
      @click="emit('pick', item.key)"
    >
      <span class="rh-rail-dot" aria-hidden="true"></span>
      {{ item.label }}
    </button>
  </nav>
</template>
