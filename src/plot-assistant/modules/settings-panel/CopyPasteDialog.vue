<script setup lang="ts">
/**
 * 复制粘贴的**唯一去处**：一个子页面，列出本地库里每一份预设和它的任务。
 *
 * 点一行就直接粘过去，不再需要「切预设 → 滚到底部 → 挑任务 → 点粘贴」四步。
 * 只列**已经导入到本脚本**的预设：数据库脚本那边的预设是别人的数据，
 * 面板本来就不给它编辑入口，粘过去也没意义。
 */
import { UI } from '../copy';
import type { ClipKind } from './clipboard';

const props = defineProps<{
  kind: ClipKind;
  source: string;
  targets: { name: string; tasks: { index: number; name: string }[] }[];
}>();

const emit = defineEmits<{
  pick: [presetName: string, taskIndex: number];
  close: [];
}>();
</script>

<template>
  <div class="acu-copypaste-mask">
    <div class="acu-copypaste-dialog">
      <div class="acu-copypaste-dialog__head">
        <span class="acu-copypaste-dialog__title">{{ UI.plot.copyPasteTitle }}</span>
        <button class="acu-copypaste-dialog__close" type="button" :title="UI.plot.copyPasteCancel" @click="emit('close')">×</button>
      </div>

      <div class="acu-copypaste-dialog__body">
        <p class="acu-notes">{{ UI.plot.copyPasteHint(props.kind) }}</p>
        <p class="acu-notes acu-notes--sm">{{ UI.plot.copyPasteSafety }}</p>
        <p v-if="props.source !== ''" class="acu-notes acu-notes--sm">{{ UI.plot.copyPasteFrom(props.source) }}</p>

        <p v-if="props.targets.length === 0" class="acu-notes">{{ UI.plot.copyPasteEmpty }}</p>

        <div v-for="preset in props.targets" :key="preset.name" class="acu-copypaste-preset">
          <div class="acu-copypaste-preset__name">{{ preset.name }}</div>

          <div v-if="props.kind === 'block'" class="acu-copypaste-preset__tasks">
            <button
              v-for="task in preset.tasks"
              :key="task.index"
              class="acu-copypaste-task"
              type="button"
              @click="emit('pick', preset.name, task.index)"
            >
              {{ task.name }}
            </button>
            <p v-if="preset.tasks.length === 0" class="acu-notes acu-notes--sm">{{ UI.plot.copyPasteNoTasks }}</p>
          </div>
          <button v-else class="acu-copypaste-task" type="button" @click="emit('pick', preset.name, -1)">
            {{ UI.plot.copyPasteWholePreset }}
          </button>
        </div>
      </div>

      <div class="acu-copypaste-dialog__foot">
        <button class="acu-btn acu-btn--sm" type="button" @click="emit('close')">{{ UI.plot.copyPasteCancel }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.acu-copypaste-mask {
  position: fixed;
  inset: 0;
  z-index: 32;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(20, 18, 16, 0.45);
}

.acu-copypaste-dialog {
  display: flex;
  flex-direction: column;
  width: min(560px, 92vw);
  max-height: 82vh;
  border: 1px solid var(--acu-line);
  border-radius: 12px;
  background: var(--acu-bg-1);
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.28);
  overflow: hidden;
}

.acu-copypaste-dialog__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  border-bottom: 1px solid var(--acu-line);
}

.acu-copypaste-dialog__title {
  font-size: var(--acu-font-size-body);
  font-weight: 700;
  color: var(--acu-text-1);
}

.acu-copypaste-dialog__close {
  border: none;
  background: transparent;
  color: var(--acu-text-2);
  font-size: 20px;
  line-height: 1;
  cursor: pointer;
}

.acu-copypaste-dialog__body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 12px 14px;
}

.acu-copypaste-preset {
  margin-top: 12px;
  padding: 8px 10px;
  border: 1px solid var(--acu-line);
  border-radius: 8px;
  background: var(--acu-surface-2, rgba(127, 127, 127, 0.08));
}

.acu-copypaste-preset__name {
  font-size: 13px;
  font-weight: 700;
  color: var(--acu-text-1);
  margin-bottom: 6px;
}

.acu-copypaste-preset__tasks {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.acu-copypaste-task {
  padding: 6px 10px;
  border: 1px solid var(--acu-line);
  border-radius: 6px;
  background: var(--acu-bg-1);
  color: var(--acu-text-1);
  font: inherit;
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}

.acu-copypaste-task:hover {
  border-color: var(--acu-accent);
  background: var(--acu-accent-wash);
  color: var(--acu-accent-2);
}

.acu-copypaste-dialog__foot {
  display: flex;
  justify-content: flex-end;
  padding: 10px 14px;
  border-top: 1px solid var(--acu-line);
}
</style>
