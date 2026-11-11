/**
 * 「手动触发」楼层按钮（批 68 工位 D）。
 *
 * 在聊天页最新一条「渲染出来的」用户楼层底部挂一排按钮，每个启用且手动触发的
 * 任务一个按钮。点亮＝把该任务的锚点名写进预约表，熄灭＝从预约表移除；按钮
 * 自己不碰聊天变量，一律走 plot/manual-arm.ts 的两个整表读写口。
 *
 * 楼层号只从酒馆数据层取（getChatMessages + role），DOM 挂点按页面实际 mesid
 * 属性找；隐藏楼层没有气泡，从最新往前兜底找最近一条真渲染出来的用户楼层。
 * 找不到就不挂：不报错、不刷屏。跨 realm 一律按标签/属性判断，不做类型判断。
 */

import { UI } from '../copy';
import { pageQuery, pageToastr } from '../tavern';
import { readArmedTaskIds, setArmedTaskIds } from './manual-arm';

/** 装配方给的一个按钮所需数据：anchorName = anchorNameOf(预设名, 任务id)。 */
export interface ManualTaskView {
  id: string;
  name: string;
  anchorName: string;
}

/** 装配方注入的取数口：只回「启用 且 手动触发」的任务；读不到预设时抛错。 */
export interface ManualButtonDeps {
  listManualTasks(): ManualTaskView[];
  /** 总开关（运行中可能被设置面板改掉）；关着时只摘按钮、不动预约表。 */
  isEnabled?(): boolean;
}

/** 挂载后拿到的句柄：设置保存后调 refresh 立即重排，卸载时调 dispose。 */
export interface ManualButtonsHandle {
  refresh(): void;
  dispose(): void;
}

/** 数据层只取楼层号，按项目先例用窄接口（read 出来的行未必带全字段）。 */
interface UserFloorRow {
  message_id: number;
}

interface TaskSnapshot {
  tasks: ManualTaskView[];
  armed: string[];
}

const BAR_ATTR = 'data-rh-manual-bar';
const BAR_SELECTOR = '[data-rh-manual-bar]';
const CSS_ID = 'rh-manual-buttons-css';
const ARMED_CLASS = 'rh-manual-armed';
const RENDER_DEBOUNCE_MS = 300;

/**
 * 一次性注入样式，仿 modules/button.ts 的 ensureMotionCss：按 id 判重、挂 head、
 * 不卸载 CSS 节点。这里接口没有 instanceId，因此不调用 tagOwnedNode。
 * 底色与星点取自设置面板的「星空神庙」卡头（深蓝紫夜空 + 白色/紫水晶星点）；
 * 金色边框保留用户已确认的样式。
 */
