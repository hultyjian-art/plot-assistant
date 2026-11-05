<script setup lang="ts">
/**
 * 「上下文」页：`$7 默认上下文`（最近 N 条 AI 楼层 + 提取/排除规则）+ 占位符说明 + 世界书预留位。
 *
 * 版式照 ACU 剧情推进页与工作流助手的「世界书与上下文」页：一节一个 `<h4>`，
 * 占位符用一张 legend 逐个列出来（照规矩：**说明写在界面上**，别让人去翻源码）。
 *
 * 两件必须说清的事：
 *  1. 占位符表抄的是 **ACU**，不是工作流助手 —— 两边 `$6` 的语义是反的
 *     （ACU `$6` = 上一轮剧情推进的输出；工作流助手 `$6` = 记忆回溯）。
 *  2. 工作流助手的 `$2`（托管条目 `WorkflowHelper-*`）在我们这里**不存在**：
 *     那是它「世界书写入规则」自己往世界书里写、下一轮再读回来的那批条目，我们没这个功能。
 *
 * 只改传进来的草稿，写回由外层负责。
 */
import { UI } from '../copy';
import type { PresetRuleDraft } from '../plot/preset-edit';

/**
 * 三样东西分开传，不吞一整份 `PresetDraft`。
 *
 * 为什么：这三样在**预设里**和**全局兜底里**各有一份（没选预设时改的是全局那份），
 * 传整份草稿就等于把「改哪儿」焊死成预设，没预设时这一块只能整个不显示 ——
 * 那正是用户抱怨的「没导入预设就只剩一个标题」。拆开之后外层想给哪一份就给哪一份。
 */
const props = defineProps<{
  /** `$7` 抓最近几条 AI 楼层 */
  turnCount: number;
  extractRules: PresetRuleDraft[];
  excludeRules: PresetRuleDraft[];
}>();

/** 条数要写回某一侧（预设或全局），所以走 emit 而不是原地改。 */
const emit = defineEmits<{ 'update:turnCount': [number] }>();

function addRule(list: PresetRuleDraft[]): void {
  list.push({ start: '', end: '' });
}

function dropRule(list: PresetRuleDraft[], index: number): void {
  list.splice(index, 1);
}

/**
 * 一条规则收起来时显示什么。
 *
 * 照工作流助手的样子：每条规则只占一行、默认收起，点开才填起止。
 * 一排展开的输入框在手机上会把整页撑长，找下面的东西要滑半天。
 */
function ruleTitle(rule: PresetRuleDraft): string {
  const start = String(rule.start ?? '').trim();
  const end = String(rule.end ?? '').trim();
  if (start === '' && end === '') return UI.plot.editorRuleRowEmpty;
  if (start !== '' && end !== '') return `${start} → ${end}`;
  return start !== '' ? start : end;
}
</script>

<template>
  <div class="acu-section">
    <h4>{{ UI.plot.contextTitle }}</h4>
    <p class="acu-notes">{{ UI.plot.contextHint }}</p>
    <div class="acu-row">
      <label class="rh-field-label">{{ UI.plot.editorTurn }}</label>
      <input
        class="acu-input"
        type="number"
        min="0"
        style="width: 88px"
        :value="props.turnCount"
        @input="emit('update:turnCount', Math.max(0, Number(($event.target as HTMLInputElement).value) || 0))"
      />
      <span class="acu-notes acu-notes--sm" style="margin: 0">{{ UI.plot.editorTurnHint }}</span>
    </div>
  </div>

  <div class="acu-section">
    <h4>{{ UI.plot.editorExtractRules }}</h4>
    <p class="acu-notes">{{ UI.plot.editorRuleHint }}</p>
    <p v-if="props.extractRules.length === 0" class="acu-notes">{{ UI.plot.editorRulesEmpty }}</p>
    <details v-for="(rule, index) in props.extractRules" :key="`extract-${index}`" class="acu-rule">
      <summary class="acu-rule__summary">
        <span class="acu-rule__title">{{ ruleTitle(rule) }}</span>
        <button class="acu-btn danger acu-btn--sm" type="button" :title="UI.plot.editorRuleDrop" @click.prevent.stop="dropRule(props.extractRules, index)">
          ✕
        </button>
      </summary>
      <div class="acu-row acu-row--inline">
        <input v-model="rule.start" class="acu-input" type="text" :placeholder="UI.plot.editorRuleStart" style="flex: 1 1 0; min-width: 0" />
        <span class="acu-notes acu-notes--sm" style="margin: 0">→</span>
        <input v-model="rule.end" class="acu-input" type="text" :placeholder="UI.plot.editorRuleEnd" style="flex: 1 1 0; min-width: 0" />
      </div>
    </details>
    <div class="acu-row">
      <button class="acu-btn acu-btn--sm" type="button" @click="addRule(props.extractRules)">{{ UI.plot.editorRuleAdd }}</button>
    </div>
  </div>

  <div class="acu-section">
    <h4>{{ UI.plot.editorExcludeRules }}</h4>
    <p v-if="props.excludeRules.length === 0" class="acu-notes">{{ UI.plot.editorRulesEmpty }}</p>
    <details v-for="(rule, index) in props.excludeRules" :key="`exclude-${index}`" class="acu-rule">
      <summary class="acu-rule__summary">
        <span class="acu-rule__title">{{ ruleTitle(rule) }}</span>
        <button class="acu-btn danger acu-btn--sm" type="button" :title="UI.plot.editorRuleDrop" @click.prevent.stop="dropRule(props.excludeRules, index)">
          ✕
        </button>
      </summary>
      <div class="acu-row acu-row--inline">
        <input v-model="rule.start" class="acu-input" type="text" :placeholder="UI.plot.editorRuleStart" style="flex: 1 1 0; min-width: 0" />
        <span class="acu-notes acu-notes--sm" style="margin: 0">→</span>
        <input v-model="rule.end" class="acu-input" type="text" :placeholder="UI.plot.editorRuleEnd" style="flex: 1 1 0; min-width: 0" />
      </div>
    </details>
    <div class="acu-row">
      <button class="acu-btn acu-btn--sm" type="button" @click="addRule(props.excludeRules)">{{ UI.plot.editorRuleAdd }}</button>
    </div>
  </div>

  <div class="acu-section">
    <h4>{{ UI.plot.placeholderTitle }}</h4>
    <div class="acu-placeholder-legend">
      <div v-for="item in UI.plot.placeholderLegend" :key="item.code" class="acu-placeholder-item">
        <code>{{ item.code }}</code> — {{ item.desc }}
      </div>
    </div>
    <p class="acu-notes">{{ UI.plot.placeholderHint }}</p>
  </div>

</template>

<style scoped>
.acu-rule {
  border: 1px solid var(--acu-border);
  border-radius: 6px;
  padding: 4px 8px;
  margin-bottom: 6px;
  background: var(--acu-bg-1);
}

.acu-rule__summary {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  list-style: none;
  font-size: 12px;
}

.acu-rule__summary::-webkit-details-marker {
  display: none;
}

.acu-rule__title {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
