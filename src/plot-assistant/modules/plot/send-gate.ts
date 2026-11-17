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
 * 进度气泡**无条件显示**（用户 2026-11-15 批 104 第 3 条「不管开关与否都要显示气泡窗」）。
 * 开关只改等待外观，严格对齐 ACU 1.3.6：默认「伪装开启」时先在聊天末尾插一条**临时用户楼层**
 * （纯 UI 节点，不进 chat 数组、不占楼号）把原文摆出来，输入框才收起来 —— 否则等待期间
 * 输入框凭空清空、聊天里又什么都没有，用户会以为没发送成功（2026-11-15 用户实测报障）。
 * 打开「解除发送伪装」后不插临时楼层、原文一直留在输入框。两档发送契约完全一致：
 * 任务成功由酒馆继续本次发送，最终失败或手动终止都停发、原文还回输入框（不另造真实用户楼层）。
 */

import { TOAST_NOTICE_MS } from '../constants';
import { currentMessageId, pageQuery, parentWindow, pageToastr } from '../tavern';
import { logInfo, logWarn } from '../logger';
import { TAG, MSG, UI } from '../copy';
import { appendPlotBlock } from './run-in-flow';
import { completePlotSend } from './after-send';
import { clearSendBypass, consumeSendBypass, pendingSendBypass } from './send-bypass';
import type { RerushContext } from '../types';

/**
 * 发送前推算「这一条用户消息发出去会占第几楼」——取酒馆数据里的真实楼层号，不数页面气泡。
 *
 * 为什么不能数 `#chat .mes`：隐藏楼层不渲染成气泡，刚导入聊天或批量删改之后页面与数据
 * 也会短暂不同步；气泡个数减一得到的号会偏，暂存账和运行日志就会锚到错层、甚至超时丢失。
 *
 * 主路：`currentMessageId()`（tavern.ts 对酒馆助手 `getLastMessageId()` 的封装，酒馆没就绪时
 * 返回 undefined），拿到的就是当前真实最后一楼号，新楼 = 它 + 1。
 *
 * 降级：`getChatMessages(-1)[0].message_id`。这也是读真实数据，不是数 DOM：-1 只取最新一条
 * （O(1)），且 `hide_state` 默认 'all'，隐藏楼层照样在内（@types/function/chat_message.d.ts
 * :25/:34/:50）。接口暂时拿不到时用它，绝不退回页面气泡数凑数。
 *
 * 两条都拿不到：返回 null。调用方会把锚点留空 —— appendPlotBlock 没有 anchor 时不记暂存、
 * 不写运行日志、不产 commit，宁可这一轮不记账，也不把账记到猜出来的楼层号上。
 */
export function nextUserFloorId(): number | null {
  const lastId = currentMessageId();
  if (typeof lastId === 'number' && Number.isFinite(lastId)) return lastId + 1;

  try {
    if (typeof getChatMessages === 'function') {
      const rows = getChatMessages(-1) as unknown as Array<{ message_id?: number }>;
      const fallbackId = Array.isArray(rows) ? rows[0]?.message_id : undefined;
      if (typeof fallbackId === 'number' && Number.isFinite(fallbackId)) return fallbackId + 1;
    }
  } catch (error) {
    logWarn(TAG.plotGate, '读不到真实最后一楼：这一轮不猜楼层号', error);
  }
  return null;
}

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
  /** 某个任务跑完了（成功或失败）—— 把它从「进行中」挪到「已完成 / 失败」 */
  settleTask(taskId: string, success: boolean): void;
  close(): void;
}

/** 气泡要显示的一格进度 —— 就是引擎 `TaskProgressInfo` 里气泡用得上的那几项。 */
export interface BubbleProgress {
  taskId: string;
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
    // 右上方偏低：不再水平居中（用户 2026-11-15 批 104 第 2 条）。用 right 而不是
    // left + transform；拖动开始的 pointerdown 里会先清掉 right 再改 left/top。
    placeAtTop ? 'right:12px' : 'right:16px',
    placeAtTop ? 'top:64px' : 'top:96px',
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

  // 任务清单：同一阶段的任务是并发跑的，气泡必须**同时**列出所有正在进行的任务。
  // 只显示最后一个开始的任务会让用户以为别的那几个没在跑（2026-11-09 第 4 条）。
  const list = doc.createElement('div');
  list.style.cssText = 'display:flex;flex-direction:column;gap:2px;width:100%;max-height:132px;overflow-y:auto';
  // 在清单里上下滑是滚动，不该把整张卡片拖走。
  list.addEventListener('pointerdown', (event) => event.stopPropagation());

