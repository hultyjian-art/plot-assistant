/**
 * 手势识别模块（挂在父窗口捕获阶段，多事件族冗余接收）。
 *
 * 演进史（每次失效的机理都记下来，防止改回去）：
 * - 第05版：jQuery 冒泡绑在按钮元素上 → mousedown 被别人拦截，失效。
 * - 第06版：原生 capture 绑在按钮元素上 → 目标元素上的 capture 没有优先权，失效。
 * - 第07版：父窗口 capture 委托 → 手机端能用，电脑端鼠标仍然不行。
 *   机理：页面代码（interact.js 那套拖拽）在 pointerdown 里调了 preventDefault，
 *   按指针事件规范浏览器就不再补发兼容的 mousedown/mouseup
 *   （touchstart/touchend 不受影响）——于是只有触摸端活着。
 * - 第08版：以 pointerdown/pointerup 为主通道。pointerdown 是最原始的输入
 *   事件，早于一切兼容事件，加上我们挂在父窗口捕获阶段（传播路径最先执行的位置），
 *   页面代码拦不住；mouse/touch 事件族留作兜底。
 *   一次物理按压可能同时产出 pointer→mouse（或 pointer→touch）多族事件，
 *   用 pressActive 标记只处理最先到达的那一族，其余当重复忽略。
 * - 第09版（当前）：只靠 pressActive 挡不住兼容族。手机上的事件序是
 *   pointerdown → touchstart → pointerup → touchend → mousedown → mouseup，
 *   pressActive 在 pointerup 就已经复位，随后补发的 mousedown/mouseup 被当成
 *   第二次按压又计了一指 ⇒ 单击 = 2 指 = 双击（绑的是原生重刷）、双击 = 3 指 =
 *   全流程重刷。用户 2026-11-03 报的"单击要么没反应、要么就开始原生重刷"正是这个。
 *   现在改成：pointer 通道一旦证明活着（收到过 pointer 事件），mouse/touch 两族
 *   整体退出计数，只在 pointer 完全不发的老浏览器里兜底。
 *
 * 跨 realm 提醒：事件对象和 target 都来自父窗口，iframe 里写
 * instanceof Element / instanceof MouseEvent 恒为 false，只能按属性存在性判断。
 */
import { profile } from './profile';
import { paintLock } from './feedback';
import { runGestureAction } from './router';
import { settlesAtOnce, outcomeOfTaps } from './tap-rule';
import { pageQuery } from './tavern';
import { logInfo } from './logger';
import { MSG, TAG } from './copy';
import type { RerushContext } from './types';

/** 触摸结束后这么久以内，浏览器补发的 contextmenu 一律忽略（毫秒）。 */
const TOUCH_AFTERGLOW_MS = 500;

/** 按压状态悬挂超过这个时长视为异常残留，放行下一轮按压（毫秒）。 */
const STALE_PRESS_LIMIT_MS = 10_000;

/** 事件目标落在本脚本 QR 按钮上时返回该按钮，否则返回 null。 */
function buttonUnder(target: EventTarget | null): HTMLElement | null {
  if (!target || typeof (target as Element).closest !== 'function') return null;

  const chip = (target as Element).closest('.qr--button');
  if (!chip) return null;

  const inOwnContainer = chip.closest(`#script_container_${getScriptId()}`) !== null;
  if (inOwnContainer || (chip.textContent ?? '').trim() === profile().buttonName) {
    return chip as HTMLElement;
  }
  return null;
}

