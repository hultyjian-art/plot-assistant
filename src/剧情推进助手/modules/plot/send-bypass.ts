/**
 * 「这一次发送是我们自己发的」通行证。
 *
 * 为什么需要它：发送拦截装在 `document` 捕获阶段，只要用户（或别的流程）点 `#send_but`
 * 就会被拦下跑一轮剧情。但**手势重刷**这条路本来就已经跑过剧情了 —— 它把结果写进输入框、
 * 再调 `issueSend()` 真点按钮，如果没有人打招呼，拦截器会把这次点击当成用户新发的一条，
 * 再跑一轮：既多花一次钱，也会把同一段输入跑成两版。
 *
 * 所以自己发之前先 `armSendBypass()`，拦截器看到就放行一次。用计数而不是布尔：
 * 连点两下时不会被第一下把标记吃掉、第二下又被拦。
 */
let pending = 0;

/** 声明「下一次真点发送不要拦我」。 */
export function armSendBypass(): void {
  pending += 1;
}

/** 拦截器在放行前问一次：还有没有没用完的通行证。 */
export function consumeSendBypass(): boolean {
  if (pending <= 0) return false;
  pending -= 1;
  return true;
}

/** 卸载/重装时清空，避免上一条残留的通行证放走用户的真实点击。 */
export function clearSendBypass(): void {
  pending = 0;
}