  box.appendChild(head);
  box.appendChild(list);
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
    // 默认位置靠 right 定位；改成拖动定位前必须清掉，否则 left+right 同时生效会把卡片拉宽。
    box.style.right = 'auto';
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

  /** 气泡里的一格任务。`index` 是引擎给的「第几个开始跑」，只用来排显示顺序。 */
  interface BubbleTaskRow {
    taskId: string;
    name: string;
    stage: number;
    stageTotal: number;
    index: number;
    state: 'running' | 'done' | 'failed';
  }

  const rows = new Map<string, BubbleTaskRow>();
  let totalTasks = 1;
  let labelOverride = '';

  const render = (): void => {
    const ordered = [...rows.values()].sort((a, b) => a.index - b.index);
    const settled = ordered.filter((row) => row.state !== 'running').length;
    const running = ordered.filter((row) => row.state === 'running').length;
    const total = Math.max(1, totalTasks, ordered.length);
    // 进行中的任务算「半个已完成」：否则第一个任务开跑时进度条一动不动，
    // 用户会以为卡住了 —— 而这一格正是他最需要知道「在动」的时候。
    const ratio = Math.min(1, Math.max(0, (settled + running * 0.5) / total));
    bar.style.width = `${(ratio * 100).toFixed(1)}%`;

    label.textContent = labelOverride || `${UI.plot.bubbleProgress} ${settled}/${total}`;
    head.title = label.textContent;

    list.textContent = '';
    for (const row of ordered) {
      const line = doc.createElement('div');
      line.style.cssText = 'display:flex;align-items:baseline;gap:5px;min-width:0';
      const icon = doc.createElement('span');
      icon.textContent = row.state === 'running' ? '▶' : row.state === 'done' ? '✓' : '✕';
      icon.style.cssText = `flex:0 0 auto;width:10px;text-align:center;color:${
        row.state === 'running' ? '#7dd3fc' : row.state === 'done' ? '#86efac' : '#fca5a5'
      }`;
      const name = doc.createElement('span');
      name.textContent = row.name || '任务';
      name.style.cssText = 'flex:1 1 auto;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
      if (row.state === 'done') name.style.opacity = '.62';
      if (row.state === 'failed') name.style.color = '#fecaca';
      line.appendChild(icon);
      line.appendChild(name);
      if (row.stageTotal > 1) {
        const stage = doc.createElement('span');
        stage.textContent = `阶段 ${row.stage}/${row.stageTotal}`;
        stage.style.cssText = 'flex:0 0 auto;opacity:.55;font-size:11px';
        line.appendChild(stage);
      }
      list.appendChild(line);
    }
  };

  return {
    setText(text: string): void {
      labelOverride = text;
      label.textContent = text;
    },
    setProgress(info: BubbleProgress): void {
      const taskId = info.taskId || `${info.stage}:${info.taskName}:${info.index}`;
      rows.set(taskId, {
        taskId,
        name: info.taskName || '任务',
        stage: Math.max(1, Math.floor(info.stage) || 1),
        stageTotal: Math.max(1, Math.floor(info.stageTotal) || 1),
        index: Math.max(1, Math.floor(info.index) || 1),
        state: 'running',
      });
      totalTasks = Math.max(1, Math.floor(info.total) || 1);
      render();
    },
    settleTask(taskId: string, success: boolean): void {
      const row = rows.get(taskId);
      if (!row) return;
      row.state = success ? 'done' : 'failed';
      render();
    },
    close(): void {
      box.remove();
    },
  };
}

/** 等待期临时用户楼层的标记：纯 UI 节点，不进 chat 数组、不占楼号。 */
const VIRTUAL_FLOOR_ATTR = 'data-rh-plot-virtual-floor';
const VIRTUAL_FLOOR_STYLE_ID = 'rh-plot-virtual-floor-style';
const VIRTUAL_FLOOR_STYLE = [
  `.mes[${VIRTUAL_FLOOR_ATTR}] { pointer-events: none !important; }`,
  `.mes[${VIRTUAL_FLOOR_ATTR}] .mes_buttons,`,
  `.mes[${VIRTUAL_FLOOR_ATTR}] .mes_edit_buttons,`,
  `.mes[${VIRTUAL_FLOOR_ATTR}] .for_checkbox,`,
  `.mes[${VIRTUAL_FLOOR_ATTR}] .del_checkbox,`,
  `.mes[${VIRTUAL_FLOOR_ATTR}] .swipe_left,`,
  `.mes[${VIRTUAL_FLOOR_ATTR}] .swipe_right { display: none !important; }`,
].join('\n');

export interface PendingFloorHandle {
  /** 撤掉临时楼层（幂等）；真楼层不受影响。 */
  finish(): void;
}