export function mountGestureWatch(ctx: RerushContext): void {
  const host = window.parent;
  const p$ = pageQuery();

  // ---- 手势判定用到的瞬时状态，只在本模块内可见 ----
  let tapRun = 0;
  let tapWindowTimer: number | null = null;
  let holdTimer: number | null = null;
  let holdFired = false;
  /** 一次物理按压正在进行：最先到的那一族处理完置真，兼容族到达时直接忽略。 */
  let pressActive = false;
  let pressBeganAt = 0;
  let touchEndedAt = 0;
  let firstChannelSeen = false;
  let firstHitSeen = false;
  /** pointer 通道证明过自己活着：此后 mouse/touch 两族只是同一次按压的兼容回放。 */
  let pointerSeen = false;
  let compatSkipLogged = false;

  const cancelHoldTimer = (): void => {
    if (holdTimer !== null) {
      clearTimeout(holdTimer);
      holdTimer = null;
    }
  };

  const cancelTapWindow = (): void => {
    if (tapWindowTimer !== null) {
      clearTimeout(tapWindowTimer);
      tapWindowTimer = null;
    }
  };

  /** 抬起在按钮外或被浏览器取消：本轮按压作废，不计入连击。 */
  const abortPress = (): void => {
    pressActive = false;
    holdFired = false;
    cancelHoldTimer();
  };

  /** 累计到当前指数时，是否已经不可能再多一指、可以立刻结算。 */
  const settleNow = (): boolean => settlesAtOnce(ctx.settings.bindings, tapRun);

  const settleTaps = (waited: boolean): void => {
    const { key, name } = outcomeOfTaps(ctx.settings.bindings, tapRun, waited);
    tapRun = 0;
    cancelTapWindow();
    runGestureAction(ctx, key, name);
  };

  // ---- pointerdown / mousedown / touchstart ----
  const onPressStart = (e: Event): void => {
    if (!firstChannelSeen) {
      firstChannelSeen = true;
      logInfo(TAG.hand, MSG.captureChannelReady(e.type));
    }

    // 一次物理按压在手机上的事件序是
    // pointerdown → touchstart → pointerup → touchend → mousedown → mouseup。
    // pointer 那一对已经把这次按压处理完了（按下画灰、抬起计一指），后面几族是浏览器
    // 补发的兼容回放；再按一次就多算一指，单击会被算成「双击 → 原生重刷」。
    // 所以只要 pointer 通道证明过自己活着，其余族一律不再参与计数。
    if (e.type.startsWith('pointer')) pointerSeen = true;
    else if (pointerSeen) {
      if (e.type.startsWith('touch')) touchEndedAt = Date.now();
      if (!compatSkipLogged) {
        compatSkipLogged = true;
        logInfo(TAG.hand, MSG.compatFamilySkipped(e.type));
      }
      return;
    }

    // 只认主键与触摸（pointer 与 touch 事件族的 button 都是 0）
    const pressedKey = (e as { button?: number }).button;
    if (typeof pressedKey === 'number' && pressedKey !== 0) return;

    const chip = buttonUnder(e.target);
    if (chip === null) return;

    if (!firstHitSeen) {
      firstHitSeen = true;
      logInfo(TAG.hand, MSG.buttonHitFirstTime(e.type));
    }

    if (e.type.startsWith('touch')) touchEndedAt = Date.now();

    // 同一次按压只处理最先到达的那一族；悬挂过久视为异常残留，放行
    if (pressActive && Date.now() - pressBeganAt < STALE_PRESS_LIMIT_MS) return;
    pressActive = true;
    pressBeganAt = Date.now();

    // 有动作正在执行，这一指不排队
    if (ctx.state.locked) return;

    const $chip = p$(chip);

    // 点按钮不该把输入框的焦点抢走
    const focused = window.parent.document?.activeElement;
    if (focused && focused.id === 'send_textarea') e.preventDefault();

    paintLock($chip, true);
    holdFired = false;
    cancelHoldTimer();
    holdTimer = window.setTimeout(() => {
      holdFired = true;
      logInfo(TAG.hand, MSG.holdFired);
      runGestureAction(ctx, ctx.settings.bindings.hold, MSG.tapHold);
    }, ctx.settings.timing.holdMs);
  };

  // ---- pointerup / mouseup / touchend ----
  const onPressEnd = (e: Event): void => {
    // 同一次按压的兼容回放：抬起这一半也不参与计数（按下那一半已经拦过了）
    if (!e.type.startsWith('pointer') && pointerSeen) {
      if (e.type.startsWith('touch')) touchEndedAt = Date.now();
      return;
    }

    const releasedKey = (e as { button?: number }).button;
    if (typeof releasedKey === 'number' && releasedKey !== 0) return;

    // 不是从本按钮起手的按压，或者是同一次按压的兼容重复事件
    if (!pressActive) return;
    pressActive = false;

    if (e.type.startsWith('touch')) touchEndedAt = Date.now();

    // 按下在按钮上但抬起在别处：这一下作废，不计数
    if (buttonUnder(e.target) === null) {
      abortPress();
      return;
    }

    cancelHoldTimer();

    // 长按已经派发过，这一轮到此为止
    if (holdFired) {
      holdFired = false;
      return;
    }

    if (ctx.state.locked) return;

    tapRun++;
    cancelTapWindow();

    if (settleNow()) {
      settleTaps(false);
      return;
    }

    // 还可能继续加指，等一个点击间隔再结算
    tapWindowTimer = window.setTimeout(() => {
      settleTaps(true);
    }, ctx.settings.timing.tapWindowMs);
  };

  // ---- pointercancel：浏览器接管了这次按压（比如被判成滚动） ----
  const onPressAbandoned = (): void => {
    if (pressActive) abortPress();
  };

  // ---- contextmenu（右键） ----
  const onSecondaryPressed = (e: Event): void => {
    const chip = buttonUnder(e.target);
    if (chip === null) return;

    // 只有落在本按钮上才接管：拦住原生右键菜单，不碰页面其他区域
    e.preventDefault();

    // 触摸长按期间或刚结束，浏览器会补发 contextmenu，忽略
    if (pressActive || Date.now() - touchEndedAt < TOUCH_AFTERGLOW_MS) return;

    if (ctx.state.locked) return;

    paintLock(p$(chip), true);
    runGestureAction(ctx, ctx.settings.bindings.right, MSG.rightClick);
  };

  // ---- keydown（键盘操作 QR 按钮） ----
  const onKeyDown = (e: Event): void => {
    const chip = buttonUnder(e.target);
    if (chip === null) return;

    const key = (e as KeyboardEvent).key;
    if (key !== 'Enter' && key !== ' ') return;

    e.preventDefault();
    if (ctx.state.locked) return;

    paintLock(p$(chip), true);
    runGestureAction(ctx, ctx.settings.bindings.tap, MSG.keyTrigger);
  };

  // ---- 全部挂到父窗口的捕获阶段（传播路径最先执行的位置） ----
  const downSide = onPressStart as EventListener;
  const upSide = onPressEnd as EventListener;

  host.addEventListener('pointerdown', downSide, true);
  host.addEventListener('pointerup', upSide, true);
  host.addEventListener('pointercancel', onPressAbandoned, true);
  host.addEventListener('mousedown', downSide, true);
  host.addEventListener('touchstart', downSide, { capture: true, passive: false });
  host.addEventListener('mouseup', upSide, true);
  host.addEventListener('touchend', upSide, true);
  host.addEventListener('contextmenu', onSecondaryPressed, true);
  host.addEventListener('keydown', onKeyDown, true);

  logInfo(TAG.hand, MSG.gesturesMounted);

  ctx.state.detachListeners = () => {
    host.removeEventListener('pointerdown', downSide, true);
    host.removeEventListener('pointerup', upSide, true);
    host.removeEventListener('pointercancel', onPressAbandoned, true);
    host.removeEventListener('mousedown', downSide, true);
    host.removeEventListener('touchstart', downSide, true);
    host.removeEventListener('mouseup', upSide, true);
    host.removeEventListener('touchend', upSide, true);
    host.removeEventListener('contextmenu', onSecondaryPressed, true);
    host.removeEventListener('keydown', onKeyDown, true);

    cancelHoldTimer();
    cancelTapWindow();
    tapRun = 0;
    pressActive = false;
  };
}
