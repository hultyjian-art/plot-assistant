<script setup lang="ts">
/**
 * 运行日志面板。
 *
 * 版式照工作流助手（用户 2026-11-04 明确要求「全面向工作流助手看齐」）：
 *
 *   顶部   一轮里每个任务一个标签，标签上带状态和回传首行 —— 用来速查「这次返回了什么」
 *   中部   以提示词块为单位折叠，展示**发给 AI 的内容**（一块一条，标题是块名 + 角色）
 *   底部   块内是 AI 原始回传（默认折叠）
 *   最下方 AI 推理内容（默认折叠）
 *
 * 只读：这里没有任何写盘路径。日志由 `plot/log-flow.ts` 在推进时写，
 * 面板要是也能写，万一两边口径不一致就会互相覆盖。
 */
import { computed, onMounted, ref } from 'vue';
import { UI } from '../copy';
import { readPanelLog } from '../plot/log-state';
import {
  toMarkdown,
  type LogPromptMessage,
  type LogRound,
  type LogRoundStatus,
  type LogTaskEntry,
  type PlotRunLog,
} from '../plot/log-model';

const t = UI.plot;

const log = ref<PlotRunLog | null>(null);
const warning = ref<string | null>(null);
const notice = ref('');
/** 每轮选中的标签：楼层号 → 任务键 */
const activeTab = ref<Record<number, string>>({});

const rounds = computed<LogRound[]>(() => {
  const list = log.value ? log.value.rounds : [];
  // 新的在上面：用户点开面板想看的是「刚才那轮为什么慢」
  return [...list].sort((a, b) => b.startedAt - a.startedAt || b.floorId - a.floorId);
});

function reload(): void {
  try {
    const loaded = readPanelLog();
    log.value = loaded.log;
    warning.value = loaded.warning;
  } catch (error) {
    console.error('[剧情推进助手] 读运行日志失败', error);
    log.value = null;
    warning.value = String((error as Error)?.message ?? error);
  }
}

onMounted(reload);

function statusText(status: LogRoundStatus): string {
  if (status === 'ok') return t.logStatusOk;
  if (status === 'partial') return t.logStatusPartial;
  if (status === 'running') return t.logStatusRunning;
  return t.logStatusFailed;
}

function statusClass(status: LogRoundStatus): string {
  return `acu-log-status acu-log-status--${status}`;
}

/** 同一轮里按「阶段 → 序号 → 第几次」排：重试的那几次挨在一起，顺序稳定就好。 */
function sortTasks(tasks: LogTaskEntry[]): LogTaskEntry[] {
  return [...tasks].sort((a, b) => a.stage - b.stage || a.order - b.order || a.attempt - b.attempt);
}

function keyOf(round: LogRound, task: LogTaskEntry): string {
  return `${round.floorId}:${task.taskId}:${task.attempt}`;
}

function markOf(task: LogTaskEntry): string {
  return task.status === 'ok' ? '✓' : task.status === 'skipped' ? '⤼' : '✕';
}

/** 标签上的一行摘要：回传的第一行，太长就截断 —— 这就是「速查返回结果」。 */
function snippetOf(task: LogTaskEntry): string {
  const raw = (task.rawResponse || '').trim();
  if (!raw) return task.error ? t.logStatusFailed : '';
  return snippetText(raw);
}

/** 一段文本压成一行摘要（推理内容与回传都用它）。 */
function snippetText(text: string): string {
  const raw = String(text || '').trim();
  if (!raw) return '';
  const line = raw.split('\n').find(item => item.trim()) ?? raw;
  const flat = line.trim();
  return flat.length > 22 ? `${flat.slice(0, 22)}…` : flat;
}

/**
 * 老记录没有 `promptMessages`，只有一整段 `promptPreview`（格式是 `【role】\n内容`，空行分隔）。
 * 这里按同样的形状拆回块，免得「升级前跑的那几轮」在面板上变成一坨。
 */
