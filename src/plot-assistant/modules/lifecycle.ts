/**
 * 生命周期模块：装载、自检、聊天切换监听、卸载回收。
 *
 * 装载第一步是"抢占实例位"：同一脚本被新版替换时，旧实例的 iframe 不一定被销毁，
 * 它还挂在酒馆父窗口上的监听与页面节点会把新实例挡住（详见 instance.ts 顶部注释）。
 */
import { klona } from 'klona';
import { ensureMotionCss, ensureWandEntry, mountScriptButton } from './button';
import { WAND_ENTRY_ID, DIAGNOSTIC_DELAY_MS, TOAST_URGENT_MS } from './constants';
import { mountGestureWatch } from './gesture';
import { claimInstance, releaseInstance } from './instance';
import { logInfo, logWarn, logError } from './logger';
import { mountPlotSendGate } from './plot/send-gate';
import { scriptButtonExists } from './script-button';
import { loadSettings, FALLBACK_SETTINGS } from './settings';
import { pageQuery, tavernGlobal, helperGlobal, pageToastr } from './tavern';
import { MSG, TAG } from './copy';
import { mountFloorSync } from './plot/floor-sync';
import { enqueueWorldbookCheck } from './plot/worldbook-write';
import { setCachedActivatedEntries } from './plot/data/tavern-worldbook-scan';
import { mountManualButtons, type ManualTaskView } from './plot/manual-buttons';
import { describePresetProblem, readPlotPreset } from './plot/data/acu-presets';
import { findStoredPreset } from './plot/data/preset-store';
import { importPresetConfig } from './plot/eng/preset-import';
import { presetImportOptions } from './plot/preset-options';
import { anchorNameOf } from './plot/floor-anchor';
import type { RerushContext, TavernLike } from './types';

/** 装载：抢占实例位、挂监听、装按钮与手势，退场时回收。 */
export function bootstrap(ctx: RerushContext): void {
  let torn = false;
  /** chat_id_changed 的具名回调与它挂靠的事件源：退场时要按同一引用摘掉。 */
  let chatChangedSource: TavernLike['eventSource'] | null = null;
  let chatChangedListener: ((chatId: unknown) => void) | null = null;

  /** 退场：摘监听、退位、删掉自己留在酒馆页面上的节点。重复调用只生效一次。 */
  const teardown = (): void => {
    if (torn) return;
    torn = true;
    ctx.state.detachListeners?.();
    ctx.state.detachListeners = undefined;
    if (chatChangedSource && chatChangedListener) {
      chatChangedSource.removeListener?.('chat_id_changed', chatChangedListener);
    }
    chatChangedSource = null;
    chatChangedListener = null;
    // 只有"当前在位的还是自己"时才注销，避免把已接管的新实例的登记抹掉
    releaseInstance(getScriptId(), ctx.state.instanceId);
    logInfo(TAG.boot, MSG.teardownDone);
  };

  ctx.state.instanceId = claimInstance(getScriptId(), teardown);

  logInfo(TAG.boot, MSG.booting);
  loadSettings(ctx);
  ensureMotionCss(ctx.state.instanceId);
  ensureWandEntry(ctx);
  mountScriptButton();
  mountGestureWatch(ctx);
  // 剧情推进要在「用户点发送」这一刻插进去跑：手势重刷只是其中一条路，
  // 不开这层的话，正常点发送的正文会直接出去，开关等于装饰（2026-11-02 用户实测）。
  const detachPlotGate = mountPlotSendGate(ctx);
  // 手动触发按钮：楼层底部一排开关，点亮后下一次发送才跑对应任务。
  // 不在这里按总开关决定挂不挂——用户可能进设置再打开；由 isEnabled 在每次渲染时判断，
  // 关闭时只把按钮条摘掉，不动预约表（预约归任务停用/删除时清理）。
  const manualButtons = mountManualButtons({
    listManualTasks: () => listManualTasks(ctx),
    isEnabled: () => ctx.settings.plot.enabled,
  });
  // 保存设置后立即重排手动按钮：任务从「自动」切到「手动」、或取消手动时，
  // 不需要等聊天事件或换角色卡才刷新（2026-11-11 用户实测反馈）。
  // 先保留原来的 onSettingsSaved（重注册脚本按钮），再追加重排。
  const settingsSavedBeforeManualButtons = ctx.onSettingsSaved;
  ctx.onSettingsSaved = () => {
    try {
      settingsSavedBeforeManualButtons?.();
    } finally {
      manualButtons.refresh();
    }
  };
  // 用户在酒馆里手动改完楼层、点保存时，把改动同步回当前模式的存储（账本或 qrf 字段）。
  const detachFloorSync = mountFloorSync(ctx);
  // 世界书写入（2026-11-07 批 36/37）：脚本装载时对一次账 —— 酒馆初始加载时
  // chat_id_changed 不一定再发一次，靠这里兜住「上次切了聊天/角色卡、改了规则」的场景。
  enqueueWorldbookCheck(ctx);
  // 原版 SillyTavern 没有「世界书预演」接口时，靠上一次生成的激活广播兜底。
  // WORLD_INFO_ACTIVATED 只在「本轮至少激活一条」时才发，上一轮 0 激活会留着旧清单；
  // WORLDINFO_SCAN_DONE 每轮都发（含空清单），用它兜住「清旧」这一下。
  const offWorldInfoActivated = eventOn(tavern_events.WORLD_INFO_ACTIVATED, entries => {
    setCachedActivatedEntries(entries);
  });
  const offWorldInfoScanDone = eventOn(tavern_events.WORLDINFO_SCAN_DONE, data => {
    setCachedActivatedEntries(data?.activated?.entries);
  });
  const detachGesture = ctx.state.detachListeners;
  ctx.state.detachListeners = () => {
    detachGesture?.();
    detachPlotGate();
    manualButtons.dispose();
    detachFloorSync.stop();
    offWorldInfoActivated.stop();
    offWorldInfoScanDone.stop();
  };

  const p$ = pageQuery();
  const tavern = tavernGlobal();

  // 自检推迟一点，QR 区的按钮是异步渲染出来的，太早查会误报
  window.setTimeout(() => {
    let somethingWrong = false;
    const helper = helperGlobal();

    if (!helper) {
      logError(TAG.check, MSG.noTavernHelper);
      logError(TAG.check, MSG.noTavernHelperWhy);
      somethingWrong = true;
    } else if (typeof helper.triggerSlash !== 'function') {
      logWarn(TAG.check, MSG.staleTavernHelper);
    }

    if (!scriptButtonExists()) {
      somethingWrong = true;
      logError(TAG.check, MSG.qrAbsent);
      if (p$('#qr--bar').length === 0) {
        logError(TAG.check, MSG.qrAbsentBecauseNoBar);
      } else {
        logError(TAG.check, MSG.qrAbsentBecauseNotRendered);
      }
    }

    if (p$('#' + WAND_ENTRY_ID).length === 0) {
      somethingWrong = true;
      logError(TAG.check, MSG.menuAbsent);
    }

    if (somethingWrong) {
      pageToastr()?.error(MSG.mountPartial, MSG.mountPartialTitle, { timeOut: TOAST_URGENT_MS });
    } else {
      logInfo(TAG.check, MSG.mountOk);
    }
  }, DIAGNOSTIC_DELAY_MS);

  if (tavern && tavern.eventSource) {
    chatChangedSource = tavern.eventSource;
    chatChangedListener = (chatId: unknown): void => {
      const newKey = typeof chatId === 'string' ? chatId : String(chatId);
      logInfo(TAG.boot, MSG.chatSwitched(newKey));
      ctx.state.chatKey = newKey;
      // 世界书写入联动（2026-11-07 批 36/37）：换聊天后按新聊天的账本重算 ——
      // 新聊天账本空，重放为空，角色卡世界书里就不残留上一聊天的条目。
      // 这只是加速触发：切角色卡没有干净事件，每轮开跑前还会比对一次键。
      enqueueWorldbookCheck(ctx);
    };
    tavern.eventSource.on('chat_id_changed', chatChangedListener);

    logInfo(TAG.boot, MSG.eventMounted);
  } else {
    logWarn(TAG.boot, MSG.noEventSource);
  }

  // iframe 被移除时 pagehide / unload 谁先到都行，teardown 只生效一次。
  // 这一步是把"关掉旧脚本"真正做干净的关键：不清掉魔法棒入口与动效样式，
  // 新实例会以为入口已存在而跳过注册，你点的就成了旧实例留下的死入口。
  $(window).on('pagehide unload', teardown);
}

