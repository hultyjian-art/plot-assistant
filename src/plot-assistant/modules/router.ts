/**
 * 动作派发模块：把手势识别的结果（哪个手势）按设置里的绑定换算成动作并执行。
 */
import { paintLock } from './feedback';
import { runNativeRefresh, runRerushFlow } from './actions';
import { showPrefsPanel } from './settings-panel';
import { findScriptButton } from './script-button';
import { isCurrentInstance } from './instance';
import { logInfo, logWarn } from './logger';
import { MSG, TAG } from './copy';
import type { ActionKey, RerushContext } from './types';

export function runGestureAction(ctx: RerushContext, actionKey: ActionKey, gestureName: string): void {
  // 进入时记下这把锁是不是「本次手势自己占的」：
  // 原本为 true = 剧情推进或别的重刷动作正在跑（send-gate.ts 或另一条手势占的），
  // 这把锁不属于本次手势，收尾时绝不能由我抹掉；原本为 false 才是本次动作自己占的。
  // 暂存面板 StashPanel.vue:52-53 靠这个字段做运行期只读，锁被抹 = 暂存区全部解禁、
  // 后写会盖掉引擎刚落的账本；floor-sync 的运行期排队也读它。
  const ownedThisGesture = !ctx.state.locked;

  // 按钮复位（画灰复原 + 移走焦点）是纯视觉，任何时候都要做，与「要不要解锁」互不相干。
  const resetButton = (): void => {
    const $btn = findScriptButton();
    if ($btn) {
      paintLock($btn, false);
      $btn.blur();
    }
  };

  // 收尾：只解锁本次手势自己占的锁；运行态锁原样留着。
  const standDown = (): void => {
    if (ownedThisGesture) ctx.state.locked = false;
    resetButton();
  };

  // 运行期分流：会改数据 / 会启动重刷的动作一律不跑，settings 与 none 照常往下走。
  // 放在派发层，因为只有这里拿得到 actionKey；手势层结算前只知道「第几指」，
  // 若在那里按当前这一指放行，运行期第二指、第三指就会真跑出 native / full。
  if (!ownedThisGesture && (actionKey === 'native' || actionKey === 'full' || actionKey === 'edit')) {
    logWarn(TAG.route, `手势「${gestureName}」派发到 ${actionKey}：推进或重刷正在运行，已拦下（运行态锁保持不变）`);
    resetButton(); // 运行期连点后别让按钮一直灰着；只复位视觉，不动锁
    return;
  }

  // 旧实例被新版本顶替后，它挂在父窗口捕获阶段的手势监听可能还活着
  // （脚本 iframe 没被销毁时不会触发卸载事件）。这里靠实例位自我否决，
  // 否则同一次点击会被新旧两个实例各处理一遍（表现为一次点击重刷两次）。
  if (!isCurrentInstance(ctx)) {
    logInfo(TAG.route, MSG.staleInstanceIgnored);
    // 按钮的灰底是旧实例自己按下去的（`gesture.ts` 在派发前就 paintLock 了），
    // 它已经不会再执行任何动作，不在这里还原就会一直灰着不动。
    standDown();
    return;
  }

  logInfo(TAG.route, MSG.routed(gestureName, actionKey));

  if (actionKey === 'none') {
    logInfo(TAG.route, MSG.routedToNothing);
    standDown();
    return;
  }

  ctx.state.locked = true;

  switch (actionKey) {
    case 'native':
      // 原生重刷里含"换插头"的异步步骤，这里不阻塞派发
      void runNativeRefresh(ctx);
      break;
    case 'full':
      void runRerushFlow(ctx, true).catch((error: unknown) => {
        logWarn(TAG.route, MSG.flowAborted(error instanceof Error ? error.message : String(error)), error);
        standDown();
      });
      break;
    case 'edit':
      void runRerushFlow(ctx, false).catch((error: unknown) => {
        logWarn(TAG.route, MSG.flowAborted(error instanceof Error ? error.message : String(error)), error);
        standDown();
      });
      break;
    case 'settings': {
      logInfo(TAG.route, MSG.openPanel);
      standDown();
      showPrefsPanel(ctx);
      break;
    }
  }
}