function parsePromptPreview(text: string): LogPromptMessage[] {
  const source = typeof text === 'string' ? text : '';
  if (source.trim() === '') return [];
  const blocks: LogPromptMessage[] = [];
  const parts = source.split(/\n\n(?=【[^】\n]+】\n)/);
  for (const part of parts) {
    const matched = /^【([^】\n]+)】\n([\s\S]*)$/.exec(part);
    if (!matched) continue;
    blocks.push({ role: matched[1], name: '', content: matched[2] });
  }
  return blocks.length > 0 ? blocks : [{ role: '', name: '', content: source }];
}

function blocksOf(task: LogTaskEntry | null): LogPromptMessage[] {
  if (!task) return [];
  const stored = Array.isArray(task.promptMessages) ? task.promptMessages : [];
  return stored.length > 0 ? stored : parsePromptPreview(task.promptPreview);
}

function blockTitle(block: LogPromptMessage): string {
  return t.logBlockTitle(block.role, block.name);
}

function blockSize(block: LogPromptMessage): string {
  return t.logBlockSize(block.content.length);
}

function selectTask(round: LogRound, task: LogTaskEntry): void {
  activeTab.value = { ...activeTab.value, [round.floorId]: keyOf(round, task) };
}

/** 一轮渲染成：任务列表 + 当前选中的那条。选中项失效（比如刷新后换了记录）时退回第一条。 */
const views = computed(() =>
  rounds.value.map(round => {
    const tasks = sortTasks(round.tasks);
    const wanted = activeTab.value[round.floorId] ?? '';
    const current = tasks.find(task => keyOf(round, task) === wanted) ?? tasks[0] ?? null;
    return { round, tasks, current, key: round.floorId };
  }),
);

