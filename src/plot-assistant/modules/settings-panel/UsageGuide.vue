<script setup lang="ts">
/**
 * 「使用说明」页。
 *
 * 用户 2026-11-06 定的结构：左侧第三栏叫「使用说明」，里面按功能区讲用法和注意事项；
 * 顶部按钮切换区域。批 46（2026-11-09）全面重写：从 3 个区扩成 6 个区
 * （快速上手 / 暂存区 / 任务与楼层 / 标签与差量更新 / 世界书写入 / 占位符），
 * 把机制讲透——暂存区的「开头十个字符」判定、差量更新里 AI 可用的全部命令、
 * 任务字段与按楼层记账的账本规则、世界书写入口径。占位符说明仍从「上下文」页挪来的那份。
 *
 * 纯展示组件：不读写设置、不发请求。全部文案在 copy.ts 的 usage 段。
 */
import { ref } from 'vue';
import { UI } from '../copy';
import { TAG_DIFF_INSTRUCTION_TEMPLATE } from '../plot/eng/tag-diff';

const tabs = [
  { key: 'start' as const, label: UI.usage.tabs.start, short: UI.usage.tabs.start },
  { key: 'stash' as const, label: UI.usage.tabs.stash, short: UI.usage.tabs.stash },
  { key: 'tasks' as const, label: UI.usage.tabs.tasks, short: UI.usage.tabs.tasks },
  { key: 'tagDiff' as const, label: UI.usage.tabs.tagDiff, short: UI.usage.tabs.tagDiff },
  { key: 'worldbook' as const, label: UI.usage.tabs.worldbook, short: UI.usage.tabs.worldbook },
  { key: 'placeholders' as const, label: UI.usage.tabs.placeholders, short: UI.usage.tabs.placeholders },
];

const active = ref<'start' | 'stash' | 'tasks' | 'tagDiff' | 'worldbook' | 'placeholders'>('start');
</script>

