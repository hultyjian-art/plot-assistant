<script setup lang="ts">
/* eslint-disable vue/no-mutating-props -- 这里改的是外层 klona 出来的草稿副本，不是原预设对象 */
/**
 * 预设本级的两段：名字 / 最终注入指令 / 标签差量。
 *
 * **它只改传进来的那份草稿**（`props.draft` 是外层 `klona` 出来的副本），
 * 不读存储、不碰数据库脚本 —— 写回磁盘是外层点「应用修改」之后的事。
 *
 * 这里只放**真正会生效**的字段：名称、最终注入指令、标签差量表。
 * 召回条数、四个强度、预设级最短长度、预设级标签串**一个都没有**：它们要么只是填进
 * 提示词的占位符数字，要么只在「预设里没有任务表」的兜底路径里被读。摆出来就是骗人，
 * 见 `COMPAT_PLACEHOLDER_DEFAULTS`。
 */
import { computed } from 'vue';
import { UI } from '../copy';
import type { PresetDraft, TaskDraft } from '../plot/preset-edit';

const props = defineProps<{
  draft: PresetDraft;
  /** 当前任务草稿：标签差量表要从任务抽取标签和最终注入里收集标签名。 */
  tasks?: TaskDraft[];
}>();

/**
 * 预设里所有出现过的标签名：任务抽取标签 + 最终注入模板里的 {{标签}}。
 *
 * 不在这个列表里的标签没法在界面上开关；但引擎仍会按预设里的 `tagDiffModes` 认，
 * 所以用户从旧预设导入的未知标签也会保留（下面遍历 tagDiffModes 的键一并列出来）。
 */
const knownTags = computed<string[]>(() => {
  const seen = new Set<string>();
  const push = (raw: unknown): void => {
    const name = String(raw ?? '').trim();
    if (name !== '') seen.add(name);
  };

  for (const task of props.tasks ?? []) {
    for (const raw of [task.extractTags, task.extractInjectTags]) {
      for (const name of String(raw ?? '').split(',')) push(name);
    }
  }

  const pattern = /\{\{(\w+)\}\}/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(String(props.draft.prompts.finalDirective ?? ''))) !== null) {
    push(match[1]);
  }

  for (const name of Object.keys(props.draft.tagDiffModes ?? {})) push(name);
  return Array.from(seen).sort((left, right) => left.localeCompare(right, 'zh-Hans-CN'));
});

function modeOf(tag: string): string {
  return props.draft.tagDiffModes?.[tag] ?? 'off';
}

function setMode(tag: string, value: string): void {
  if (!props.draft.tagDiffModes) props.draft.tagDiffModes = {};
  if (value === 'keep' || value === 'blocks') props.draft.tagDiffModes[tag] = value;
  else delete props.draft.tagDiffModes[tag];
}
</script>

<template>
  <div class="acu-section">
    <h4>{{ UI.plot.editorMeta }}</h4>
    <div class="acu-row">
      <label style="flex: 0 0 96px">{{ UI.plot.editorName }}</label>
      <input v-model="draft.meta.name" class="acu-input" type="text" placeholder="预设名" style="flex: 1 1 220px; min-width: 0" />
    </div>
  </div>

  <div class="acu-section">
    <h4>{{ UI.plot.editorPrompts }}</h4>
    <p class="acu-notes">{{ UI.plot.editorPromptsHint }}</p>

    <div class="acu-row" style="align-items: flex-start">
      <textarea v-model="draft.prompts.finalDirective" class="acu-textarea" rows="8" style="flex: 1 1 auto"></textarea>
    </div>
    <p class="acu-notes acu-notes--sm">{{ UI.plot.editorPromptFinalHint }}</p>
  </div>

  <div class="acu-section">
    <h4>{{ UI.plot.editorTagDiff }}</h4>
    <p class="acu-notes">{{ UI.plot.editorTagDiffHint }}</p>
    <p v-if="knownTags.length === 0" class="acu-notes acu-notes--sm">{{ UI.plot.editorTagDiffEmpty }}</p>
    <div v-for="tag in knownTags" :key="tag" class="acu-tagdiff-row">
      <code class="acu-tagdiff-name">{{ tag }}</code>
      <select
        class="acu-select acu-tagdiff-select"
        :value="modeOf(tag)"
        @change="setMode(tag, ($event.target as HTMLSelectElement).value)"
      >
        <option value="off">{{ UI.plot.tagDiffOff }}</option>
        <option value="keep">{{ UI.plot.tagDiffKeep }}</option>
        <option value="blocks">{{ UI.plot.tagDiffBlocks }}</option>
      </select>
    </div>
  </div>
</template>

<style scoped>
.acu-tagdiff-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 4px;
}

.acu-tagdiff-name {
  flex: 0 0 auto;
  min-width: 104px;
  padding: 2px 6px;
  border-radius: 4px;
  background: var(--acu-surface-2, rgba(127, 127, 127, 0.12));
  color: var(--acu-text-2, inherit);
  font-size: 12px;
  line-height: 1.6;
}

.acu-tagdiff-select {
  flex: 1 1 auto;
  min-width: 0;
}
</style>
