/**
 * 核心动作模块。
 * - runNativeRefresh：原生重刷，等价于酒馆自己的"重新生成"
 * - runRerushFlow：全流程重刷 / 回填修改
 *   取文：默认取最新用户楼层；开了「AI楼层模式」则换成它上方的最近一条 AI 楼层。
 *         按设置里的顺序级联尝试捕获预设，首个成功的生效
 *   删层：不论取文来自哪一层，都从最新用户楼层一直删到末尾，
 *         优先走酒馆的增量删除（不重载整个对话）
 *   发送：删完立刻真实点击发送按钮（走完整 DOM 事件，卡片的发送意图钩子才看得见），中间不经过任何定时器
 */
import { pageQuery, pageToastr, tavernGlobal, stContext, aiIsStreaming, historyEditOpen, hasDraft, parentWindow } from './tavern';
import { flashRejected, releaseLock } from './feedback';
import { findScriptButton } from './script-button';
import { latestAiFloorBefore, locateLatestUserFloor } from './safety';
import { captureWithPresets } from './regex';
import { profile } from './profile';
import { logInfo, logWarn } from './logger';
import { MSG, TAG } from './copy';
import { NATIVE_SETTLE_MS } from './constants';
import { appendPlotBlock } from './plot/run-in-flow';
import type { PlotAppendResult } from './plot/run-in-flow';
import { mountBubble } from './plot/send-gate';
import { resolveChatKey } from './plot/chat-key';
import { completePlotSend } from './plot/after-send';
import { armSendBypass } from './plot/send-bypass';
import type { DeletePath, RerushContext, SendPath } from './types';

/** 页面上"重新生成"这个按钮可能出现的文字（中文固定，英文忽略大小写）。 */
function isRegenerateLabel(text: string): boolean {
  return text === '重新生成' || text.toLowerCase() === 'regenerate';
}

/**
 * 原生重刷：三条路径按可靠性从高到低依次尝试。
 * 返回是否真的把重刷下达出去了。
 */
export async function runNativeRefresh(ctx: RerushContext): Promise<boolean> {
  const p$ = pageQuery();
  const $btn = findScriptButton();
  logInfo(TAG.action, MSG.nativeBegin);

  const refuse = (reason: string): boolean => {
    logInfo(TAG.gate, reason);
    // 拿不到按钮时也必须解锁：否则 ctx.state.locked 会一直挂着，手势模块从此不再响应任何按压
    if ($btn) releaseLock(ctx, $btn);
    else ctx.state.locked = false;
    flashRejected(ctx, $btn ?? undefined);
    return false;
  };

  if (historyEditOpen()) return refuse(MSG.blockedByEditingBrief);
  if (hasDraft()) return refuse(MSG.blockedByNotEmptyBox);
  if (aiIsStreaming()) return refuse(MSG.blockedWhileGenerating);

  // 换插头放在闸门之后：被拦下的一轮不应该白换一次插头

  let triggered = false;

  try {
    const $native = p$('#option_regenerate');
    if ($native.length > 0) {
      $native.click();
      logInfo(TAG.action, MSG.nativeByDomId);
      triggered = true;
    }

    if (!triggered) {
      const $labeled = p$('body')
        .find('div, span, a, button')
        .filter((_index, element) => {
          const $el = p$(element);
          return $el.css('display') !== 'none' && isRegenerateLabel($el.text().trim());
        });
      if ($labeled.length > 0) {
        $labeled.first().trigger('mousedown').trigger('click');
        logInfo(TAG.action, MSG.nativeByTextMatch);
        triggered = true;
      }
    }

    if (!triggered) {
      const tavern = tavernGlobal();
      const context = tavern?.getContext();
      if (context && typeof context.generate === 'function') {
        context.generate('regenerate');
        logInfo(TAG.action, MSG.nativeByLowLevelApi);
        triggered = true;
      }
    }

    if (!triggered) logWarn(TAG.action, MSG.nativeEveryPathMissed);
  } catch (e) {
    logWarn(TAG.action, MSG.nativeCrashed, e);
  } finally {
    window.setTimeout(() => {
      if ($btn) releaseLock(ctx, $btn);
      else ctx.state.locked = false;
    }, NATIVE_SETTLE_MS);
  }

  return triggered;
}

