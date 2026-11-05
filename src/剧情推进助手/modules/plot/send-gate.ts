/**
 * 剧情推进 — 发送拦截（"发送前跑一轮推进"）。
 *
 * ## 为什么必须有这一层
 *
 * 剧情推进的语义是「用户点发送 → 先跑一轮剧情任务 → 把结果拼进这一条的提示词 → 再真正发出去」。
 * 不做拦截，这个开关就等于装饰：用户点发送，酒馆立刻把原文发出去、开始生成，
 * 剧情任务根本没有机会介入（2026-11-02 用户实测反馈：开关形同虚设）。
 *
 * 拦截点选在 **DOM 捕获阶段**（`document` 上的 capture 监听），不用 `GENERATION_AFTER_COMMANDS`：
 * - 那个事件触发时输入框已经被酒馆消费掉，要改提示词得先中止生成再重发，链路更长、更容易和
 *   别的脚本（ACU、spv）抢状态；
 * - 捕获阶段的监听一定比按钮自己的 click 处理器先跑，`stopPropagation` 一叫，酒馆那边就收不到
 *   这次点击，等于「按住了发送键」，等剧情跑完再自己按一次。
 *
 * ## 三种结局
 *
 * 1. **跑成功**：把**最终注入指令**（含 `<plot>` 块）写回输入框，然后替用户点一次发送
 *    （带旁路标记，不会再被自己拦一次）。为什么正文只要指令：用户原话已经通过任务提示词里的
 *    `$8` 进了这一轮的输入，再拼一遍会让主 AI 把同一段话读两遍（用户 2026-11-02 拍板，照 ACU 语义）。
 * 2. **跑失败（真跑过但没跑完）**：输入框保持原文，什么都不发。用户再点一次会接着上次的欠账跑。
 * 3. **不该拦**（开关没开、正在生成、输入框是空的、点了终止）：一律放行，让酒馆照旧。
 *
 * ## 「解除发送伪装」
 *
 * 等待期间默认显示一条浮动气泡（原文留在输入框、不伪造 AI 楼层），气泡上有「终止」。
 * 打开「解除发送伪装」后不显示任何等待外观 —— 只是少个看得见的凭据，流程不变。
 */

import { pageQuery, parentWindow, pageToastr } from '../tavern';
import { logInfo, logWarn } from '../logger';
import { TAG, MSG, UI } from '../copy';
import { appendPlotBlock } from './run-in-flow';
import { clearSendBypass, consumeSendBypass } from './send-bypass';
import type { RerushContext } from '../types';

/** 气泡节点 id。同一个页面只留一个，旧实例留下的先删掉。 */
const BUBBLE_ID = 'rh-plot-bubble';

export interface BubbleHandle {
  setText(text: string): void;
  /**
   * 显示「现在在跑哪个任务、跑到第几个」。
   *
   * 用户 2026-11-04 要求像工作流助手那样：一句阶段 + 任务名 + 一根进度条。
   * 没有它的话，一轮两三个任务跑十几分钟，用户只知道「在跑」，分不清是在干活还是卡死了。
   */
  setProgress(info: BubbleProgress): void;
  close(): void;
}

/** 气泡要显示的一格进度 —— 就是引擎 `TaskProgressInfo` 里气泡用得上的那几项。 */
export interface BubbleProgress {
  taskName: string;
  stage: number;
  stageTotal: number;
  index: number;
  total: number;
}

/**
 * 浮动气泡：一句话进度 + 一个「终止」。样式内联，避免依赖面板样式表是否已注入。
 *
 * 除了发送拦截这条路，全流程重刷（`actions.ts` 的 `runRerushFlow`）也用它：
 * 那条路上要跑好几轮 AI 请求，只把按钮变灰的话，用户分不清"在跑"和"卡死了"。
 */
