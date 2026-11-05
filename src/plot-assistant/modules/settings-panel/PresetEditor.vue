<script setup lang="ts">
/**
 * 预设本级的两段：名字 / 最终注入指令。
 *
 * **它只改传进来的那份草稿**（`props.draft` 是外层 `klona` 出来的副本），
 * 不读存储、不碰数据库脚本 —— 写回磁盘是外层点「应用修改」之后的事。
 *
 * 这里只放**真正会生效**的字段：名字（落盘时找哪条）、最终注入指令（生成时真注入正文）。
 * 召回条数、四个强度、预设级最短长度、预设级标签串**一个都没有**：它们要么只是填进
 * 提示词的占位符数字（召回多少条由提示词自己说），要么只在「预设里没有任务表」的兜底
 * 路径里被读。摆出来就是骗人，见 `COMPAT_PLACEHOLDER_DEFAULTS`。
 */
import { UI } from '../copy';
import type { PresetDraft } from '../plot/preset-edit';

defineProps<{
  draft: PresetDraft;
}>();
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
</template>
