/**
 * plot/eng/prompt-blocks.ts — 提示词块的独立开关与跨任务/跨预设复制（纯函数）
 *
 * 这是需求二①②。上游 ACU 的提示词编辑面板只能整段改，`promptGroup` 是一锅端：
 * 想临时关掉其中一段，只能删掉再手记原文。这一层给每块加一个 `enabled`，
 * 并把「复制到另一个任务/预设」做成一次纯数据搬运。
 *
 * 三条约定：
 * - **`enabled` 缺省视为开**。上游数据里根本没有这个字段，所以默认行为与现在完全一致；
 *   只有显式写 `false` 才算关。
 * - **关掉的块不参与渲染**，但仍然留在数据里 —— 这样用户随时能打开，不用重贴原文。
 * - **复制必须换 id**。块 id 是面板上的 React 键、也是「精确关闭某块」的凭据；
 *   直接搬原 id 会让两个任务里出现同一个 id，改一个连带改另一个。
 *
 * 这一层不碰 UI，也不碰存储；块开关的判定、计数、挪位由渲染层和面板共用，
 * 免得每处各写一遍 `=== false` 慢慢走样。
 */

/** 提示词块的最小形状：`role` / `content` 是上游就有的，这里再补几个面板要用的可选键。 */
export interface PromptBlockLike {
  role?: string;
  content?: string;
  /** 段身份；上游老数据可能没有，缺失时靠下标。 */
  id?: string;
  /** 面板上显示的名字，纯展示用。 */
  name?: string;
  /** 缺省视为开 —— 上游没有这个字段，必须保持向后兼容。 */
  enabled?: boolean;
}

export interface BlockSelection {
  /** 按位置选（从 0 开始） */
  indices?: number[];
  /** 按 id 选 */
  ids?: string[];
}

/**
 * 这块要不要渲染。只有显式 `false` 才算关。
 * 参数取 `unknown`：渲染层的 `PlotPromptSegment` 用索引签名装 `enabled`，
 * 面板草稿则是明确的 `boolean`；两边都能直接传，调用点不必写类型断言。
 */
export function isBlockEnabled(block: unknown): boolean {
  if (block === null || block === undefined || typeof block !== 'object') return false;
  return (block as { enabled?: unknown }).enabled !== false;
}

/** 只留下要渲染的块，顺序不变。 */
export function filterEnabledBlocks<T extends PromptBlockLike>(blocks: T[] | null | undefined): T[] {
  const list = Array.isArray(blocks) ? blocks.filter((block): block is T => Boolean(block)) : [];
  return list.filter(isBlockEnabled);
}

/** 按位置开关一块。返回新数组；越界原样返回（不抛、不补块）。 */
export function setBlockEnabled<T extends PromptBlockLike>(blocks: T[], index: number, enabled: boolean): T[] {
  const list = Array.isArray(blocks) ? [...blocks] : [];
  const at = Math.floor(Number(index));
  if (!Number.isFinite(at) || at < 0 || at >= list.length) return list;
  const block = list[at];
  if (!block) return list;
  if (!enabled) {
    list[at] = { ...block, enabled: false };
    return list;
  }
  // 重新打开 = **删掉字段**，而不是写 `true`：缺省即开，写 true 会让「用户显式打开」与
  // 「上游数据从来没有这个键」变得无法区分。
  const next = { ...block } as T & { enabled?: boolean };
  delete next.enabled;
  list[at] = next as T;
  return list;
}

/** 统计：总块数与开着几块。面板上要用「3/5 块已启用」这种说法。 */
export function countBlocks(blocks: PromptBlockLike[] | null | undefined): { total: number; enabled: number } {
  const list = Array.isArray(blocks) ? blocks.filter(Boolean) : [];
  return { total: list.length, enabled: list.filter(isBlockEnabled).length };
}