<template>
  <div class="rh-usage">
    <p class="acu-notes">{{ UI.usage.intro }}</p>

    <div class="acu-page-tabs">
      <button
        v-for="tab in tabs"
        :key="tab.key"
        type="button"
        class="acu-page-tab"
        :class="{ active: active === tab.key }"
        @click="active = tab.key"
      >
        <span class="acu-page-tab__full">{{ tab.label }}</span>
        <span class="acu-page-tab__short">{{ tab.short }}</span>
      </button>
    </div>

    <!-- ① 快速上手 -->
    <div v-show="active === 'start'" class="acu-page">
      <div class="acu-section">
        <h4>{{ UI.usage.startTitle }}</h4>
        <p class="acu-notes">{{ UI.usage.startIntro }}</p>
        <ul class="rh-usage-list">
          <li v-for="line in UI.usage.startPoints" :key="line">{{ line }}</li>
        </ul>
      </div>
    </div>

    <!-- ② 暂存区 -->
    <div v-show="active === 'stash'" class="acu-page">
      <div class="acu-section">
        <h4>{{ UI.usage.stashTitle }}</h4>
        <p class="acu-notes">{{ UI.usage.stashIntro }}</p>
        <ul class="rh-usage-list">
          <li v-for="line in UI.usage.stashPoints" :key="line">{{ line }}</li>
        </ul>

        <p class="rh-usage-sub"><strong>{{ UI.usage.stashMatchTitle }}</strong></p>
        <p class="acu-notes">{{ UI.usage.stashMatchIntro }}</p>
        <div class="rh-usage-modes">
          <div v-for="rule in UI.usage.stashMatchRules" :key="rule.input" class="rh-usage-mode">
            <strong>{{ rule.input }}</strong>
            <span>{{ rule.result }}</span>
          </div>
        </div>
        <p class="acu-notes">{{ UI.usage.stashMatchNote }}</p>
      </div>
    </div>

    <!-- ③ 任务与楼层 -->
    <div v-show="active === 'tasks'" class="acu-page">
      <div class="acu-section">
        <h4>{{ UI.usage.tasksTitle }}</h4>
        <p class="acu-notes">{{ UI.usage.tasksIntro }}</p>
        <div class="rh-usage-modes">
          <div v-for="field in UI.usage.taskFields" :key="field.name" class="rh-usage-mode">
            <strong>{{ field.name }}</strong>
            <span>{{ field.desc }}</span>
          </div>
        </div>
        <ul class="rh-usage-list">
          <li v-for="line in UI.usage.taskPoints" :key="line">{{ line }}</li>
        </ul>
      </div>
    </div>

    <!-- ④ 标签与差量更新 -->
    <div v-show="active === 'tagDiff'" class="acu-page">
      <div class="acu-section">
        <h4>{{ UI.usage.tagDiffTitle }}</h4>
        <p class="acu-notes">{{ UI.usage.tagDiffIntro }}</p>
        <div class="rh-usage-modes">
          <div v-for="mode in UI.usage.tagDiffModes" :key="mode.name" class="rh-usage-mode">
            <strong>{{ mode.name }}</strong>
            <span>{{ mode.desc }}</span>
          </div>
        </div>

        <p class="rh-usage-sub"><strong>{{ UI.usage.tagDiffAutoTitle }}</strong></p>
        <p class="acu-notes">{{ UI.usage.tagDiffAutoIntro }}</p>
        <p class="acu-notes">{{ UI.usage.tagDiffAutoTemplateNote }}</p>
        <pre class="rh-usage-prompt">{{ TAG_DIFF_INSTRUCTION_TEMPLATE }}</pre>

        <p class="rh-usage-sub"><strong>{{ UI.usage.tagDiffCommandsTitle }}</strong></p>
        <div class="rh-usage-modes">
          <div v-for="cmd in UI.usage.tagDiffCommands" :key="cmd.syntax" class="rh-usage-mode">
            <strong>{{ cmd.syntax }}</strong>
            <span>〔{{ cmd.where }}〕{{ cmd.effect }}</span>
          </div>
        </div>

        <ul class="rh-usage-list">
          <li v-for="line in UI.usage.tagDiffPoints" :key="line">{{ line }}</li>
        </ul>
      </div>
    </div>

    <!-- ⑤ 世界书写入 -->
    <div v-show="active === 'worldbook'" class="acu-page">
      <div class="acu-section">
        <h4>{{ UI.usage.worldbookTitle }}</h4>
        <p class="acu-notes">{{ UI.usage.worldbookIntro }}</p>
        <ul class="rh-usage-list">
          <li v-for="line in UI.usage.worldbookPoints" :key="line">{{ line }}</li>
        </ul>
      </div>
    </div>

    <!-- ⑥ 占位符 -->
    <div v-show="active === 'placeholders'" class="acu-page">
      <div class="acu-section">
        <h4>{{ UI.usage.placeholderTitle }}</h4>
        <div class="acu-placeholder-legend">
          <div v-for="item in UI.plot.placeholderLegend" :key="item.code" class="acu-placeholder-item">
            <code>{{ item.code }}</code> — {{ item.desc }}
          </div>
        </div>
        <p class="acu-notes">{{ UI.plot.placeholderHint }}</p>
        <p class="acu-notes">{{ UI.usage.placeholderNote }}</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.rh-usage {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.rh-usage-list {
  margin: 8px 0 0 18px;
  padding: 0;
  line-height: 1.8;
  color: var(--acu-text-2);
}

.rh-usage-modes {
  margin-top: 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.rh-usage-mode {
  display: flex;
  gap: 10px;
  line-height: 1.7;
}

.rh-usage-mode strong {
  flex: 0 0 auto;
  color: var(--acu-text-1);
}

.rh-usage-mode span {
  color: var(--acu-text-2);
}

/* 分区小标题：说明页一区里再分「机制判定 / 命令清单」这类小块时用 */
.rh-usage-sub {
  margin: 14px 0 0;
  font-size: var(--acu-font-size-body);
  color: var(--acu-text-1);
}

/* 自动注入的规则模板：原样展示给创作者，保留换行与缩进 */
.rh-usage-prompt {
  margin: 8px 0 0;
  padding: 10px 12px;
  white-space: pre-wrap;
  word-break: break-word;
  line-height: 1.7;
  font-size: calc(var(--acu-font-size-body) - 1px);
  color: var(--acu-text-2);
  background: var(--acu-bg-2, rgba(0, 0, 0, 0.04));
  border: 1px solid var(--acu-border, rgba(0, 0, 0, 0.1));
  border-radius: 6px;
}
</style>