function ensureManualCss(): void {
  const p$ = pageQuery();
  const css = `
[data-rh-manual-bar]{display:flex !important;flex-wrap:wrap;gap:8px;align-items:center;box-sizing:border-box !important;width:100%;margin-top:10px;}
[data-rh-manual-bar] .rh-manual-btn{position:relative;box-sizing:border-box;cursor:pointer;border:1px solid rgba(201,168,106,0.78);border-radius:8px;background-color:#2f2b4b;background-image:url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='120' height='60'><g fill='%23ffffff'><circle cx='8' cy='10' r='1' fill-opacity='0.8'/><circle cx='29' cy='5' r='0.7' fill-opacity='0.5'/><circle cx='51' cy='17' r='1.2' fill-opacity='0.9'/><circle cx='76' cy='8' r='0.6' fill-opacity='0.45'/><circle cx='101' cy='21' r='0.9' fill-opacity='0.7'/><circle cx='114' cy='6' r='0.6' fill-opacity='0.4'/><circle cx='16' cy='40' r='0.8' fill-opacity='0.55'/><circle cx='43' cy='49' r='1' fill-opacity='0.75'/><circle cx='68' cy='35' r='0.7' fill-opacity='0.45'/><circle cx='91' cy='46' r='1.1' fill-opacity='0.8'/><circle cx='111' cy='55' r='0.7' fill-opacity='0.5'/></g><g fill='%237b6fd6' fill-opacity='0.7'><circle cx='35' cy='30' r='1'/><circle cx='82' cy='24' r='0.8'/><circle cx='58' cy='56' r='0.9'/></g></svg>"),radial-gradient(150px 90px at 16% -20%,rgba(150,138,240,0.62),rgba(150,138,240,0) 68%),radial-gradient(130px 80px at 92% 120%,rgba(96,86,190,0.55),rgba(96,86,190,0) 70%),linear-gradient(100deg,#2c2a45 0%,#38335c 38%,#463d7e 68%,#332e52 100%);background-size:120px 60px,auto,auto,auto;background-repeat:repeat,no-repeat,no-repeat,no-repeat;color:#f7f3ea;font:inherit;font-size:1em;line-height:1.4;padding:7px 14px;letter-spacing:0.02em;text-shadow:0 1px 2px rgba(12,10,26,0.65),0 0 8px rgba(190,170,255,0.35);box-shadow:inset 0 1px 0 rgba(255,255,255,0.14),inset 0 0 12px rgba(123,111,214,0.18),0 1px 5px rgba(26,22,55,0.30);transition:box-shadow 0.2s ease,border-color 0.2s ease,color 0.2s ease;}
[data-rh-manual-bar] .rh-manual-btn:hover{border-color:#e8c47e;box-shadow:inset 0 1px 0 rgba(255,255,255,0.20),inset 0 0 16px rgba(150,130,255,0.26),0 0 10px rgba(201,168,106,0.35),0 2px 8px rgba(26,22,55,0.32);}
[data-rh-manual-bar] .rh-manual-btn:disabled{opacity:0.55;cursor:default;}
[data-rh-manual-bar] .rh-manual-btn.rh-manual-armed{color:#ffe9b8;border-color:#e8c47e;background-color:#37305f;box-shadow:inset 0 1px 0 rgba(255,255,255,0.22),inset 0 0 18px rgba(160,140,255,0.30),0 0 12px rgba(201,168,106,0.50),0 0 22px rgba(123,111,214,0.32);animation:rh-manual-breathe 1.8s ease-in-out infinite;}
@keyframes rh-manual-breathe{0%,100%{box-shadow:inset 0 1px 0 rgba(255,255,255,0.22),inset 0 0 16px rgba(160,140,255,0.24),0 0 8px rgba(201,168,106,0.36),0 0 16px rgba(123,111,214,0.24);}50%{box-shadow:inset 0 1px 0 rgba(255,255,255,0.26),inset 0 0 20px rgba(180,160,255,0.38),0 0 14px rgba(201,168,106,0.70),0 0 28px rgba(123,111,214,0.46);}}
@media (prefers-reduced-motion:reduce){[data-rh-manual-bar] .rh-manual-btn.rh-manual-armed{animation:none;}}
`;
  const existing = p$('#' + CSS_ID);
  if (existing.length > 0) {
    // 热重载时旧样式节点还在：覆盖而不是直接返回，避免刷新脚本后仍看到旧按钮样式。
    existing.html(css);
    return;
  }
  p$('<style></style>').attr('id', CSS_ID).html(css).appendTo('head');
}

/**
 * 找挂点：数据层拿全部用户楼层号，按页面 mesid 属性找第一条真渲染出来的。
 * 隐藏楼层不生成气泡，因此从最新往前兜底；整页没有 #chat 或一个气泡都没有时返回 null。
 */
function findLatestRenderedUserFloor(p$: JQueryStatic): JQuery<HTMLElement> | null {
  const $chat = p$('#chat');
  if ($chat.length === 0) return null;

  if (typeof getChatMessages !== 'function') return null;

  let rows: UserFloorRow[];
  try {
    rows = getChatMessages('0-{{lastMessageId}}', { role: 'user' }) as unknown as UserFloorRow[];
  } catch (error) {
    console.warn('[楼层按钮] 读不到用户楼层，本次不挂按钮', error);
    return null;
  }
  if (!Array.isArray(rows) || rows.length === 0) return null;

  const byMesId = new Map<string, JQuery<HTMLElement>>();
  $chat.children('.mes').each((_index, element) => {
    const mesid = element.getAttribute('mesid');
    if (mesid !== null) byMesId.set(mesid, p$(element) as JQuery<HTMLElement>);
  });
  if (byMesId.size === 0) return null;

  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (row === undefined) continue;
    const id = row.message_id;
    if (typeof id !== 'number' || !Number.isFinite(id)) continue;
    const $mes = byMesId.get(String(id));
    if ($mes !== undefined) return $mes;
  }
  return null;
}

/**
 * 渲染前清死预约：只渲染 live 名单里的任务，预约表里已不在 live 的锚点名整表写回清掉。
 * 取数失败只记日志、按钮照常渲染（预约是状态，显示不依赖它）；不吞异常。
 */
function readSnapshot(deps: ManualButtonDeps): TaskSnapshot | null {
  let tasks: ManualTaskView[];
  try {
    tasks = deps.listManualTasks();
  } catch (error) {
    console.warn('[楼层按钮] 读手动任务名单失败，本次不挂按钮', error);
    return null;
  }
  if (!Array.isArray(tasks)) return null;

  const live = new Set(tasks.map(task => task.anchorName));
  let armed: string[];
  try {
    armed = readArmedTaskIds();
    const kept = armed.filter(anchorName => live.has(anchorName));
    if (kept.length !== armed.length) {
      setArmedTaskIds(kept);
      armed = kept;
    }
  } catch (error) {
    console.warn('[楼层按钮] 读写预约表失败，按钮仍按名单渲染', error);
    armed = [];
  }
  return { tasks, armed };
}