/** 把文本塞进酒馆输入框，并补一次 input 事件让它自己重算高度。 */
function putIntoInputBox(text: string): void {
  const p$ = pageQuery();
  const $box = p$('#send_textarea');
  $box.val(text).trigger('input');
  $box.css('height', 'auto').css('height', `${$box[0]?.scrollHeight ?? 0}px`);
}

/** 从目标用户楼层到最后一层（含两端）的楼层号列表。 */
function floorRangeToDelete(fromMessageId: number): number[] {
  const lastId = getLastMessageId();
  const ids: number[] = [];
  for (let id = fromMessageId; id <= lastId; id++) {
    ids.push(id);
  }
  return ids;
}

/**
 * 删除目标楼层到末尾，返回实际走了哪条路。
 * 首选酒馆的增量删除：改数组 + 摘掉对应 DOM 块 + 一次后端补丁，不碰其它楼层的显示。
 * 这版酒馆没导出该接口时才退回酒馆助手的全量重载——重载要把整个聊天重新渲染一遍，
 * 长聊天里动辄好几秒，"文本在输入框干等着不出发"主要就是它。
 */
async function deleteFloorsToTail(ids: number[]): Promise<DeletePath> {
  const context = stContext();
  if (context && typeof context.deleteMessages === 'function') {
    await context.deleteMessages(ids);
    return '增量';
  }

  // refresh:'all' 会让酒馆走整体重载。连续区间删除若用默认的 'affected'，
  // 已删楼层的 DOM 块会被指向不存在的楼层号并抛错，AI 楼层就残留在界面上。
  await deleteChatMessages(ids, { refresh: 'all' });
  return '重载';
}

/**
 * 替用户把输入框里的内容发出去，返回走了哪条路。
 * 一定要走"真实点击发送按钮"：卡片自带的数据库脚本在 #send_but 上以捕获阶段挂了
 * click / pointerup / touchend 钩子（输入框还有 Enter keydown 钩子），用它记下的
 * "用户发送意图"去判定剧情推进要不要触发；直调 context.sendTextareaMessage 不产生任何
 * DOM 事件，那道门控就会把这轮判成"用户消息直接写入聊天"而整段跳过。
 * 点击是同步派发，不依赖定时器，所以页面切到后台照样发得出去——要治的从来不是点击，是等待。
 */
function issueSend(): SendPath {
  const $send = pageQuery()('#send_but');
  if ($send.length > 0) {
    $send.trigger('mousedown').click();
    return '按钮';
  }

  const context = stContext();
  if (context && typeof context.sendTextareaMessage === 'function') {
    // 兜底：界面上找不到发送按钮时才直调。不 await——这个 promise 要到 AI 输出结束才落地
    void context.sendTextareaMessage().catch((e) => logWarn(TAG.post, MSG.sendCrashed, e));
    return '接口';
  }

  return '落空';
}