/**
 * 「发送伪装」的等待外观：在聊天末尾插一条临时用户楼层，里面放用户原文。
 *
 * 照 ACU 1.3.6 `beginPlotVirtualPendingFloor_ACU` 的语义，只做用户楼这一条（AI 楼的
 * Thinking... 由进度气泡承担）：楼层克隆酒馆自己的 `#message_template .mes`，没有就
 * 克隆最近一条真实用户楼，再没有才用最小兜底结构；因此名字、头像、气泡样式都跟酒馆一致。
 * 节点不带 mesid，别的脚本按楼号查不到它；控件全部禁用，编辑/删除不会误伤真实楼层。
 * 造不出来时返回 null，调用方退回「解除伪装」等待方式（原文留在输入框），绝不把文字吞掉。
 */
function mountPendingUserFloor(doc: Document, text: string, onLost: () => void): PendingFloorHandle | null {
  const chat = doc.getElementById('chat');
  if (!chat) return null;
  let mes: HTMLElement | null = null;
  let style: HTMLStyleElement | null = null;
  let previousLast: HTMLElement | null = null;
  let timer: number | undefined;
  let finished = false;
  const view = doc.defaultView;

  const handle: PendingFloorHandle = {
    finish(): void {
      if (finished) return;
      finished = true;
      if (timer !== undefined) view?.clearInterval(timer);
      mes?.remove();
      style?.remove();
      // 气泡模式靠 last_mes 贴底：临时楼层撤掉后把标记还给原来那层。
      if (previousLast?.isConnected && !chat.querySelector('.mes.last_mes')) previousLast.classList.add('last_mes');
    },
  };

  try {
    const template = doc.querySelector<HTMLElement>('#message_template .mes');
    const realFloors = chat.querySelectorAll<HTMLElement>(`.mes[is_user="true"]:not([${VIRTUAL_FLOOR_ATTR}])`);
    const latestUser = realFloors.length > 0 ? realFloors[realFloors.length - 1] : null;
    const source = template ?? latestUser;
    if (source) {
      mes = source.cloneNode(true) as HTMLElement;
    } else {
      const holder = doc.createElement('div');
      holder.innerHTML = '<div class="mes" is_user="true"><div class="mesAvatarWrapper"><div class="avatar"><img src="" alt=""></div></div><div class="mes_block"><div class="ch_name"><span class="name_text"></span></div><div class="mes_text"></div></div></div>';
      mes = holder.firstElementChild as HTMLElement;
    }
    mes.removeAttribute('mesid');
    mes.removeAttribute('id');
    mes.setAttribute(VIRTUAL_FLOOR_ATTR, 'true');
    mes.setAttribute('is_user', 'true');
    mes.setAttribute('is_system', 'false');

    const name = latestUser?.getAttribute('ch_name') || latestUser?.querySelector('.name_text')?.textContent || '';
    if (name) {
      mes.setAttribute('ch_name', name);
      const nameText = mes.querySelector<HTMLElement>('.name_text');
      if (nameText) nameText.textContent = name;
    }

    // 正文用纯文本节点：按空行分段、单换行转 <br>，绝不把用户原文塞进 innerHTML。
    const body = mes.querySelector<HTMLElement>('.mes_text');
    if (!body) return null;
    body.replaceChildren(...text.split(/\n{2,}/).map(block => {
      const p = doc.createElement('p');
      block.split('\n').forEach((line, i) => {
        if (i) p.appendChild(doc.createElement('br'));
        p.appendChild(doc.createTextNode(line));
      });
      return p;
    }));
    // 克隆来的模板可能带着上一楼的序号 / 计时 / token 数，清掉。
    for (const sel of ['.mes_timer', '.tokenCounterDisplay', '.mesIDDisplay', '.timestamp']) {
      const el = mes.querySelector<HTMLElement>(sel);
      if (el) el.textContent = '';
    }

    style = doc.createElement('style');
    style.id = VIRTUAL_FLOOR_STYLE_ID;
    style.textContent = VIRTUAL_FLOOR_STYLE;
    doc.head.appendChild(style);

    previousLast = chat.querySelector<HTMLElement>('.mes.last_mes');
    previousLast?.classList.remove('last_mes');
    mes.classList.add('last_mes');
    chat.appendChild(mes);
    chat.scrollTop = chat.scrollHeight;

    // 宿主重绘聊天会把临时楼层摘掉：自动撤掉外观，通知调用方把原文放回输入框。
    if (view) {
      timer = view.setInterval(() => {
        if (mes && !mes.isConnected) {
          handle.finish();
          onLost();
        }
      }, 500);
    }
    return handle;
  } catch (error) {
    logWarn(TAG.plotGate, '临时用户楼层没造出来：这一轮退回「解除伪装」等待方式', error);
    handle.finish();
    return null;
  }
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

  /**
   * 自己按的那一下：在 `#send_but` 上打一次性标记，拦截器读到才放行并立刻清掉。
   * 不再用「布尔 + setTimeout(0) 时间窗口」——窗口外的第二次 click 会被当成新发送再跑一轮
   * （批 104 第 2 条现象 b：气泡还在跑、用户楼层已生成）。标记绑定那一下点击，与时间无关。
   */
  const SELF_SEND_ATTR = 'data-rh-plot-self-send';
  /** 诊断计数：本轮 `#send_but` 被点了几次，随前后两条日志一起落运行日志。 */
  let sendClickCount = 0;
  /** 正在跑剧情推进。 */
  let running = false;
  let abort: AbortController | null = null;
  let bubble: BubbleHandle | null = null;
  /** 等待期临时用户楼层（纯 UI）：默认「伪装开启」时挂，真楼层出现前撤掉。 */
  let pendingFloor: PendingFloorHandle | null = null;

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
    // 「解除发送伪装」只改等待外观（严格对齐 ACU 1.3.6）：
    // 默认（伪装开启）等待期间先在聊天里插一条临时用户楼层显示原文，输入框才暂时收起来；
    // 打开解除后不插临时楼层、原文一直留在输入框。两档都无条件显示进度气泡
    //（用户 m00139 第 3 条），发送契约也一致。
    const holdOriginal = plot.sendDisguiseDisabled !== true;
    let heldText: string | null = null;
    let delivered = false;

    bubble = mountBubble(doc, stopRun);

    try {
      if (holdOriginal) {
        pendingFloor = mountPendingUserFloor(doc, text, () => {
          // 宿主重绘把临时楼层摘掉了：按「解除伪装」方式继续，原文放回输入框。
          if (heldText !== null && !delivered) {
            logWarn(TAG.plotGate, '临时用户楼层被宿主重绘摘掉：原文已放回输入框，本轮按「解除伪装」方式继续');
            writeInput(heldText);
            heldText = null;
          }
        });
        if (pendingFloor) {
          heldText = text;
          writeInput('');
        }
        // 造不出来就不清输入框：宁可让原文一直留在框里，也不能出现「凭空消失」。
      }
      logInfo(TAG.plotGate, MSG.plotGateStart);
      // 锚点：这一条发出去后会占用的用户楼层号 = 真实最后一楼 + 1（不数页面气泡）。
      // 暂存账用它认领「同一条输入被跑了两版」的情况。
      const floorId = nextUserFloorId();
      if (floorId === null) {
        logWarn(TAG.plotGate, '读不到真实楼层号：这一轮不记暂存账、不写运行日志（绝不用页面气泡数凑数）');
      }
      const result = await appendPlotBlock(ctx, text, {
        floor: floorId === null ? null : { messageId: floorId, floorText: text },
        signal: abort.signal,
        // 正文只放最终注入指令（见文件头「三种结局」第 1 条）
        join: 'final',
        // 进度喂给气泡：阶段、任务名、第几个 / 共几个
        onTaskStart: (info) => bubble?.setProgress(info),
        // 跑完一个就把那一行标成完成/失败 —— 气泡要同时看得见所有任务的状态
        onTaskSettled: (result) => {
          if (result?.taskId) bubble?.settleTask(result.taskId, result.success === true);
        },
      });

      if (abort.signal.aborted) {
        logInfo(TAG.plotGate, MSG.plotGateStopped);
        return;
      }

      if (result.ok === false) {
        // 真跑过却没跑完：停在原地，别把没拼上剧情的原文发出去
        pageToastr()?.warning(result.note, UI.plot.bubbleTitle, { timeOut: TOAST_NOTICE_MS });
        logWarn(TAG.plotGate, result.note);
        return;
      }

      if (result.text === text) {
        // 这一轮没有任务要跑：原文原样发，不拼空块
        logInfo(TAG.plotGate, MSG.plotGateNoTask);
      }

      // 真楼层马上要出现：先撤掉临时用户楼层，否则会看到「文字出现→消失→楼层出现」的三连闪。
      pendingFloor?.finish();
      pendingFloor = null;
      writeInput(result.text);
      delivered = true;

      // 一次性标记绑在按钮上：只放行「这一下」，不再靠 setTimeout 的时间窗口。
      const $send = pageQuery()('#send_but');
      const btn = $send[0] ?? null;
      if (btn) btn.setAttribute(SELF_SEND_ATTR, '1');
      logInfo(
        TAG.plotGate,
        `替用户点发送（前）：按钮点击计数=${sendClickCount}，一次性标记=${btn ? '已打' : '没找到按钮'}，通行证余数=${pendingSendBypass()}`,
      );
      try {
        clickSend();
        logInfo(
          TAG.plotGate,
          `替用户点发送（后）：按钮点击计数=${sendClickCount}，一次性标记=${btn?.hasAttribute(SELF_SEND_ATTR) === true ? '还在' : '已消费'}，通行证余数=${pendingSendBypass()}`,
        );
        // 楼层是酒馆随后建的：等它出现后补写触发锚点（升级模式也要写）。
        // 不 await，写失败只记一笔，不能让已经发出去的消息显示成失败。
        const commit = result.commit;
        if (commit) {
          const mode = ctx.settings.plot.stashMode;
          void completePlotSend(commit, { mode, expectedText: result.text })
            .then((check) => {
              if (!check.landed) logWarn(TAG.plotGate, `楼层收尾没等到：${check.note}`);
              else if (check.plotCount !== 1) logWarn(TAG.plotGate, `楼层收尾异常：${check.note}`);
            })
            .catch((error) => logWarn(TAG.plotGate, '楼层收尾检查失败', error));
        }
      } finally {
        // 标记只能被「读到它的那一次点击」消费。若这轮压根没产生 click（按钮被移除 /
        // 被别的脚本挡掉），兜底清掉，免得残留到下一次真人点击把他放行。
        if (btn?.hasAttribute(SELF_SEND_ATTR)) {
          btn.removeAttribute(SELF_SEND_ATTR);
          logWarn(TAG.plotGate, '自己那一下没被点击监听器读到：一次性标记已兜底清除');
        }
      }
    } catch (error) {
      logWarn(TAG.plotGate, MSG.plotGateCrashed, error);
      pageToastr()?.error(MSG.plotGateCrashed, UI.plot.bubbleTitle, { timeOut: TOAST_NOTICE_MS });
    } finally {
      // 临时楼层是纯 UI 节点，无论哪一档结局都要撤掉，绝不留一条假用户楼在聊天里。
      pendingFloor?.finish();
      pendingFloor = null;
      // 伪装开启时原文只是被代管，失败 / 手动终止 / 崩了都要还回输入框（对齐 ACU 1.3.6：
      // 最终失败或手动终止均停止正文发送、原文留在输入框）。成功那档已写过最终注入指令。
      if (heldText !== null && !delivered) writeInput(heldText);
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
    const target = event.target as Element | null;
    const btn = target && typeof target.closest === 'function' ? target.closest('#send_but') : null;
    if (btn) {
      sendClickCount += 1;
      // 自己发的那一下：一次性标记在按钮上，读到才放行、立刻消费；与时间窗口无关。
      if (btn.hasAttribute(SELF_SEND_ATTR)) {
        btn.removeAttribute(SELF_SEND_ATTR);
        logInfo(TAG.plotGate, `放行自己按的那一下（第 ${sendClickCount} 次点击，标记已消费）`);
        return;
      }
    }
    if (!btn) return;
    // 别的流程（全流程重刷）提前打的通行证：只在「确实是发送按钮的点击」时消费。
    // 以前放在函数最前面，任何一次点击都会把通行证吃掉 —— 既可能让真人点击被误放行，
    // 也可能让真正该放行的那一下被拦下再跑一轮。
    if (consumeSendBypass()) return;
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

  // 只拦 #send_but 的 click，不单独拦输入框的 Enter（2026-11-16 第133次）。
  // Enter 发送、Ctrl+Enter 发送、手机发送键最终都会点到 #send_but，按钮这一层拦得住；
  // 手机软键盘的「换行」不会点到发送按钮，自然放行。不必猜 Enter 语义，也不读
  // power_user.send_on_enter（该字段读不到时曾把 Enter 直接放行，导致电脑端 Enter 发送绕过剧情推进）。
  doc.addEventListener('click', onClick, true);

  return () => {
    doc.removeEventListener('click', onClick, true);
    abort?.abort();
    pendingFloor?.finish();
    pendingFloor = null;
    bubble?.close();
    bubble = null;
    running = false;
    clearSendBypass();
    // 卸载时把可能残留的一次性标记也抹掉，别让重装后的第一次真人点击被放行。
    try {
      doc.querySelector(`#send_but[${SELF_SEND_ATTR}]`)?.removeAttribute(SELF_SEND_ATTR);
    } catch {
      // 页面正在被拆，取不到就算了。
    }
    ctx.state.locked = false;
  };
}
