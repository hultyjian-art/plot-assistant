<script setup lang="ts">
/**
 * 预设工具栏：**一排动作按钮**，挨着预设下拉框放，照工作流助手的「任务预设」区那个样子。
 *
 * 为什么不再是一整块「导入/导出」小节放在页面末尾：预设是你正在编辑的那个东西，
 * 存、导、删应该贴着你正在看的下拉框，而不是要滚到页面最底下再找。
 *
 * 只负责界面动作，全都不碰数据 —— 合进本地库、校验、改名都归外层（要动 `draft.presets`，
 * 还得顺手改选中项，那是页面的事）。
 *
 * 导出格式**必须和数据库脚本一致**（一个 JSON 数组包着预设对象，`JSON.stringify([data], null, 2)`），
 * 否则拿这份文件去 ACU 导入它会不吃。
 */
import { ref } from 'vue';
import { UI } from '../copy';
import { parsePresetJson } from '../plot/preset-edit';

const props = defineProps<{
  /** 当前选中的预设名（决定导出文件名）。 */
  current: string;
  /** 能不能导出（没选本地预设时不能）。 */
  canExport: boolean;
  /** 能不能删除（选中的是本地预设时才能）。 */
  canDelete: boolean;
  /** 当前预设序列化后的导出文本（外层算，因为要读预设本体）。 */
  exportText: string;
  /** 导出文件名。 */
  exportName: string;
}>();

const emit = defineEmits<{
  (event: 'import', payload: { presets: Record<string, unknown>[]; skipped: number }): void;
  (event: 'create'): void;
  (event: 'duplicate'): void;
  (event: 'remove'): void;
  (event: 'refresh'): void;
}>();

const note = ref('');
const fileInput = ref<HTMLInputElement | null>(null);

function importFromFile(event: Event): void {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = () => {
    const raw = typeof reader.result === 'string' ? reader.result : '';
    const outcome = parsePresetJson(raw);
    if (!outcome.ok) {
      note.value = UI.plot.ioFailed(outcome.error);
    } else {
      note.value = '';
      emit('import', { presets: outcome.presets, skipped: outcome.skipped });
    }
    // 清空 value：同一个文件改完再导一次时，不清空不会触发 change
    input.value = '';
  };
  reader.onerror = () => {
    note.value = UI.plot.ioFailed('读不了这个文件');
    input.value = '';
  };
  reader.readAsText(file);
}

function download(): void {
  if (props.exportText === '') return;
  const blob = new Blob([props.exportText], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = props.exportName;
  link.click();
  // 立刻回收：等下一次事件循环时下载已经开始了
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
</script>

<template>
  <div class="acu-preset-actions">
    <button class="acu-btn acu-btn--sm" type="button" :title="UI.plot.ioImportFileHint" @click="fileInput?.click()">
      {{ UI.plot.ioImportFile }}
    </button>
    <input ref="fileInput" type="file" accept=".json,application/json" class="rh-hidden-file" @change="importFromFile" />

    <button
      class="acu-btn acu-btn--sm"
      type="button"
      :title="UI.plot.ioExportHint"
      :disabled="!props.canExport"
      @click="download"
    >
      {{ UI.plot.ioExport }}
    </button>

    <button class="acu-btn acu-btn--sm" type="button" :title="UI.plot.presetActionNewHint" @click="emit('create')">
      {{ UI.plot.presetActionNew }}
    </button>
    <button class="acu-btn acu-btn--sm" type="button" :title="UI.plot.presetActionDuplicateHint" :disabled="!props.canExport" @click="emit('duplicate')">
      {{ UI.plot.presetActionDuplicate }}
    </button>
    <button class="acu-btn danger acu-btn--sm" type="button" :title="UI.plot.presetActionDeleteHint" :disabled="!props.canDelete" @click="emit('remove')">
      {{ UI.plot.presetActionDelete }}
    </button>
    <button class="acu-btn acu-btn--sm" type="button" :title="UI.plot.presetRefreshHint" @click="emit('refresh')">
      {{ UI.plot.presetRefresh }}
    </button>

    <span v-if="note !== ''" class="acu-notes acu-notes--sm" style="margin: 0">{{ note }}</span>
  </div>
</template>
