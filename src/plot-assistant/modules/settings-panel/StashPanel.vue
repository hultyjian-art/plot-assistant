<script setup lang="ts">
/**
 * 暂存区面板：把所有已经落盘的推进成果按楼层列出来，点开一版能看、能改、能按标签删。
 *
 * 只读不写的边界：这里**只碰**聊天变量里的 `reroll_plot_stash`，不写楼层的 qrf，
 * 也不碰 ACU 的任何键。楼层上的那一份是引擎在发送后补写的，两边各管各的。
 *
 * 「保存才生效」是硬要求（用户 2026-11-02 明确）：所有改动都先落在本地草稿里，
 * 点「保存」才写回聊天变量；改了没保存就点叉，必须再问一次。
 */
import { computed, onMounted, ref } from 'vue';
import { UI } from '../copy';
import { editLanding, listEntries, removeLanding } from '../plot/stash-flow';
import { landingGap, landingSeqOf, setActiveLanding, type LandingGap } from '../plot/stash-model';
import { readPanelStash, savePanelStash } from '../plot/stash-state';
import { blockPreview, removeTagBlocks, scanTagBlocks } from '../plot/stash-edit';
import { landingInFloor } from '../plot/stash-apply';
import { applyLandingToFloorMessage, putLandingIntoInputBox, readFloorText } from '../plot/stash-apply-io';
import type { Stash, StashEntry, StashLanding } from '../plot/stash-model';

const t = UI.plot;

const stash = ref<Stash | null>(null);
const warning = ref<string | null>(null);
const notice = ref('');
/**
 * 每一层现在真正的正文。判断「哪一版在使用中」只认它，不认账本里的 `activeLandingId`——
 * 楼层里躺着什么才是用户会读到的内容。
 */
const floorTexts = ref<Record<number, string | null>>({});

const entries = computed<StashEntry[]>(() => (stash.value ? listEntries(stash.value) : []));

/** 重新读聊天变量 + 每层正文。面板每次打开、点刷新、保存之后都走它。 */
function reload(): void {
  try {
    const loaded = readPanelStash();
    stash.value = loaded.stash;
    warning.value = loaded.warning;
    readFloorTexts(loaded.stash);
  } catch (error) {
    console.error('[剧情推进助手] 读暂存失败', error);
    stash.value = null;
    warning.value = 'stash_unreadable';
  }
}

/** 把每层的正文读一遍；读不到（楼层被删了）记 null。 */
function readFloorTexts(source: Stash): void {
  const next: Record<number, string | null> = {};
  for (const entry of source.entries) {
    try {
      next[entry.floorId] = readFloorText(entry.floorId);
    } catch (error) {
      console.warn('[剧情推进助手] 读楼层正文失败', entry.floorId, error);
      next[entry.floorId] = null;
    }
  }
  floorTexts.value = next;
}

/** 这一版是不是正写在楼层里（面板上标「使用中」）。 */
function inUse(entry: StashEntry, landing: StashLanding): boolean {
  if (!landingInFloor(floorTexts.value[entry.floorId] ?? null, landing.finalText)) return false;
  // 两版内容可能一字不差（同一轮重跑、或用户把两版改成一样）。这时两版都"在楼层里"，
  // 但真正被标成「使用中」的只能有一个 —— 否则用户会以为两版同时在生效。
  const twins = entry.landings.filter(item => landingInFloor(floorTexts.value[entry.floorId] ?? null, item.finalText));
  if (twins.length <= 1) return true;
  return landing.id === entry.activeLandingId || twins[twins.length - 1].id === landing.id;
}

onMounted(reload);

// ── 弹层状态 ──
const openFloorId = ref<number | null>(null);
const openLandingId = ref<string | null>(null);
const draftText = ref('');
const savedText = ref('');
const askDiscard = ref(false);
const askDelete = ref(false);
const busy = ref(false);
const saveError = ref('');

const currentEntry = computed<StashEntry | null>(() => {
  if (openFloorId.value === null || !stash.value) return null;
  return stash.value.entries.find((item) => item.floorId === openFloorId.value) ?? null;
});

const currentLanding = computed<StashLanding | null>(() => {
  const entry = currentEntry.value;
  if (!entry || !openLandingId.value) return null;
  return entry.landings.find((item) => item.id === openLandingId.value) ?? null;
});