export function mountBubble(doc: Document, onStop: () => void): BubbleHandle {
  doc.getElementById(BUBBLE_ID)?.remove();

  const box = doc.createElement('div');
  box.id = BUBBLE_ID;
  box.setAttribute('role', 'status');
  // 手机上软键盘一弹，`position:fixed` 的 bottom 会落到键盘后面（等于看不见），
  // 所以窄屏改挂到顶部 —— 那里永远是可见的。
  const placeAtTop = (() => {
    try {
      return doc.defaultView?.matchMedia('(max-width: 720px)').matches === true;
    } catch {
      return false;
    }
  })();

  box.style.cssText = [
    'position:fixed',
    'left:50%',
    placeAtTop ? 'top:12px' : 'bottom:96px',
    'transform:translateX(-50%)',
    'z-index:2147483000',
    // 竖排：第一行文字+终止，第二行进度条。横排塞不下「阶段 1/2 · 记忆召回（1/3）」这么长的字。
    'display:flex',
    'flex-direction:column',
    'gap:6px',
    // 只做一张小卡片：内容多宽它就多宽，不铺满屏幕，也不压住底下的按钮。
    'max-width:min(320px,80vw)',
    'padding:8px 10px 8px 12px',
    'border-radius:12px',
    'background:rgba(32,32,36,.94)',
    'color:#f4f4f5',
    'font-size:12px',
    'line-height:1.35',
    'box-shadow:0 6px 18px rgba(0,0,0,.26)',
    'backdrop-filter:blur(6px)',
    // 拖动时要跟手，不能让浏览器把手势当成滚动。
    'touch-action:none',
    'cursor:move',
    'user-select:none',
  ].join(';');

  const head = doc.createElement('div');
  head.style.cssText = 'display:flex;align-items:center;gap:8px;width:100%';

  const label = doc.createElement('span');
  label.textContent = UI.plot.bubbleRunning;
  label.style.cssText = 'flex:1 1 auto;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis';

  const stop = doc.createElement('button');
  stop.type = 'button';
  stop.textContent = UI.plot.bubbleStop;
  stop.style.cssText = [
    'flex:0 0 auto',
    'padding:4px 10px',
    'border-radius:8px',
    'border:1px solid rgba(255,255,255,.28)',
    'background:transparent',
    'color:inherit',
    'font-size:12px',
    'cursor:pointer',
  ].join(';');
  stop.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    onStop();
  });

  head.appendChild(label);
  head.appendChild(stop);

  // 进度条：外层是槽，内层按比例伸长。宽度带 transition，任务切换时是「走过去」而不是跳变。
  const track = doc.createElement('div');
  track.style.cssText = 'height:4px;border-radius:999px;background:rgba(255,255,255,.18);overflow:hidden;width:100%';
  const bar = doc.createElement('div');
  bar.style.cssText =
    'height:100%;width:0%;border-radius:999px;background:linear-gradient(90deg,#7dd3fc,#a78bfa);transition:width .28s ease';
  track.appendChild(bar);

  box.appendChild(head);
  box.appendChild(track);

  // 可拖动：按住提示条任何地方都能拖走，免得它挡住下面的按钮。
  // 一旦拖过，就换成 left/top 绝对定位（原来的居中靠 transform，拖起来会打架）。
  let dragging = false;
  let grabX = 0;
  let grabY = 0;
  box.addEventListener('pointerdown', (event) => {
    if (event.target === stop) return;
    const view = doc.defaultView;
    if (!view) return;
    const rect = box.getBoundingClientRect();
    dragging = true;
    grabX = event.clientX - rect.left;
    grabY = event.clientY - rect.top;
    box.style.transform = 'none';
    box.style.left = `${rect.left}px`;
    box.style.top = `${rect.top}px`;
    box.style.bottom = 'auto';
    try {
      box.setPointerCapture(event.pointerId);
    } catch {
      // 有些环境不给捕获，靠 pointermove 也能拖，忽略即可。
    }
  });
  box.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    const view = doc.defaultView;
    if (!view) return;
    const rect = box.getBoundingClientRect();
    const maxLeft = Math.max(0, view.innerWidth - rect.width);
    const maxTop = Math.max(0, view.innerHeight - rect.height);
    box.style.left = `${Math.min(Math.max(0, event.clientX - grabX), maxLeft)}px`;
    box.style.top = `${Math.min(Math.max(0, event.clientY - grabY), maxTop)}px`;
  });
  const stopDrag = (event: PointerEvent): void => {
    if (!dragging) return;
    dragging = false;
    try {
      box.releasePointerCapture(event.pointerId);
    } catch {
      // 同上，没捕获过就无所谓。
    }
  };
  box.addEventListener('pointerup', stopDrag);
  box.addEventListener('pointercancel', stopDrag);

  doc.body.appendChild(box);

  return {
    setText(text: string): void {
      label.textContent = text;
    },
    setProgress(info: BubbleProgress): void {
      const total = Math.max(1, Math.floor(info.total) || 1);
      const stageTotal = Math.max(1, Math.floor(info.stageTotal) || 1);
      const index = Math.min(total, Math.max(1, Math.floor(info.index) || 1));
      // 正在跑的那个算「半个已完成」：否则第一个任务开跑时进度条一动不动，
      // 用户会以为卡住了 —— 而这一格正是他最需要知道「在动」的时候。
      const ratio = Math.min(1, Math.max(0, (index - 0.5) / total));
      bar.style.width = `${(ratio * 100).toFixed(1)}%`;
      const stageText = stageTotal > 1 ? `阶段 ${info.stage}/${stageTotal} · ` : '';
      label.textContent = `${stageText}${info.taskName || '任务'}（${index}/${total}）`;
      head.title = label.textContent;
    },
    close(): void {
      box.remove();
    },
  };
}