/**
 * 点一下：读全表 → 该任务在表里就移除、不在就加入 → 整表写回 → 只更新这个按钮
 * 的发光状态。写表期间按钮 disabled 防重入；写回成功才提示，避免失败误报。
 */
function handleClick(event: JQuery.Event, task: ManualTaskView, $button: JQuery<HTMLElement>): void {
  event.stopPropagation();
  if ($button.prop('disabled') === true) return;
  $button.prop('disabled', true);
  try {
    const armed = readArmedTaskIds();
    const index = armed.indexOf(task.anchorName);
    const isArmed = index >= 0;
    const next = isArmed
      ? armed.filter((_id, position) => position !== index)
      : armed.concat(task.anchorName);
    setArmedTaskIds(next);
    $button.toggleClass(ARMED_CLASS, !isArmed);
    if (isArmed) pageToastr().info(UI.plot.manualToastDisarmed(task.name));
    else pageToastr().success(UI.plot.manualToastArmed(task.name));
  } catch (error) {
    console.error('[楼层按钮] 写预约表失败', error);
  } finally {
    $button.prop('disabled', false);
  }
}

/**
 * 挂楼层按钮。返回句柄：refresh 用于设置保存后立即重排，dispose 接卸载通道。
 */
export function mountManualButtons(deps: ManualButtonDeps): ManualButtonsHandle {
  ensureManualCss();

  let disposed = false;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  const observer = new MutationObserver(() => {
    scheduleRender();
  });

  /** 每次渲染前断开、渲染后重连：容器增删本身不会把自己再触发一遍。 */
  function attachObserver(): void {
    if (disposed) return;
    const chat = pageQuery()('#chat')[0];
    if (chat === undefined) return;
    try {
      observer.observe(chat, { childList: true, subtree: true });
    } catch (error) {
      console.warn('[楼层按钮] 挂聊天区变动监听失败', error);
    }
  }

  function scheduleRender(): void {
    if (disposed) return;
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      render();
    }, RENDER_DEBOUNCE_MS);
  }

  function render(): void {
    if (disposed) return;
    observer.disconnect();
    try {
      const p$ = pageQuery();
      // 幂等：先删掉所有旧容器（含别的实例残留），防重复挂。
      p$(BAR_SELECTOR).remove();

      // 总开关关着：按钮不该出现，但预约表原样留着（用户可能只是暂时关掉）。
      if (deps.isEnabled && !deps.isEnabled()) return;

      const snapshot = readSnapshot(deps);
      if (snapshot === null) return;
      const $floor = findLatestRenderedUserFloor(p$);
      if ($floor === null) return;
      if (snapshot.tasks.length === 0) return;

      const armedSet = new Set(snapshot.armed);
      const $bar = p$('<div></div>').attr(BAR_ATTR, '1');
      for (const task of snapshot.tasks) {
        const $button = p$('<button></button>')
          .attr('type', 'button')
          .addClass('rh-manual-btn')
          .toggleClass(ARMED_CLASS, armedSet.has(task.anchorName))
          .text(task.name);
        $button.on('click', event => {
          handleClick(event, task, $button);
        });
        // 按钮按下不冒泡到楼层自身的手势（仿 plot/send-gate.ts:188）。
        $button.on('pointerdown mousedown touchstart', event => {
          event.stopPropagation();
        });
        $bar.append($button);
      }
      $floor.append($bar);
    } finally {
      // 切聊天后当下读不到楼层也要重挂监听：重连后 DOM 一落地就会再触发渲染。
      attachObserver();
    }
  }

  const offs = [
    eventOn(tavern_events.MESSAGE_SENT, () => scheduleRender()),
    eventOn(tavern_events.MESSAGE_RECEIVED, () => scheduleRender()),
    eventOn(tavern_events.MESSAGE_UPDATED, () => scheduleRender()),
    eventOn(tavern_events.MESSAGE_EDITED, () => scheduleRender()),
    eventOn(tavern_events.MESSAGE_DELETED, () => scheduleRender()),
    eventOn(tavern_events.CHAT_CHANGED, () => scheduleRender()),
  ];

  render();
  console.info('[楼层按钮] 已挂载');

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    observer.disconnect();
    for (const off of offs) {
      try {
        off.stop();
      } catch (error) {
        console.warn('[楼层按钮] 卸掉事件监听失败', error);
      }
    }
    pageQuery()(BAR_SELECTOR).remove();
    console.info('[楼层按钮] 已卸载');
  };

  return { refresh: scheduleRender, dispose };
}