/** 正在看的这一版是第几号（1、2……），标题上用。 */
const currentSeq = computed<number | null>(() => {
  const entry = currentEntry.value;
  if (!entry || !openLandingId.value) return null;
  const index = entry.landings.findIndex((item) => item.id === openLandingId.value);
  if (index < 0) return null;
  return landingSeqOf(entry.landings[index], index);
});

/** 正在看的这一版是不是楼层里正在用的那条。 */
const currentInUse = computed<boolean>(() => {
  const entry = currentEntry.value;
  const landing = currentLanding.value;
  return Boolean(entry && landing && inUse(entry, landing));
});

const dirty = computed(() => draftText.value !== savedText.value);
/** 每一块的「名字 + 一句话预览」，按正文里出现的顺序。 */
const tagRows = computed<{ name: string; preview: string }[]>(() =>
  scanTagBlocks(draftText.value).map((block) => ({ name: block.tag, preview: blockPreview(block, 60) })),
);
/**
 * 这一版现在缺了哪些标签。
 *
 * 删标签块不拦着 —— 用户要的就是自由编辑。但后果得让人看见：
 * 缺的那部分会在下次拿这一版生成楼层时，自动重跑产出它的任务补回来。
 */
const gap = computed<LandingGap>(() => {
  const landing = currentLanding.value;
  if (!landing) return { tags: [], taskIds: [] };
  return landingGap(landing, tagRows.value.map((row) => row.name));
});
const viewerOpen = computed(() => openFloorId.value !== null && openLandingId.value !== null);

function openViewer(entry: StashEntry, landing: StashLanding): void {
  openFloorId.value = entry.floorId;
  openLandingId.value = landing.id;
  draftText.value = landing.finalText;
  savedText.value = landing.finalText;
  askDiscard.value = false;
  askDelete.value = false;
  saveError.value = '';
  notice.value = '';
}

function resetViewer(): void {
  openFloorId.value = null;
  openLandingId.value = null;
  draftText.value = '';
  savedText.value = '';
  askDiscard.value = false;
  askDelete.value = false;
  saveError.value = '';
}

/** 点叉：有没保存的改动就先问，没有就直接关。 */
function requestClose(): void {
  if (dirty.value) {
    askDiscard.value = true;
    return;
  }
  resetViewer();
}

function discardAndClose(): void {
  resetViewer();
}

/** 一条提示显示 2.5 秒，除非期间被别的提示顶掉。 */
function flash(text: string): void {
  notice.value = text;
  window.setTimeout(() => {
    if (notice.value === text) notice.value = '';
  }, 2500);
}

/**
 * 保存改动。
 *
 * 用户 2026-11-03 的要求：改的是**正在使用**的那一版时，楼层正文也要跟着变。
 * 不跟的话，面板上改得再对，酒馆 AI 读到的还是旧的那段 —— 两边各说各话。
 * 改的是没在用的那一版就只落账本，楼层一个字不动（保存才生效，不能偷偷改楼层）。
 */
async function save(): Promise<void> {
  const entry = currentEntry.value;
  const landing = currentLanding.value;
  if (!entry || !landing || !stash.value || busy.value) return;
  const wasInUse = inUse(entry, landing);
  try {
    const next = editLanding({
      stash: stash.value,
      floorId: entry.floorId,
      landingId: landing.id,
      finalText: draftText.value,
      now: Date.now(),
    });
    if (!next) {
      saveError.value = '这一版已经不在账本里了（可能被挤掉了），刷新一下再看。';
      return;
    }
    savePanelStash(next.stash);
    stash.value = next.stash;
    savedText.value = draftText.value;
    saveError.value = '';
    if (!wasInUse) {
      flash(t.stashSaved);
      return;
    }
    busy.value = true;
    const result = await applyLandingToFloorMessage(entry.floorId, draftText.value);
    busy.value = false;
    if (!result.ok) {
      saveError.value = result.reason || t.stashApplyFailed;
      return;
    }
    readFloorTexts(stash.value);
    flash(t.stashSavedSynced(entry.floorId));
  } catch (error) {
    busy.value = false;
    console.error('[剧情推进助手] 保存暂存失败', error);
    saveError.value = String((error as Error)?.message ?? error);
  }
}

function dropTag(tag: string): void {
  const result = removeTagBlocks(draftText.value, tag);
  if (result.removed === 0) {
    notice.value = t.stashTagMissing(tag);
    return;
  }
  draftText.value = result.text;
  notice.value = t.stashTagRemoved(tag);
}

