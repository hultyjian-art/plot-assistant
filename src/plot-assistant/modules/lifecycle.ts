/**
 * 生命周期模块：装载、自检、聊天切换监听、卸载回收。
 *
 * 装载第一步是"抢占实例位"：同一脚本被新版替换时，旧实例的 iframe 不一定被销毁，
 * 它还挂在酒馆父窗口上的监听与页面节点会把新实例挡住（详见 instance.ts 顶部注释）。
 */
import { klona } from 'klona';
import { ensureMotionCss, ensureWandEntry, mountScriptButton } from './button';
import { WAND_ENTRY_ID, DIAGNOSTIC_DELAY_MS } from './constants';
import { mountGestureWatch } from './gesture';
import { claimInstance, releaseInstance } from './instance';
import { logInfo, logWarn, logError } from './logger';
import { mountPlotSendGate } from './plot/send-gate';
import { scriptButtonExists } from './script-button';
import { loadSettings, FALLBACK_SETTINGS } from './settings';
import { pageQuery, tavernGlobal, helperGlobal, pageToastr } from './tavern';
import { MSG, TAG } from './copy';
import { mountFloorSync } from './plot/floor-sync';
import type { RerushContext } from './types';

/** 装载。 */
export function bootstrap(ctx: RerushContext): void {
  let torn = false;

  /** 退场：摘监听、退位、删掉自己留在酒馆页面上的节点。重复调用只生效一次。 */
  const teardown = (): void => {
    if (torn) return;
    torn = true;
    ctx.state.detachListeners?.();
    ctx.state.detachListeners = undefined;
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
  // 用户在酒馆里手动改完楼层、点保存时，把改动同步回当前模式的存储（账本或 qrf 字段）。
  const detachFloorSync = mountFloorSync(ctx);
  const detachGesture = ctx.state.detachListeners;
  ctx.state.detachListeners = () => {
    detachGesture?.();
    detachPlotGate();
    detachFloorSync.stop();
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
      pageToastr()?.error(MSG.mountPartial, MSG.mountPartialTitle, { timeOut: 8000 });
    } else {
      logInfo(TAG.check, MSG.mountOk);
    }
  }, DIAGNOSTIC_DELAY_MS);

  if (tavern && tavern.eventSource) {
    tavern.eventSource.on('chat_id_changed', (chatId: unknown) => {
      const newKey = typeof chatId === 'string' ? chatId : String(chatId);
      logInfo(TAG.boot, MSG.chatSwitched(newKey));
      ctx.state.chatKey = newKey;
    });

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