/**
 * 取出一批块，做成「剪贴板」内容（深拷贝 + 换新 id）。
 *
 * 选择规则：给了 `ids` 就按 id 挑，否则按 `indices`，都没给就整段复制。
 * 无论怎么挑，输出顺序都跟**原数组顺序**一致 —— 用户看到的是「按原来的次序搬过去」。
 */
export function copyBlocks(blocks: PromptBlockLike[] | null | undefined, selection?: BlockSelection): PromptBlockLike[] {
  const list = Array.isArray(blocks) ? blocks.filter(Boolean) : [];
  const idSet = new Set((selection?.ids || []).filter(id => typeof id === 'string' && id));
  const indexSet = new Set(
    (selection?.indices || []).map(n => Math.floor(Number(n))).filter(n => Number.isFinite(n) && n >= 0),
  );
  const useIds = idSet.size > 0;
  const useIndices = !useIds && indexSet.size > 0;

  const picked: PromptBlockLike[] = [];
  list.forEach((block, index) => {
    if (useIds) {
      if (typeof block.id === 'string' && idSet.has(block.id)) picked.push(cloneBlock(block));
      return;
    }
    if (useIndices) {
      if (indexSet.has(index)) picked.push(cloneBlock(block));
      return;
    }
    picked.push(cloneBlock(block));
  });

  return picked;
}

/**
 * 把剪贴板里的块插进目标任务。
 *
 * `at` 超出范围就夹到两端。插入的块会**再换一次 id**（相对目标已有的 id 去重），
 * 这样同一份剪贴板可以往同一个任务里粘两次而不打架。
 */
export function insertBlocks<T extends PromptBlockLike>(
  target: T[] | null | undefined,
  incoming: PromptBlockLike[] | null | undefined,
  at?: number,
): T[] {
  const base = Array.isArray(target) ? target.filter(Boolean) : [];
  const additions = Array.isArray(incoming) ? incoming.filter(Boolean) : [];
  const from = Math.min(Math.max(0, Number.isFinite(Number(at)) ? Math.floor(Number(at)) : base.length), base.length);

  if (!additions.length) return [...base];

  const used = new Set(base.map(block => block.id).filter((id): id is string => typeof id === 'string' && Boolean(id)));
  const placed: T[] = [];
  for (const block of additions) {
    const copy = cloneBlock(block) as T;
    const baseId = typeof copy.id === 'string' && copy.id ? copy.id : 'block';
    let candidate = baseId;
    let n = 2;
    while (used.has(candidate)) {
      candidate = `${baseId}-${n}`;
      n += 1;
    }
    used.add(candidate);
    copy.id = candidate;
    placed.push(copy);
  }

  return [...base.slice(0, from), ...placed, ...base.slice(from)];
}

/** 在同一个任务里挪块（面板拖拽）。越界原样返回。 */
export function moveBlock<T extends PromptBlockLike>(blocks: T[], from: number, to: number): T[] {
  const list = Array.isArray(blocks) ? [...blocks] : [];
  const a = Math.floor(Number(from));
  const b = Math.floor(Number(to));
  if (!Number.isFinite(a) || !Number.isFinite(b)) return list;
  if (a < 0 || a >= list.length) return list;
  const target = Math.min(Math.max(0, b), list.length - 1);
  if (a === target) return list;
  const [picked] = list.splice(a, 1);
  list.splice(target, 0, picked);
  return list;
}

/**
 * 深拷贝一块并给它一个「复制品」id。
 *
 * 只拷贝已知字段（`role` / `content` / `id` / `name` / `enabled` 及其余自有键），
 * 用展开而不是 `JSON.parse(JSON.stringify())` —— 后者会把 `undefined` 键抹掉，
 * 让「显式写了 undefined」与「没写」变得无法区分（`boolField` 那一族就靠这个区别）。
 */
function cloneBlock(block: PromptBlockLike): PromptBlockLike {
  const copy: PromptBlockLike = { ...block };
  if (typeof copy.id === 'string' && copy.id) copy.id = `${copy.id}-copy`;
  return copy;
}