/**
 * 把这一版写回楼层正文。
 *
 * 用存下来的 `finalText`（不是正在编辑的草稿）：草稿没点保存就不该影响楼层，
 * 否则「保存才生效」这条就漏了个后门。所以按钮在有未保存改动时是灰的。
 */
async function applyToFloor(): Promise<void> {
  const entry = currentEntry.value;
  const landing = currentLanding.value;
  if (!entry || !landing || busy.value || !stash.value) return;
  busy.value = true;
  try {
    const result = await applyLandingToFloorMessage(entry.floorId, landing.finalText);
    if (!result.ok) {
      saveError.value = result.reason || t.stashApplyFailed;
      return;
    }
    // 楼层现在用的就是这一版：账本里的「当前使用」也跟上，免得两处各说各话。
    const marked = setActiveLanding(entry, landing.id);
    const nextStash: Stash = {
      ...stash.value,
      entries: stash.value.entries.map((item) => (item.floorId === entry.floorId ? marked : item)),
    };
    savePanelStash(nextStash);
    stash.value = nextStash;
    readFloorTexts(nextStash);
    saveError.value = '';
    flash(t.stashApplied);
  } catch (error) {
    console.error('[剧情推进助手] 写入楼层失败', error);
    saveError.value = String((error as Error)?.message ?? error);
  } finally {
    busy.value = false;
  }
}

/** 把「用户原话 + 这一版」放回输入框，让用户自己按发送（不替用户发送）。 */
function rerunText(): void {
  const entry = currentEntry.value;
  const landing = currentLanding.value;
  if (!entry || !landing) return;
  const result = putLandingIntoInputBox(entry.floorText, landing.finalText);
  if (!result.ok) {
    saveError.value = result.reason || t.stashRerunFailed;
    return;
  }
  saveError.value = '';
  flash(t.stashRerunOk);
}

/** 删这一版：先问一次，删完如果这条账一版都不剩，整条卡片就没了。 */
function requestRemove(): void {
  askDelete.value = true;
}

function confirmRemove(): void {
  const entry = currentEntry.value;
  const landing = currentLanding.value;
  if (!entry || !landing || !stash.value) return;
  try {
    const next = removeLanding(stash.value, entry.floorId, landing.id, Date.now());
    if (!next) {
      saveError.value = t.stashDeleteMissing;
      askDelete.value = false;
      return;
    }
    savePanelStash(next.stash);
    stash.value = next.stash;
    askDelete.value = false;
    const left = next.entry.landings;
    if (left.length === 0) {
      resetViewer();
      return;
    }
    openViewer(next.entry, left[left.length - 1]);
    notice.value = t.stashDeleted;
  } catch (error) {
    console.error('[剧情推进助手] 删除成果失败', error);
    saveError.value = String((error as Error)?.message ?? error);
  }
}

