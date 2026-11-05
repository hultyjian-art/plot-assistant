<script setup lang="ts">
/**
 * 一段提示词 —— 折叠卡。
 *
 * 形态照搬工作流助手的 `ui/PromptSegmentCard.vue`：标题栏显示「段名 + role 标签 + 展开箭头」，
 * 展开后是一排工具栏（段名 / role 下拉 / 上移 / 下移 / 启用开关 / 删段）加正文框。
 * 改动只有三处，都是我们这边缺的东西：
 *   1. 段名和 role 用我们自己的字段名（`name` / `role`），不引它的 zod schema；
 *   2. 多一个「复制」——引擎里有 `copyBlockDraft`，面板上却没有入口；
 *   3. 正文框默认高度调高（工作流助手那边展开后太矮，看两三行就要拖）。
 *
 * 展开状态存在本组件内：拖动排序、上移下移都不会重置它，因为父级用块对象本身做 key。
 */
import { computed, ref } from 'vue';
import { UI } from '../copy';
import type { TaskBlockDraft } from '../plot/preset-edit';

const props = defineProps<{
  block: TaskBlockDraft;
  index: number;
  count: number;
}>();

const emit = defineEmits<{
  move: [delta: -1 | 1];
  remove: [];
  copy: [];
  send: [];
}>();

const expanded = ref(false);

/**
 * 三种合法角色，**大写**——预设数据里存的就是 `SYSTEM` / `USER` / `ASSISTANT`
 * （`plot/preset-edit.ts` 建草稿时也这么写）。引擎发送前会经 `normalizeRole` 归一成小写，
 * 所以这里跟着数据走，不要另立一套小写。
 */
const ROLES = ['SYSTEM', 'USER', 'ASSISTANT'] as const;

/** 数据里可能有这三种之外的写法（旧预设的 `AI`、手改过的怪值）。有就原样列出来，别让它显示成空白。 */
const fallbackRole = computed(() => {
  const role = String(props.block.role ?? '').trim();
  if (role === '') return '';
  // 比的时候不分大小写：存量数据里大小写都有，都算认得，
  // 不然下拉里会多出一个只是大小写不同的重复项。
  return (ROLES as readonly string[]).includes(role.toUpperCase()) ? '' : role;
});

/**
 * 下拉绑定的值。
 *
 * 存量数据里 `system` 小写、`SYSTEM` 大写都有，直接 `v-model="block.role"` 时
 * 对不上选项的 value，下拉会显示成空白（2026-11-03 真机实测：8 个块里有 4 个空白）。
 * 读的时候按大小写归一到大写，写的时候落回大写，数据也就顺手统一了。
 */
const roleValue = computed({
  get(): string {
    const raw = String(props.block.role ?? '').trim();
    const upper = raw.toUpperCase();
    return (ROLES as readonly string[]).includes(upper) ? upper : raw;
  },
  set(next: string): void {
    props.block.role = next;
  },
});

const title = computed(() => props.block.name.trim() || `${UI.plot.editorBlock} ${props.index + 1}`);

const roleTag = computed(() => String(props.block.role ?? '').toUpperCase() || 'USER');

function onRemove(): void {
  emit('remove');
}
</script>

<template>
  <div class="acu-prompt-group" :class="{ 'acu-prompt-group--disabled': !block.enabled }">
    <div class="acu-prompt-group__header-row">
      <button type="button" class="acu-prompt-group__header" :aria-expanded="expanded" @click="expanded = !expanded">
        <span class="acu-prompt-group__header-main">
          <span class="acu-prompt-group__header-name" :title="title">{{ title }}</span>
          <span class="acu-prompt-group__role-tag">{{ roleTag }}</span>
        </span>
        <span class="acu-prompt-group__chevron" aria-hidden="true">{{ expanded ? '▾' : '▸' }}</span>
      </button>
    </div>

    <div v-show="expanded" class="acu-prompt-group__body">
      <div class="acu-prompt-group__toolbar">
        <input v-model="block.name" class="acu-input acu-prompt-group__name" type="text" :placeholder="UI.plot.editorBlockName" />

        <select v-model="roleValue" class="acu-select">
          <!-- 值和显示都用大写，跟上面那枚标签一致；引擎那边会归一成小写 -->
          <option v-for="role in ROLES" :key="role" :value="role">{{ role }}</option>
          <option v-if="fallbackRole !== ''" :value="fallbackRole">{{ fallbackRole }}</option>
        </select>

        <button class="acu-btn acu-btn--sm" type="button" :title="UI.plot.editorBlockUp" :disabled="index <= 0" @click="emit('move', -1)">
          {{ UI.plot.editorBlockUp }}
        </button>
        <button
          class="acu-btn acu-btn--sm"
          type="button"
          :title="UI.plot.editorBlockDown"
          :disabled="index >= count - 1"
          @click="emit('move', 1)"
        >
          {{ UI.plot.editorBlockDown }}
        </button>
        <button class="acu-btn acu-btn--sm" type="button" :title="UI.plot.editorBlockCopy" @click="emit('copy')">
          {{ UI.plot.editorBlockCopy }}
        </button>
        <button class="acu-btn acu-btn--sm" type="button" :title="UI.plot.editorBlockSendHint" @click="emit('send')">
          {{ UI.plot.editorBlockSend }}
        </button>

        <span class="acu-prompt-group__enable">
          <label class="acu-toggle">
            <input v-model="block.enabled" type="checkbox" class="acu-toggle__input" :aria-label="UI.plot.editorBlockOn" />
            <span class="acu-toggle__track" aria-hidden="true" />
          </label>
        </span>

        <button class="acu-btn danger acu-btn--sm acu-prompt-group__delete" type="button" @click="onRemove">
          {{ UI.plot.editorBlockDrop }}
        </button>
      </div>

      <textarea v-model="block.content" class="acu-textarea acu-prompt-group__textarea" />
    </div>
  </div>
</template>
