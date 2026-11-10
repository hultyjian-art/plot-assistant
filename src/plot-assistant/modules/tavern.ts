/**
 * 页面访问辅助模块。
 * 把"跨 iframe 拿酒馆那边的 jQuery / toastr / SillyTavern"这类动作收在一处，
 * 其余模块不直接碰 window.parent。
 */
import type { RerushWindow, TavernContextLike, TavernLike } from './types';

function hostWindow(win: Window): RerushWindow {
  return win as RerushWindow;
}

/** 脚本自己所在的窗口。 */
function selfWindow(): RerushWindow {
  // node 里（对照测试直接 require 本模块）没有 window，取它会直接 ReferenceError。
  // 返回空壳让调用方照常走「拿不到就降级」的分支，而不是把整个测试套件炸掉。
  if (typeof window === 'undefined') return {} as RerushWindow;
  return hostWindow(window);
}

/** 酒馆页面所在的父窗口。 */
export function parentWindow(): RerushWindow {
  // 同 selfWindow：node 里没有 window.parent，返回空壳让调用方降级。
  if (typeof window === 'undefined') return {} as RerushWindow;
  return hostWindow(window.parent);
}

/** 作用于酒馆页面的 jQuery（脚本 iframe 里的 $ 选不到宿主 DOM）。 */
export function pageQuery(): JQueryStatic {
  return parentWindow().$ || selfWindow().$ || $;
}

/** 酒馆页面的 toastr 实例。 */
export function pageToastr(): typeof toastr {
  return parentWindow().toastr || selfWindow().toastr || toastr;
}

/** SillyTavern 全局对象；先找当前窗口，再找父窗口。 */
export function tavernGlobal(): TavernLike | null {
  return selfWindow().SillyTavern || parentWindow().SillyTavern || null;
}

/** 酒馆助手挂出的全局对象；先找当前窗口，再找父窗口。 */
export function helperGlobal(): RerushWindow['TavernHelper'] | undefined {
  return selfWindow().TavernHelper || parentWindow().TavernHelper;
}

/**
 * 酒馆原生宏替换：`<user>` / `{{user}}` / `<char>` / `{{char}}` / `{{persona}}` 等
 * 都交给酒馆助手的 `substitudeMacros` 处理（它背后就是 SillyTavern 的 substituteParams）。
 *
 * 取不到接口时原样返回：脚本在没有酒馆的环境里（比如单元测试）也要能跑；
 * 替换失败不能把整轮提示词弄丢。
 */
export function substituteTavernMacros(text: string): string {
  if (!text) return text;
  const helper = helperGlobal();
  const helperReplace =
    typeof helper?.substitudeMacros === 'function'
      ? (input: string) => helper.substitudeMacros!(input)
      : null;
  const context = helperReplace ? null : stContext();
  const contextReplace =
    typeof context?.substituteParams === 'function'
      ? (input: string) => context.substituteParams!(input)
      : null;
  const replace = helperReplace ?? contextReplace;
  if (replace === null) return text;
  try {
    const result = replace(text);
    return typeof result === 'string' ? result : text;
  } catch (error) {
    console.warn('[剧情推进助手] 酒馆宏替换失败，按原文发送', error);
    return text;
  }
}

/**
 * 提示词模板的三段处理链，与工作流助手 `template-process.ts` 保持一致：
 *
 * ```
 * formatAsTavernRegexedString（酒馆正则 + ST 宏 + 全部 MacroLike）
 *   → EjsTemplate.prepareContext + evaltemplate
 *   → formatAsTavernRegexedString 再来一遍
 * ```
 *
 * 为什么要跑两遍宏：第一遍先把 `{{user}}` / `{{char}}` 这类同时长得像内部标签的宏换掉；
 * EJS 执行后可能又带出宏，最后再兜一遍。EJS 只在原文或第一遍结果里出现 `<%` 时才执行，
 * 没装提示词模板插件的用户行为完全不变。
 */
export type TavernPromptMacroSource = 'user_input' | 'ai_output' | 'slash_command' | 'world_info' | 'reasoning';

/** 当前最新楼层 id；拿不到时返回 undefined，不抛异常。 */
export function currentMessageId(): number | undefined {
  const helper = helperGlobal();
  try {
    if (typeof helper?.getLastMessageId === 'function') return helper.getLastMessageId();
  } catch {
    // 酒馆没就绪时某些版本会抛；交给调用方降级。
  }
  return undefined;
}