/** 楼层卡片上那行小字：几版、预设、时间。 */
function landingTime(landing: StashLanding): string {
  const date = new Date(landing.createdAt);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getMonth() + 1}/${date.getDate()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
</script>

<template>
  <div class="acu-section">
    <div class="acu-row acu-row--between">
      <span class="acu-section__title">{{ t.stashTitle }}</span>
      <button class="acu-btn acu-btn--sm" type="button" @click="reload">{{ t.stashRefresh }}</button>
    </div>
    <p class="acu-notes">{{ t.stashHint }}</p>
    <p v-if="warning === 'stash_unreadable'" class="acu-notes acu-notes--warn">{{ t.stashUnreadable }}</p>

    <p v-if="entries.length === 0" class="acu-notes">{{ t.stashEmpty }}</p>

    <div v-for="entry in entries" :key="entry.floorId" class="acu-stash-entry">
      <div class="acu-stash-entry__head">
        <span class="acu-stash-entry__floor">{{ t.stashFloor(entry.floorId) }}</span>
        <span class="acu-stash-entry__meta">{{ t.stashPreset(entry.presetName || '—') }}</span>
        <span v-if="entry.state !== 'complete'" class="acu-stash-entry__state acu-stash-entry__state--pending">
          {{ t.stashPending(entry.working ? entry.working.pending.length : 0) }}
        </span>
        <span v-else class="acu-stash-entry__state">{{ t.stashComplete }}</span>
      </div>
      <p v-if="entry.state !== 'complete'" class="acu-notes">{{ t.stashResumeHint }}</p>
      <div class="acu-stash-entry__landings">
        <button
          v-for="(landing, index) in entry.landings"
          :key="landing.id"
          class="acu-btn acu-btn--sm acu-stash-entry__version"
          type="button"
          @click="openViewer(entry, landing)"
        >
          <span class="acu-stash-entry__seq">{{ landingSeqOf(landing, index) }}</span>
          <span v-if="inUse(entry, landing)" class="acu-stash-entry__inuse">{{ t.stashInUse }}</span>
          <span class="acu-stash-entry__time">{{ landingTime(landing) }}</span>
        </button>
      </div>
    </div>
  </div>

  <div v-if="viewerOpen" class="acu-stash-mask">
    <div class="acu-stash-dialog">
      <div class="acu-stash-dialog__head">
        <span class="acu-stash-dialog__title">
          {{ t.stashEditTarget(openFloorId ?? 0, currentSeq === null ? '' : t.stashVersion(currentSeq)) }}
          <span v-if="currentInUse" class="acu-stash-entry__inuse">{{ t.stashInUse }}</span>
        </span>
        <button class="acu-stash-dialog__close" type="button" :title="t.stashViewerClose" @click="requestClose">×</button>
      </div>

      <div class="acu-stash-dialog__body">
        <label class="acu-stash-dialog__label">{{ t.stashTextLabel }}</label>
        <textarea v-model="draftText" class="acu-stash-dialog__text" spellcheck="false"></textarea>

        <div class="acu-stash-dialog__tags">
          <span class="acu-stash-dialog__label">{{ t.stashTagsLabel }}</span>
          <p v-if="tagRows.length === 0" class="acu-notes">{{ t.stashNoTags }}</p>
          <div v-for="row in tagRows" :key="row.name" class="acu-stash-tagrow">
            <span class="acu-stash-tagrow__name">{{ row.name }}</span>
            <span class="acu-stash-tagrow__preview">{{ row.preview }}</span>
            <button class="acu-stash-tagrow__drop" type="button" :title="`删掉 <${row.name}>`" @click="dropTag(row.name)">
              ×
            </button>
          </div>
        </div>

        <p v-if="gap.taskIds.length > 0" class="acu-notes">{{ t.stashGapHint(gap.tags.join('、'), gap.taskIds.length) }}</p>

        <p v-if="saveError" class="acu-notes acu-notes--error">{{ saveError }}</p>
        <p v-else-if="notice" class="acu-notes acu-notes--ok">{{ notice }}</p>
      </div>

      <div class="acu-stash-dialog__foot">
        <p v-if="dirty" class="acu-notes acu-notes--sm acu-stash-dialog__hint">{{ t.stashUseDirty }}</p>
        <button class="acu-btn acu-btn--sm" type="button" :disabled="dirty || busy" @click="applyToFloor">
          {{ t.stashApply }}
        </button>
        <button class="acu-btn acu-btn--sm" type="button" :disabled="dirty" @click="rerunText">
          {{ t.stashRerun }}
        </button>
        <button class="acu-btn acu-btn--sm danger" type="button" @click="requestRemove">{{ t.stashDelete }}</button>
        <button class="acu-btn primary" type="button" :disabled="!dirty" @click="save">{{ t.stashSave }}</button>
      </div>

      <div v-if="askDelete" class="acu-stash-ask">
        <p class="acu-stash-ask__text">{{ t.stashDeleteConfirm }}</p>
        <div class="acu-stash-ask__btns">
          <button class="acu-btn acu-btn--sm" type="button" @click="askDelete = false">{{ t.stashDeleteCancel }}</button>
          <button class="acu-btn acu-btn--sm danger" type="button" @click="confirmRemove">{{ t.stashDeleteOk }}</button>
        </div>
      </div>

      <div v-if="askDiscard" class="acu-stash-ask">
        <p class="acu-stash-ask__text">{{ t.stashDirtyClose }}</p>
        <div class="acu-stash-ask__btns">
          <button class="acu-btn acu-btn--sm" type="button" @click="askDiscard = false">{{ t.stashDirtyStay }}</button>
          <button class="acu-btn acu-btn--sm danger" type="button" @click="discardAndClose">{{ t.stashDirtyLeave }}</button>
        </div>
      </div>
    </div>
  </div>
</template>