function readInput(): string {
  const value = pageQuery()('#send_textarea').val();
  return typeof value === 'string' ? value : '';
}

function writeInput(text: string): void {
  const p$ = pageQuery();
  const $box = p$('#send_textarea');
  $box.val(text).trigger('input');
  const height = $box[0]?.scrollHeight ?? 0;
  if (height > 0) $box.css('height', `${height}px`);
}

function clickSend(): void {
  const $btn = pageQuery()('#send_but');
  // 必须凑成一对。手势模块（`gesture.ts`）靠 pointerup/mouseup 才知道"这次按压结束了"，
  // 只发 mousedown 会让它一直停在"按着"的状态：之后所有连击都被当成同一次长按吞掉，
  // 按钮也会卡在按下的样子（用户实测：三连击做不了全流程重刷，按钮变灰下陷）。
  $btn.trigger('mousedown').trigger('mouseup').click();
}

/**
 * 装上发送拦截，返回卸载函数。
 *
 * @param ctx 脚本上下文（读 `settings.plot`、写 `state.locked` 防重入）
 */
export function mountPlotSendGate(ctx: RerushContext): () => void {
  const win = parentWindow();
  const doc = win?.document;
  if (!doc) {
    logWarn(TAG.plotGate, MSG.plotGateNoWindow);
    return () => undefined;
  }

  /** 我们自己按发送时置位，避免被自己的拦截器再拦一次。 */
  let bypass = false;
  /** 正在跑剧情推进。 */
  let running = false;
  let abort: AbortController | null = null;
  let bubble: BubbleHandle | null = null;

  const stopRun = (): void => {
    if (!abort) return;
    abort.abort();
    bubble?.setText(UI.plot.bubbleStopping);
    logInfo(TAG.plotGate, MSG.plotGateStopped);
  };

  const finishUi = (): void => {
    running = false;
    abort = null;
    bubble?.close();
    bubble = null;
    ctx.state.locked = false;
  };

  const run = async (text: string): Promise<void> => {
    running = true;
    ctx.state.locked = true;
    abort = new AbortController();

    const plot = ctx.settings.plot;
    const disguise = plot.sendDisguiseDisabled !== true;
    if (disguise) bubble = mountBubble(doc, stopRun);

    try {
      logInfo(TAG.plotGate, MSG.plotGateStart);
      // 锚点：这一条发出去后会占用的用户楼层号 = 当前最后一层 + 1。
      // 暂存账用它认领「同一条输入被跑了两版」的情况。
      const lastId = pageQuery()('#chat .mes').length - 1;
      const result = await appendPlotBlock(ctx, text, {
        floor: { messageId: lastId + 1, floorText: text },
        signal: abort.signal,
        // 正文只放最终注入指令（见文件头「三种结局」第 1 条）
        join: 'final',
        // 进度喂给气泡：阶段、任务名、第几个 / 共几个
        onTaskStart: (info) => bubble?.setProgress(info),
      });

      if (abort.signal.aborted) {
        logInfo(TAG.plotGate, MSG.plotGateStopped);
        return;
      }

      if (result.ok === false) {
        // 真跑过却没跑完：停在原地，别把没拼上剧情的原文发出去
        pageToastr()?.warning(result.note, UI.plot.bubbleTitle, { timeOut: 6000 });
        logWarn(TAG.plotGate, result.note);
        return;
      }

      if (result.text === text) {
        // 这一轮没有任务要跑：原文原样发，不拼空块
        logInfo(TAG.plotGate, MSG.plotGateNoTask);
      }

      writeInput(result.text);
      bypass = true;
      try {
        clickSend();
      } finally {
        // 下一次事件循环再撤：capture 监听到的点击是同步派发的
        win?.setTimeout(() => {
          bypass = false;
        }, 0);
      }
    } catch (error) {
      logWarn(TAG.plotGate, MSG.plotGateCrashed, error);
      pageToastr()?.error(MSG.plotGateCrashed, UI.plot.bubbleTitle, { timeOut: 6000 });
    } finally {
      finishUi();
    }
  };

  /** 吞掉这次事件但什么都不跑（已经有一轮在跑时的第二次点击）。 */
  const swallow = (event: Event): void => {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
  };

  const intercept = (event: Event, text: string): void => {
    swallow(event);
    void run(text);
  };

  const onClick = (event: Event): void => {
    // 自己发的：本地标记（刚跑完点的那一下）或别的流程提前打的招呼
    if (bypass || consumeSendBypass()) return;
    const target = event.target as Element | null;
    if (!target || typeof target.closest !== 'function') return;
    if (!target.closest('#send_but')) return;
    if (!ctx.settings.plot.enabled) return;

    const text = readInput().trim();
    if (text === '') return;
    if (running) {
      // 已经有一轮在跑：把第二次点击吞掉，别让它变成一次"原文直接发送"
      swallow(event);
      return;
    }
    intercept(event, text);
  };

  /**
   * 这次 Enter 到底算不算「发送」。
   *
   * 输入框里按 Enter 有两种语义：发送、换行，由酒馆的 `power_user.send_on_enter` 决定。
   * 手机键盘上那颗写着「换行」的键，发出来的同样是 Enter。
   *
   * 以前不看这两件事就直接拦，结果手机端换行被吞（2026-11-02 用户实测：
   * 要么直接自动发送、要么完全没反应，关掉总开关就正常）。所以只在
   * 「不是触摸设备、且酒馆设成 Enter 发送」时才认它，其余一律放行给酒馆。
   */
  const enterMeansSend = (): boolean => {
    const host = doc?.defaultView;
    if (!host) return false;
    try {
      if (typeof host.matchMedia === 'function' && host.matchMedia('(pointer: coarse)').matches) return false;
    } catch {
      return false;
    }
    const powerUser = (host as unknown as { power_user?: { send_on_enter?: unknown } }).power_user;
    return powerUser?.send_on_enter === true;
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (bypass || consumeSendBypass()) return;
    if (event.key !== 'Enter' || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.isComposing) return;
    if (!enterMeansSend()) return;
    const target = event.target as Element | null;
    if (!target || typeof target.closest !== 'function') return;
    if (!target.closest('#send_textarea')) return;
    if (!ctx.settings.plot.enabled) return;

    const text = readInput().trim();
    if (text === '') return;
    if (running) {
      swallow(event);
      return;
    }
    intercept(event, text);
  };

  doc.addEventListener('click', onClick, true);
  doc.addEventListener('keydown', onKeyDown, true);

  return () => {
    doc.removeEventListener('click', onClick, true);
    doc.removeEventListener('keydown', onKeyDown, true);
    abort?.abort();
    bubble?.close();
    bubble = null;
    running = false;
    bypass = false;
    clearSendBypass();
    ctx.state.locked = false;
  };
}