function stamp(ms: number): string {
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function download(md: string): void {
  const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'plot-log.md';
  link.click();
  URL.revokeObjectURL(url);
}

/**
 * 导出：优先塞剪贴板（用户拿到就能直接粘进对话），不行才退回下载。
 * 剪贴板在 iframe 里可能被权限挡掉，所以两条路都得有，不能只写一条。
 */
async function exportMd(): Promise<void> {
  if (!log.value) return;
  const md = toMarkdown(log.value);
  try {
    await navigator.clipboard.writeText(md);
    notice.value = t.logExportOk;
  } catch (error) {
    console.warn('[剧情推进助手] 剪贴板不可用，改成下载', error);
    download(md);
    notice.value = t.logExportFallback;
  }
  window.setTimeout(() => {
    notice.value = '';
  }, 3000);
}
</script>

<template>
  <div class="acu-section">
    <div class="acu-row acu-row--between">
      <span class="acu-section__title">{{ t.logTitle }}</span>
      <div class="acu-log-actions">
        <button class="acu-btn acu-btn--sm" type="button" @click="reload">{{ t.logRefresh }}</button>
        <button class="acu-btn acu-btn--sm" type="button" :disabled="rounds.length === 0" @click="exportMd">
          {{ t.logExport }}
        </button>
      </div>
    </div>
    <p class="acu-notes">{{ t.logHint }}</p>
    <p v-if="notice" class="acu-notes acu-notes--ok">{{ notice }}</p>
    <p v-if="warning" class="acu-notes acu-notes--warn">{{ t.logUnreadable }}</p>
    <p v-if="rounds.length === 0" class="acu-notes">{{ t.logEmpty }}</p>

    <div v-for="view in views" :key="view.key" class="acu-log-round">
      <div class="acu-log-round__head">
        <span class="acu-log-round__title">{{ t.logRound(view.round.floorId) }}</span>
        <span :class="statusClass(view.round.status)">{{ statusText(view.round.status) }}</span>
      </div>
      <div class="acu-log-round__meta">
        {{ t.logRoundMeta(view.round.presetName || '—', stamp(view.round.startedAt), view.round.tasks.length) }}
      </div>
      <p v-if="view.round.error" class="acu-notes acu-notes--error">{{ t.logRoundError(view.round.error) }}</p>

      <p v-if="view.tasks.length === 0" class="acu-notes acu-notes--sm">{{ t.logTabEmpty }}</p>

      <template v-else>
        <!-- 顶部标签：一条任务一个，带状态与回传首行，用来速查 -->
        <div class="acu-log-tabs" role="tablist">
          <button
            v-for="task in view.tasks"
            :key="keyOf(view.round, task)"
            type="button"
            role="tab"
            class="acu-log-tab"
            :class="{ 'is-active': view.current !== null && keyOf(view.round, view.current) === keyOf(view.round, task) }"
            :aria-selected="view.current !== null && keyOf(view.round, view.current) === keyOf(view.round, task)"
            @click="selectTask(view.round, task)"
          >
            <span class="acu-log-tab__mark" :class="task.status === 'ok' ? 'is-ok' : 'is-failed'">{{ markOf(task) }}</span>
            <span class="acu-log-tab__name">{{ task.taskName || task.taskId }}</span>
            <span class="acu-log-tab__snippet">{{ snippetOf(task) }}</span>
          </button>
        </div>
        <p class="acu-notes acu-notes--sm">{{ t.logTabsHint }}</p>

        <div v-if="view.current !== null" class="acu-log-panel">
          <p class="acu-notes acu-notes--sm">
            {{ t.logTaskLine(view.current.stage, view.current.attempt, view.current.durationMs) }}
          </p>
          <p v-if="view.current.error" class="acu-notes acu-notes--error">
            {{ t.logErrorLabel }}：{{ view.current.error }}
          </p>
          <p class="acu-notes acu-notes--sm">
            {{ t.logTagsLabel }}：{{ view.current.tags.length ? view.current.tags.join('、') : t.logNoTags }}
          </p>

          <!-- 中部：以提示词块为单位折叠，展示发给 AI 的内容 -->
          <h5 class="acu-log-panel__title">{{ t.logSentLabel }}</h5>
          <p class="acu-notes acu-notes--sm">{{ t.logSentHint }}</p>
          <details v-for="(block, index) in blocksOf(view.current)" :key="index" class="acu-log-block">
            <summary class="acu-log-block__summary">
              <span class="acu-log-block__title">{{ blockTitle(block) }}</span>
              <span class="acu-log-block__size">{{ blockSize(block) }}</span>
            </summary>
            <pre class="acu-log-block__pre">{{ block.content }}</pre>
          </details>

          <!-- 底部：AI 原始回传（默认折叠） -->
          <details class="acu-log-block">
            <summary class="acu-log-block__summary">
              <span class="acu-log-block__title">{{ t.logRawLabel }}</span>
              <span class="acu-log-block__size">{{ view.current.rawResponse ? snippetOf(view.current) : t.logNoRaw }}</span>
            </summary>
            <pre class="acu-log-block__pre">{{ view.current.rawResponse || t.logNoRaw }}</pre>
          </details>

          <!-- 最下方：AI 推理内容（默认折叠）。走酒馆助手 4.11.1+ 的 should_return_reasoning，
               老记录没有这个字段，如实显示「没拿到」而不是假装有。 -->
          <details class="acu-log-block">
            <summary class="acu-log-block__summary">
              <span class="acu-log-block__title">{{ t.logReasoningLabel }}</span>
              <span class="acu-log-block__size">{{ view.current.reasoning ? snippetText(view.current.reasoning) : t.logNoReasoning }}</span>
            </summary>
            <pre v-if="view.current.reasoning" class="acu-log-block__pre">{{ view.current.reasoning }}</pre>
            <p v-else class="acu-notes acu-notes--sm">{{ t.logReasoningEmpty }}</p>
          </details>
        </div>
      </template>
    </div>
  </div>
</template>