/** 酒馆助手宏开关（`extensionSettings.tavern_helper.macro.enabled`，兼容旧键）。 */
function tavernHelperMacroEnabled(): boolean {
  const settings = stContext()?.extensionSettings;
  if (!settings || typeof settings !== 'object') return true;
  const helperSettings = (settings as { tavern_helper?: unknown; TavernHelper?: unknown }).tavern_helper
    ?? (settings as { tavern_helper?: unknown; TavernHelper?: unknown }).TavernHelper;
  if (!helperSettings || typeof helperSettings !== 'object') return true;
  const macro = (helperSettings as { macro?: unknown }).macro;
  if (!macro || typeof macro !== 'object') return true;
  const enabled = (macro as { enabled?: unknown }).enabled;
  return typeof enabled === 'boolean' ? enabled : true;
}

/**
 * 单遍宏替换：酒馆助手宏开着时走 `formatAsTavernRegexedString`（它会应用酒馆正则、
 * ST 宏和全部 MacroLike）；关掉时只走 `substitudeMacros`。接口缺失或抛错都退回
 * `substitudeMacros`，保证老版本酒馆也能用。
 */
function applyTavernPromptMacros(
  text: string,
  source: TavernPromptMacroSource,
  messageId?: number,
): string {
  if (!text) return text;
  if (!tavernHelperMacroEnabled()) return substituteTavernMacros(text);

  const helper = helperGlobal();
  const formatter = helper?.formatAsTavernRegexedString;
  if (typeof formatter !== 'function') return substituteTavernMacros(text);

  try {
    const lastId = currentMessageId();
    const depth = lastId !== undefined && messageId !== undefined ? Math.max(0, lastId - messageId) : undefined;
    const result = formatter(text, source, 'prompt', depth === undefined ? undefined : { depth });
    return typeof result === 'string' ? result : text;
  } catch (error) {
    console.warn('[剧情推进助手] 酒馆正则/宏处理失败，退回 substitudeMacros', error);
    return substituteTavernMacros(text);
  }
}

/** 提示词模板语法插件（当前窗口或父窗口都认）。 */
function ejsTemplateApi(): RerushWindow['EjsTemplate'] | null {
  return selfWindow().EjsTemplate ?? parentWindow().EjsTemplate ?? null;
}

/** 只处理一次 EJS；插件缺失、接口缺失或执行抛错都保留原文。 */
async function applyEjsTemplate(text: string, messageId?: number): Promise<string> {
  const api = ejsTemplateApi();
  if (!api) return text;
  const prepare = typeof api.prepareContext === 'function' ? api.prepareContext.bind(api) : null;
  const runner = typeof api.evaltemplate === 'function'
    ? api.evaltemplate.bind(api)
    : typeof api.evalTemplate === 'function'
      ? api.evalTemplate.bind(api)
      : null;
  if (!runner) return text;
  try {
    const context = prepare ? await prepare({}, messageId) : {};
    const result = await runner(text, context);
    return typeof result === 'string' ? result : text;
  } catch (error) {
    console.warn('[剧情推进助手] EJS 模板处理失败，按原文保留', error);
    return text;
  }
}

/**
 * 对一段提示词文本执行酒馆宏与 EJS 模板处理。
 *
 * 返回 Promise 是必须的：`EjsTemplate.evaltemplate` 是异步接口；调用方在真实发送、
 * 预览和最终注入模板三处都要 `await`。
 */
export async function processTavernTemplateText(
  text: string,
  source: TavernPromptMacroSource = 'slash_command',
  options: { messageId?: number } = {},
): Promise<string> {
  if (!text) return text;
  const messageId = options.messageId ?? currentMessageId();
  const firstPass = applyTavernPromptMacros(text, source, messageId);
  const afterEjs = text.includes('<%') || firstPass.includes('<%')
    ? await applyEjsTemplate(firstPass, messageId)
    : firstPass;
  return applyTavernPromptMacros(afterEjs, source, messageId);
}

/**
 * 酒馆上下文（`SillyTavern.getContext()` 的返回值）。
 * 取不到、或这版酒馆的 getContext 抛错时返回 null——调用方负责降级。
 */
export function stContext(): TavernContextLike | null {
  const tavern = tavernGlobal();
  if (!tavern || typeof tavern.getContext !== 'function') return null;
  try {
    return tavern.getContext() ?? null;
  } catch {
    return null;
  }
}

/** AI 是否正在输出：停止按钮可见或发送按钮隐藏都算。 */
export function aiIsStreaming(): boolean {
  const p$ = pageQuery();
  return p$('#stop_but').is(':visible') || p$('#send_but').is(':hidden');
}

/**
 * 输入框里是否留着没发出去的草稿。
 * 原生重刷要求输入框为空，删层流程也怕踩到没发出的内容；
 * 判定逻辑集中在此，避免各模块各写一遍。
 */
export function hasDraft(): boolean {
  return String(pageQuery()('#send_textarea').val() ?? '').trim() !== '';
}