/** autoSend 为真走全流程重刷，为假走回填修改。 */
export async function runRerushFlow(ctx: RerushContext, autoSend: boolean): Promise<void> {
  const toast = pageToastr();
  const $btn = findScriptButton();
  const { toast: wantToast } = ctx.settings.look;
  // 记住开跑时的聊天：剧情推进要跑好几秒，中途用户完全可能已经切到别的角色卡。
  const startedChatKey = resolveChatKey(ctx.state.chatKey);
  // 气泡上的「终止」用它中断这一轮；abort 的判定放在 try 外面，catch 里也要认它。
  const abort = new AbortController();
  logInfo(TAG.action, autoSend ? MSG.fullBegin : MSG.fillBegin);

  const target = locateLatestUserFloor(ctx);
  if (!target) {
    if ($btn) releaseLock(ctx, $btn);
    return;
  }

  const presets = ctx.settings.presets;
  if (presets.length === 0) {
    logInfo(TAG.gate, MSG.blockedNoPreset);
    if (wantToast) toast?.error(MSG.toastNoPreset, '', { timeOut: 5000 });
    flashRejected(ctx, $btn ?? undefined);
    if ($btn) releaseLock(ctx, $btn);
    return;
  }

  // 取文来源：默认就是刚定位到的用户楼层；开了 AI 楼层模式则换成它上方的最近一条 AI 楼层
  // （不含用户楼层之后的楼层——那条正是本次要重刷掉的 AI 回复）。
  // 删层起点一律用 target——这个模式只换"从哪层拿文本"，不换"从哪层开始删"。
  const fromAiFloor = ctx.settings.capture.fromAiFloor;
  const captureFloor = fromAiFloor ? latestAiFloorBefore(target.messageId) : target;
  if (!captureFloor) {
    logInfo(TAG.grab, MSG.blockedNoAiFloor);
    if (wantToast) toast?.error(MSG.toastNoAiFloor, '', { timeOut: 6000 });
    flashRejected(ctx, $btn ?? undefined);
    if ($btn) releaseLock(ctx, $btn);
    return;
  }
  logInfo(
    TAG.grab,
    fromAiFloor
      ? MSG.captureSourceAi(captureFloor.messageId, target.messageId)
      : MSG.captureSourceUser(target.messageId),
  );

  logInfo(TAG.grab, MSG.cascadeBegin(presets.map((preset) => preset.name)));
  const captured = captureWithPresets(captureFloor.message.message, presets);
  if (!captured) {
    logInfo(TAG.grab, MSG.cascadeEveryMiss(presets.length));
    if (wantToast) toast?.error(MSG.toastCascadeMiss(presets.length), '', { timeOut: 6000 });
    flashRejected(ctx, $btn ?? undefined);
    if ($btn) releaseLock(ctx, $btn);
    return;
  }

  try {
    logInfo(TAG.grab, MSG.captured(captured.order, captured.preset.name, captured.text));

    // 回填修改只做「捞原文 → 填框 → 删层」，一个 AI 请求都不发。
    // 长按的语义是把刚才那段话捞回来改，推进等他改完发出去时自然会跑；
    // 这里再跑一轮的话，按住稍久的人看到的就是「点一下却开跑了」，还白花一次 token。
    let plotResult: PlotAppendResult | null = null;

    if (autoSend) {
      // 剧情推进（总开关默认关）：开了就在发送前跑一轮，把结果拼在原文后面。
      // 把「这一轮锚在哪一层」一并递进去：暂存账靠它认领，续跑靠它找上次的进度。
      //
      // join 必须显式写 final：这条消息是发给主 AI 的，用户原话已经通过任务提示词里的
      // $8 进了这一轮的输入，再拼一遍就是同一段话读两遍（用户 2026-11-03 报的
      // 「最终注入之前又注入一次原文」）。send-gate 那条路一直传的是 final，这里漏了。
      //
      // 这几轮 AI 请求要跑十几秒，只把按钮变灰的话用户分不清"在跑"和"卡死了"，
      // 所以挂一条和发送拦截同款的进度气泡，上面的「终止」能中断这一轮。
      const doc: Document = parentWindow().document ?? document;
      const bubble = mountBubble(doc, () => abort.abort());
      plotResult = await appendPlotBlock(ctx, captured.text, {
        floor: { messageId: target.messageId, floorText: target.message.message },
        join: 'final',
        signal: abort.signal,
        // 跟发送拦截那条路一样，把「第几个任务 / 叫什么」喂给气泡
        onTaskStart: (info) => bubble.setProgress(info),
      }).finally(() => bubble.close());

      // 跑这几秒里用户可能已经换了聊天：target.messageId 指的是上一个聊天里的楼层，
      // 再往下走会把上一轮的最终指令注进新聊天、还会删掉新聊天的楼层。
      if (resolveChatKey(ctx.state.chatKey) !== startedChatKey) {
        logWarn(TAG.post, MSG.plotChatSwitched);
        if (wantToast) toast?.warning(MSG.plotChatSwitched, '', { timeOut: 8000 });
        if ($btn) releaseLock(ctx, $btn);
        return;
      }

      // 用户按了气泡上的「终止」：停在原地，不写输入框、不删楼层、不发送
      if (abort.signal.aborted) {
        logInfo(TAG.action, MSG.plotStoppedByUser);
        if (wantToast) toast?.warning(MSG.plotStoppedByUser, '', { timeOut: 6000 });
        if ($btn) releaseLock(ctx, $btn);
        return;
      }
      if (ctx.settings.plot.enabled) {
        if (plotResult.ok) logInfo(TAG.grab, `剧情推进完成：${plotResult.note}`);
        else {
          // 失败也要留一行日志：只弹 toast 的话，等用户回头翻「运行日志」会发现一片干净，
          // 看不出这一轮到底跑没跑、为什么没成。
          logWarn(TAG.grab, `剧情推进未完成：${plotResult.note}`);
          if (wantToast) toast?.warning(`剧情推进未完成：${plotResult.note}`, '', { timeOut: 5000 });
        }
      }

      // 跑过但没跑完：停在原地。不删楼层、不发送 —— 这一层还留着，下次点发送才能认出
      // 「同一层、同一段话、还欠几个任务」，接着跑（`plot/stash-flow.ts`）。
      // 原文放回输入框，用户想放弃推进只需要关掉开关再发。
      if (plotResult.blocking) {
        putIntoInputBox(plotResult.text);
        logWarn(TAG.post, `已停在原地：${plotResult.note}`);
        if (wantToast) toast?.warning(`剧情推进没跑完，已停在原地；再点一次会接着跑`, '', { timeOut: 8000 });
        if ($btn) releaseLock(ctx, $btn);
        return;
      }
    }

    // 回填修改没有推进结果，填回去的就是正则从楼层里捞出来的原文
    putIntoInputBox(plotResult ? plotResult.text : captured.text);

    // 只有真要发请求时才换插头：全流程重刷会替用户按下发送，回填修改不发

    const ids = floorRangeToDelete(target.messageId);
    const tailFloor = ids[ids.length - 1];
    logInfo(TAG.del, MSG.deleteRange(target.messageId, tailFloor, ids.length));
    if (wantToast) toast?.warning(MSG.toastDeleteRange(target.messageId, tailFloor, ids.length), '', { timeOut: 4000 });

    const deletedBy = await deleteFloorsToTail(ids);
    logInfo(TAG.del, MSG.deleted(deletedBy));

    if (autoSend) {
      // 这一次是我们自己发的：给拦截器打个招呼，否则它会把这一下当成用户新发的一条、
      // 再跑一轮剧情（白花钱，还会把同一段输入跑成两版）。
      armSendBypass();
      // 删完即发：从手势到请求发出，这条链上只有删层那一次后端保存在等
      const sentBy = issueSend();
      logInfo(TAG.post, MSG.sendCommandIssued(sentBy));
      if (sentBy === '落空') {
        if (wantToast) toast?.error(MSG.toastSendMissed, '', { timeOut: 8000 });
      } else {
        if (wantToast) toast?.success(MSG.toastSent, '', { timeOut: 5000 });
        // 楼层是酒馆随后建的，所以写回要等它出现。**不 await**：这条链已经结束，
        // 写回失败了也只能记一笔，不能让用户以为消息没发出去。
        const commit = plotResult?.commit;
        if (commit) {
          const mode = ctx.settings.plot.stashMode;
          void completePlotSend(commit, { mode })
            .then((check) => {
              // 升级模式下「没写 qrf」是正常收场，不该报成异常；真正的异常是正文里
              // 的 <plot> 不是恰好一段（0 段 = 被别的脚本截走，2 段 = 上游也开着）。
              if (mode !== 'qrf' && check.plotCount === 1) {
                logInfo(TAG.post, `楼层收尾：${check.note}`);
                return;
              }
              if (check.written && check.plotCount === 1) logInfo(TAG.post, `楼层写回完成：${check.note}`);
              else logWarn(TAG.post, `楼层写回异常：${check.note}`);
              if ((!check.written || check.plotCount !== 1) && wantToast) {
                toast?.warning(`剧情推进写回：${check.note}`, '', { timeOut: 7000 });
              }
            })
            .catch((error) => logWarn(TAG.post, '楼层写回检查失败', error));
        }
      }
    } else {
      logInfo(TAG.action, MSG.filledForManualEdit);
      if (wantToast) toast?.success(MSG.toastFilled, '', { timeOut: 5000 });
    }

    // 立刻解锁：再挂一个定时器解锁的话，页面一转到后台就会被浏览器压住，
    // 按钮从此灰着不动，等你回到酒馆才有反应。发出去之后重复的手势由"输入框有草稿"那道闸门拦下。
    if ($btn) releaseLock(ctx, $btn);
  } catch (e) {
    if (abort.signal.aborted) {
      logInfo(TAG.action, MSG.plotStoppedByUser);
      if (wantToast) toast?.warning(MSG.plotStoppedByUser, '', { timeOut: 6000 });
      if ($btn) releaseLock(ctx, $btn);
      return;
    }
    const reason = e instanceof Error ? e.message : String(e);
    logWarn(TAG.action, MSG.flowAborted(reason), e);
    if (wantToast) toast?.error(MSG.flowAborted(reason), '', { timeOut: 8000 });
    flashRejected(ctx, $btn ?? undefined);
    if ($btn) releaseLock(ctx, $btn);
  }
}
