/**
 * 剧情推进 — 用户输入哈希
 *
 * 用途：把「本轮用户输入」变成一个稳定短串，写进楼层的 `_qrf_plot_pending_hash`，
 * 下一轮靠它把结果认领回正确的那一层。**哈希算错 → 认领错层 → 剧情错位，且不报错。**
 *
 * 三条必须照抄的性质（都有用例）：
 *  1. 空输入给空串（不是"空串的哈希"）。
 *  2. 先 `trim`，再把 `\r\n` 与 `\r` 统一成 `\n` —— 所以「同一句话、不同换行」算同一层。
 *  3. 32 位混合算术**不能换成 `>>> 0` 或 `Math.imul` 版本**：原式靠 JS 位运算的符号行为产生
 *     负值/大值，`toString(36)` 出来的字符串（可能带 `-`）也是契约的一部分。
 */
export function hashUserInput(text: string): string {
  if (!text) return '';
  const normalized = String(text).trim().replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  let hash = 2166136261;
  for (let i = 0; i < normalized.length; i += 1) {
    hash ^= normalized.charCodeAt(i);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  return hash.toString(36);
}