/**
 * 用户是否正在编辑某个历史楼层。
 * 三种呈现都算：楼层自带编辑框、编辑取消按钮、QR 区编辑器展开。
 * 编辑态下删楼会让酒馆停在半完成状态，所以此时一律拒绝动作。
 */
export function historyEditOpen(): boolean {
  const p$ = pageQuery();
  const editBoxShown = p$('.mes_edit_box:visible, .mes_edit_textarea:visible, .edit_textarea:visible').length > 0;
  const editCancelShown = p$('.mes_edit_cancel:visible, .qr--editor-cancel:visible').length > 0;
  const qrEditorShown = p$('#qr--editor:visible').length > 0;
  return editBoxShown || editCancelShown || qrEditorShown;
}

/** 宿主窗口/上下文里可能挂着人设与角色卡的几个位置（酒馆不同版本不一样）。 */
interface IdentitySource {
  powerUserSettings?: { persona_description?: unknown };
  power_user?: { persona_description?: unknown };
  characters?: Record<string, unknown>;
  this_chid?: number;
  characterId?: number;
  name2_description?: unknown;
}

function identityText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function identityView(value: unknown): IdentitySource {
  return value && typeof value === 'object' ? (value as IdentitySource) : {};
}

/** 当前角色卡数据：优先酒馆助手接口，兜到宿主窗口/上下文里的 characters 表。 */
function currentCharacterData(): Record<string, unknown> | null {
  const helper = helperGlobal() as unknown as { getCharData?: (name: string) => unknown } | undefined;
  try {
    if (typeof helper?.getCharData === 'function') {
      const data = helper.getCharData('current');
      if (data && typeof data === 'object') return data as Record<string, unknown>;
    }
  } catch {
    // 酒馆没就绪时某些版本会抛；继续往下找。
  }
  const sources = [identityView(parentWindow()), identityView(stContext()), identityView(tavernGlobal())];
  for (const source of sources) {
    const table = source.characters;
    if (!table || typeof table !== 'object') continue;
    const id = source.characterId ?? source.this_chid;
    const found = id === undefined ? null : table[String(id)];
    if (found && typeof found === 'object') return found as Record<string, unknown>;
  }
  return null;
}

/**
 * 一轮提示词里的 `$U`（用户人设）与 `$C`（当前角色卡描述）。
 *
 * 取数顺序照 ACU 的 `getPersonaDescription_ACU` / `getCharDescription_ACU`：
 * 人设看 `powerUserSettings` / `power_user`，角色卡看 `getCharData('current')` 并
 * 兜到 `name2_description`。任何一步拿不到都给空串，不把整轮提示词弄丢。
 */
export function readRoundIdentity(): { userPersona: string; characterCard: string } {
  const sources = [identityView(stContext()), identityView(tavernGlobal()), identityView(parentWindow())];

  let userPersona = '';
  try {
    for (const source of sources) {
      const value = source.powerUserSettings?.persona_description ?? source.power_user?.persona_description;
      const text = identityText(value);
      if (text !== '') {
        userPersona = text;
        break;
      }
    }
  } catch (error) {
    console.warn('[剧情推进助手] 读取用户人设失败，$U 按空串处理', error);
  }

  let characterCard = '';
  try {
    const character = currentCharacterData();
    const nested = character?.data as { description?: unknown } | undefined;
    characterCard =
      identityText(character?.description) ||
      identityText(nested?.description) ||
      sources.map(source => identityText(source.name2_description)).find(text => text !== '') ||
      '';
  } catch (error) {
    console.warn('[剧情推进助手] 读取当前角色卡描述失败，$C 按空串处理', error);
  }

  return { userPersona, characterCard };
}

/**
 * 当前角色卡的稳定标识 —— 世界书写入联动的比对键用（2026-11-07 批 37 用户定：
 * 切角色卡也要跟着换，而酒馆没有干净的「切卡」事件，只能在每次对账时比对）。
 *
 * 取哪个字段：头像文件名最稳（同一张卡改名后不变），名字其次，最后兜到上下文里的
 * 卡下标。三样都拿不到就给空串 —— 空对空不算「换了卡」，宁可不触发重算也别误清。
 */
export function readCharacterKey(): string {
  try {
    const character = currentCharacterData() as { avatar?: unknown; name?: unknown } | null;
    const avatar = identityText(character?.avatar).trim();
    if (avatar !== '') return avatar;
    const name = identityText(character?.name).trim();
    if (name !== '') return name;
  } catch {
    // 酒馆没就绪时某些版本会抛；往下兜。
  }
  const view = identityView(stContext()) as { characterId?: unknown; this_chid?: unknown };
  const id = view.characterId ?? view.this_chid;
  return id === undefined || id === null ? '' : String(id);
}