/**
 * 取「启用且开了手动触发」的任务，供楼层按钮渲染。
 *
 * 读不到预设时**抛错**而不是回空表：空表在按钮模块里会被当成「这些任务都删了」并清空预约表，
 * 一次临时的读取失败不该把用户点亮的预约抹掉。调用方会捕获并跳过本次渲染。
 */
function listManualTasks(ctx: RerushContext): ManualTaskView[] {
  const plotSettings = ctx.settings.plot;
  const wanted = plotSettings.presetName.trim();
  if (wanted === '') throw new Error('还没选剧情推进预设');

  const stored = findStoredPreset(plotSettings.presets, wanted);
  let preset: Record<string, unknown>;
  if (stored) {
    preset = stored.data;
  } else {
    const outcome = readPlotPreset(wanted);
    if (!outcome.ok) throw new Error(describePresetProblem(outcome));
    preset = outcome.details as Record<string, unknown>;
  }

  const config = importPresetConfig(preset, presetImportOptions(plotSettings));
  const presetKey = stored ? stored.name : config.name;
  return config.tasks
    .filter(task => task.enabled !== false && task.schedule?.manual === true)
    .map(task => ({ id: task.id, name: task.name, anchorName: anchorNameOf(presetKey, task.id) }));
}

/**
 * 入口统一用的启动函数：建上下文（默认设置深拷一份，免得装载失败时把默认值本身改脏）、
 * 声明"保存后要重注册脚本按钮"，再在 jQuery 的加载时机里装载。
 * 完整版与轻量版「剧情推进助手·轻」两个入口都走这里，差别只在各自先 useProfile() 了哪套档案。
 */
export function startRerush(): void {
  const ctx: RerushContext = {
    // instanceId 在 bootstrap 抢占实例位时才拿到，这里先占个空
    state: { locked: false, chatKey: null, instanceId: '' },
    settings: klona(FALLBACK_SETTINGS),
  };

  // 手势绑定变了要重新注册脚本按钮（按钮可见性/文字跟着设置走）
  ctx.onSettingsSaved = () => mountScriptButton();

  $(() => {
    errorCatched(bootstrap)(ctx);
  });
}
