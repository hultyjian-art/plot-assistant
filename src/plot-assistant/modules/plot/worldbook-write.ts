/**
 * plot/worldbook-write.ts — 标签块写入世界书（2026-11-07 批 36-38 用户定）
 *
 * 一轮剧情推进落盘后，把规则选中的标签块写成世界书条目（默认角色卡绑定的世界书），
 * 让「大包裹」拆成「一张便条 + 书架上的资料」。条目的「有没有、有哪些」跟着聊天走：
 *
 * - 账本记在**聊天变量**里（与暂存区同一处、按 `resolveChatKey()` 分家）；
 * - 每次对账时比对「当前聊天 + 当前角色卡」：键变了就按当前账本重算 ——
 *   先清掉认领的托管条目，再按账本重放。新聊天账本空 → 重放为空 →
 *   角色卡世界书里自然没有上一聊天的条目（用户批 36 的核心要求）；
 *   切回旧聊天 → 旧账本还在 → 条目自动恢复。
 *
 * 与工作流助手的差别（都是有意为之）：
 * - 账本不放楼层 `message.data`，放聊天变量；不搬删楼重算、滑楼回放那套全家桶；
 * - 清理入口是**两个按钮**（只清当前角色卡 / 清本机所有世界书），不是一个「清理全部」；
 * - 认领口径 = **当前规则推导出的完整条目名**（前缀 + 条目名），不按前缀模糊匹配、
 *   不在账本里记实际用过的名字（批 38 用户明确否决了记名方案：改名就失效、
 *   改回来又生效，后果玩家自己承担，脚本不做任何改名兼容）。
 *
 * 与「不加防御代码」的边界（批 36 §4.6）：这里只管「写入 + 联动」这一条新通路，
 * **不看**用户楼层最终注入指令里有没有同一个 `{{标签}}` —— 两边是否重复由写预设的人避重。
 */

import { resolveChatKey } from './chat-key';
import { resolveChatStateStore } from './data/chat-vars';
import { PLOT_WB_WRITE_PREFIX } from './data/worldbook-hits';
import { buildTagBlock, hasContent, lookupTag } from './eng/tags';
import { createWbWriteLedger, type WbWriteLedger } from './state';
import { collectTextTagMap } from './stash-edit';
import { readCharacterKey } from '../tavern';
import { resolveWorldbookBooks } from './worldbook-select';
import type { PlotSettings, PlotWorldbookWriteRule, RerushContext } from '../types';

/** 条目插入位置默认值：照工作流助手抄的（批 36 用户定：系统深度 / 深度 2 / 顺序 10000）。 */
export const WB_DEFAULT_DEPTH = 2;
export const WB_DEFAULT_ORDER = 10000;

/** 规则的条目名兜底：没填（或填了空白）就用标签名。 */
function entryNameOf(rule: PlotWorldbookWriteRule): string {
  return (rule.entryName || rule.tagName).trim();
}

/** 完整条目名 = 固定前缀 + 条目名。规则没有可用名字时给空串（调用方跳过）。 */
export function plotWbFullEntryName(rule: PlotWorldbookWriteRule): string {
  const base = entryNameOf(rule);
  return base === '' ? '' : PLOT_WB_WRITE_PREFIX + base;
}

/** 只认合格的位置数：脏值退回工作流助手的默认，别让一个 0 把条目钉到最顶上。 */
function safeDepth(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1 ? Math.floor(value) : WB_DEFAULT_DEPTH;
}
function safeOrder(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : WB_DEFAULT_ORDER;
}

function rulesOf(plot: PlotSettings): PlotWorldbookWriteRule[] {
  return Array.isArray(plot.worldbookWriteRules) ? plot.worldbookWriteRules : [];
}

/**
 * 认领名单：**全部**规则（启用 + 停用）推导出的完整条目名。
 *
 * 停用规则的名字也要认领 —— 停用 = 不再写这条，下次重算时它的旧条目该被清掉；
 * 内容留在账本里，重新启用后下一次重算会按旧内容恢复。
 */
export function claimedEntryNames(rules: PlotWorldbookWriteRule[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const rule of rules) {
    const name = plotWbFullEntryName(rule);
    if (name === '' || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

/** 一条真正要落进世界书的条目。 */
export interface WbWritePlanItem {
  /** 规则选的标签名（账本里按它对内容） */
  tagName: string;
  /** 完整条目名（前缀 + 条目名） */
  name: string;
  /** 条目内容：与楼层正文同款的 `<标签>…</标签>` 整块 */
  content: string;
  depth: number;
  order: number;
}

/**
 * 规则 + 内容表 → 真正要写的条目清单。
 *
 * 只写「启用且账本里有内容」的规则；同名条目去重（两条规则指到同一个条目名时只写一份）。
 */
export function planWorldbookWrites(
  rules: PlotWorldbookWriteRule[],
  contents: Record<string, string>,
): WbWritePlanItem[] {
  const lowered = new Map<string, string>();
  for (const [name, content] of Object.entries(contents)) {
    if (typeof content === 'string' && content.trim() !== '') lowered.set(name.toLowerCase(), content);
  }

  const out: WbWritePlanItem[] = [];
  const seen = new Set<string>();
  for (const rule of rules) {
    if (rule.enabled !== true) continue;
    const name = plotWbFullEntryName(rule);
    if (name === '' || seen.has(name)) continue;
    const content = contents[rule.tagName] ?? lowered.get(rule.tagName.toLowerCase()) ?? '';
    if (content.trim() === '') continue;
    seen.add(name);
    out.push({ tagName: rule.tagName, name, content, depth: safeDepth(rule.depth), order: safeOrder(rule.order) });
  }
  return out;
}

/**
 * 把一轮推进聚合出的标签按规则挑出来，拼成与楼层正文同款的块。
 *
 * 用 `lookupTag`（精确匹配 → 大小写不敏感兜底）与楼层拼装同一套口径，
 * 账本里记的就是真正写进条目的那份内容。
 */
export function collectLandingContents(
  rules: PlotWorldbookWriteRule[],
  aggregatedTags: Map<string, string[] | string> | null | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!(aggregatedTags instanceof Map)) return out;
  for (const rule of rules) {
    if (rule.enabled !== true) continue;
    if (plotWbFullEntryName(rule) === '') continue;
    const resolved = lookupTag(aggregatedTags, rule.tagName);
    if (!resolved.found || !hasContent(resolved.value)) continue;
    const block = buildTagBlock(rule.tagName, resolved.value);
    if (block.trim() === '') continue;
    out[rule.tagName] = block;
  }
  return out;
}

// ───────────────────────── 以下碰酒馆全局（世界书接口） ─────────────────────────

/** 角色卡绑定的书：主书 + 附加书（清理按钮按这个范围清）。写入目标只取主书，见 resolveWriteTargetBooks。读不到给空表。 */
function readCharacterBooks(): string[] {
  try {
    const names = getCharWorldbookNames('current');
    return [names.primary ?? '', ...(names.additional ?? [])].filter(
      (name): name is string => typeof name === 'string' && name.trim() !== '',
    );
  } catch (error) {
    console.warn('[剧情推进助手] 读角色卡绑定的世界书失败（写入目标按空处理）', error);
    return [];
  }
}

/** 世界书架上现在有哪些书。读不到给空表。 */
function readShelf(): string[] {
  try {
    const names = getWorldbookNames();
    return Array.isArray(names) ? names.filter((name): name is string => typeof name === 'string' && name.trim() !== '') : [];
  } catch (error) {
    console.warn('[剧情推进助手] 读世界书列表失败（写入目标按空处理）', error);
    return [];
  }
}

/** 写入目标书：character = 角色卡的主要知识书（只写主书）；manual = 勾选且还存在的书（取舍规则只有这一份）。 */
async function resolveWriteTargetBooks(plot: PlotSettings): Promise<string[]> {
  // 「跟随角色卡」只写主要知识书：附加书不写，primary 为空时目标为空（一本不写，保持静默）。
  // 收窄只在这里做；readCharacterBooks() 本体仍是「主书 + 附加书」，清理按钮靠它清掉历史误写。
  let characterBooks: string[];
  if (plot.worldbookWriteSource === 'manual') {
    // 手动档取舍只看勾选项与书架，共用纯函数的 manual 分支不会读 characterBooks
    characterBooks = readCharacterBooks();
  } else {
    try {
      const primary = getCharWorldbookNames('current').primary;
      characterBooks = typeof primary === 'string' && primary.trim() !== '' ? [primary] : [];
    } catch (error) {
      console.warn('[剧情推进助手] 读角色卡主要知识书失败（写入目标按空处理）', error);
      characterBooks = [];
    }
  }
  return resolveWorldbookBooks(
    { source: plot.worldbookWriteSource, books: Array.isArray(plot.worldbookWriteBooks) ? plot.worldbookWriteBooks : [] },
    characterBooks,
    readShelf(),
  );
}

/** 托管条目的固定形状：蓝灯常驻（资料要永远在场）+ 系统深度 + 防递归（批 36 照抄工作流助手）。 */
function managedEntry(item: WbWritePlanItem): Partial<WorldbookEntry> {
  return {
    name: item.name,
    enabled: true,
    strategy: {
      type: 'constant',
      keys: [],
      keys_secondary: { logic: 'and_any', keys: [] },
      scan_depth: 'same_as_global',
    },
    position: { type: 'at_depth', role: 'system', depth: item.depth, order: item.order },
    content: item.content,
    probability: 100,
    // 「防止递归触发」默认开启（批 36）：托管的资料块不该再被世界书递归扫出别的条目。
    recursion: { prevent_incoming: true, prevent_outgoing: true, delay_until: null },
  };
}

/**
 * 一本书内的「清 + 写」一次做完。
 *
 * 先读一遍：没有任何要改的就不动这本书（省得每轮都白重写一次书文件）；
 * 确实要改才走 `updateWorldbookWith` —— 认领的条目里，要重写的原地更新（保 uid），
 * 不重写的删掉，同名重复的顺手并成一份；要补建的在末尾追加。
 *
 * @returns 这本书里实际改动的条目数（删 + 更新 + 新建）
 */
async function syncBookEntries(book: string, writes: WbWritePlanItem[], claimed: string[]): Promise<number> {
  let entries: WorldbookEntry[];
  try {
    entries = await getWorldbook(book);
  } catch (error) {
    console.warn(`[剧情推进助手] 读世界书失败，跳过这本书的写入：${book}`, error);
    return 0;
  }

  const writeByName = new Map(writes.map(item => [item.name, item]));
  const claimedSet = new Set(claimed);
  let changed = 0;
  const seen = new Set<string>();
  const next: Array<Partial<WorldbookEntry>> = [];

  for (const entry of entries) {
    const name = String(entry.name ?? '').trim();
    if (!claimedSet.has(name)) {
      next.push(entry);
      continue;
    }
    // 认领名单上的：要重写就原地更新（第一份），其余（不重写的、重复的）清掉。
    const write = writeByName.get(name);
    if (write && !seen.has(name)) {
      seen.add(name);
      next.push({ ...entry, ...managedEntry(write) });
    }
    changed += 1;
  }
  for (const item of writes) {
    if (seen.has(item.name)) continue;
    seen.add(item.name);
    next.push(managedEntry(item));
    changed += 1;
  }

  if (changed === 0) return 0;
  try {
    await updateWorldbookWith(book, () => next, { render: 'debounced' });
  } catch (error) {
    console.warn(`[剧情推进助手] 写世界书失败：${book}`, error);
    return 0;
  }
  return changed;
}

/**
 * 同步主流程：读账本 → 对比对键 → 清 + 重放 → 记账。
 *
 * 全程只动「认领名单上的条目」和「本聊天的账本」，用户手写条目一个不碰；
 * 任何一步失败都只记日志不抛出 —— 世界书写入是辅助通路，不能拖累推进本身。
 *
 * @param ctx 脚本上下文（读设置与聊天键）
 * @param freshContents 这一轮新产出的内容（`null` = 只是例行对账，不并入新内容）
 */
async function runWorldbookSync(ctx: RerushContext, freshContents: Record<string, string> | null): Promise<void> {
  const plot = ctx.settings.plot;
  const rules = rulesOf(plot);
  const chatKey = resolveChatKey(ctx.state.chatKey);
  const charKey = readCharacterKey();

  // ── 读账本，顺带对一次比对键（聊天 + 角色卡，批 37 用户定） ──
  const store = resolveChatStateStore();
  const loaded = store.loadWbWriteLedger();
  if (loaded.warning === 'wb_write_unreadable') {
    console.warn('[剧情推进助手] 世界书写入账本读坏了，按空账处理（原文已备份到坏数据位）');
  }
  let ledger: WbWriteLedger = loaded.ledger ?? createWbWriteLedger(chatKey, charKey);
  if (ledger.chatKey !== chatKey || ledger.charKey !== charKey) {
    // 聊天被复制 / 改名（或同一个聊天换了张卡打开）：账里的书名与内容属于另一个比对键，
    // 按空账重算。旧条目留在书里走手动清理，不在这里猜谁是谁。
    console.info(
      `[剧情推进助手] 世界书账本比对键变化（${ledger.chatKey || '空'}/${ledger.charKey || '空'} → ` +
        `${chatKey || '空'}/${charKey || '空'}），按空账重算`,
    );
    ledger = createWbWriteLedger(chatKey, charKey);
  }

  // ── 内容：账本里留底的，并上这一轮的新产出 ──
  const contents: Record<string, string> = { ...ledger.contents };
  if (freshContents !== null) {
    for (const [tag, block] of Object.entries(freshContents)) contents[tag] = block;
  }

  const claimed = claimedEntryNames(rules);
  const writes = planWorldbookWrites(rules, contents);

  // ── 无事可做：没规则可认领、也没内容可写，把账本盖回当前键就走 ──
  if (claimed.length === 0 && writes.length === 0) {
    if (ledger.books.length > 0 || Object.keys(contents).length > 0 || loaded.ledger === null) {
      ledger.books = [];
      ledger.contents = contents;
      ledger.chatKey = chatKey;
      ledger.charKey = charKey;
      store.saveWbWriteLedger(ledger);
    }
    return;
  }

  // ── 涉及的书 = 账本里记的（上一轮写过的）∪ 当前目标书 ──
  // 前者保证「换过目标书 / 手动模式之后」旧书里的条目也被清到；
  // 后者保证新目标书里的旧条目先清后写。
  const targetBooks = await resolveWriteTargetBooks(plot);
  const involved = [...new Set([...ledger.books, ...targetBooks])];
  const targetSet = new Set(targetBooks);

  let changed = 0;
  for (const book of involved) {
    // 只往当前目标书写；账本里记的旧书只清不写
    changed += await syncBookEntries(book, targetSet.has(book) ? writes : [], claimed);
  }

  // ── 记账：这一轮之后，只有目标书里可能还有我们的条目 ──
  ledger.books = targetBooks;
  ledger.contents = contents;
  ledger.chatKey = chatKey;
  ledger.charKey = charKey;
  store.saveWbWriteLedger(ledger);
  console.info(
    `[剧情推进助手] 世界书写入完成：条目 ${writes.length} 条（认领 ${claimed.length} 个名字），` +
      `动了 ${changed} 条，涉及 ${involved.length} 本书`,
  );
}

// ───────────────────────── 对外入口（全部串行进同一支队列） ─────────────────────────

/** 世界书操作串行队列：两次同步并发跑会在同一本书里各建一套条目，必须排队。 */
let syncChain: Promise<void> = Promise.resolve();

function enqueueSync<T>(task: () => Promise<T>): Promise<T> {
  const run = syncChain.then(task);
  // 队列本身永不断链：单个任务的失败留给调用方处理，不堵后面的
  syncChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * 例行对账（不写新内容）：脚本启动、切聊天、每轮开跑前各调一次。
 *
 * 比对键没变时它也安全 —— 没有要改的条目就不会动世界书（见 `syncBookEntries` 的免写短路）。
 */
export function enqueueWorldbookCheck(ctx: RerushContext): void {
  if (!ctx.settings.plot.enabled) return;
  void enqueueSync(() => runWorldbookSync(ctx, null)).catch((error) => {
    console.warn('[剧情推进助手] 世界书例行对账失败', error);
  });
}

/**
 * 一轮推进成功落盘后调用：把这一轮产出的标签块按规则写进世界书。
 *
 * 后台排队执行，不阻塞楼层发送；写失败了也只记日志（下一轮落盘会再写一遍）。
 *
 * @param aggregatedTags 这一轮聚合出的全部标签（引擎的 `aggregatedTags`，含续跑补齐的）
 */
export function enqueueWorldbookLanding(
  ctx: RerushContext,
  aggregatedTags: Map<string, string[] | string> | null | undefined,
): void {
  const plot = ctx.settings.plot;
  if (!plot.enabled) return;
  const rules = rulesOf(plot);
  if (rules.length === 0) return;
  const fresh = collectLandingContents(rules, aggregatedTags);
  void enqueueSync(() => runWorldbookSync(ctx, fresh)).catch((error) => {
    console.warn('[剧情推进助手] 世界书写入失败', error);
  });
}

/**
 * 暂存区编辑同步（2026-11-08 批 45 用户定）：面板把「使用中」的那一版改完保存、
 * 或把某一版切到楼层（应用）成功后调用，把这一版文本里的规则标签块并进账本重放。
 *
 * 口径（批 45 四问拍板）：
 * - **只同步正在使用的版本** —— 世界书跟楼层里正在生效的那份走；改旧版只落暂存账，
 *   免得没在用的一版被注进世界书。
 * - 编辑后的文本里被删掉的标签块**不萷新内容**，账本里留的旧内容照常重放 ——
 *   世界书条目保留（缺口提示会重跑补回这块，补回后落盘钩子自然覆盖）。
 * - 与落盘钩子同一个合并语义：这一版有的标签覆盖账本同名内容，其余标签不动。
 *
 * 后台排队执行（与落盘写入同一支队列）；文本里没有规则标签时 fresh 为空，
 * 走一遍重放也无害（没有要改的条目就不会动书文件）。
 */
export function enqueueWorldbookStashText(ctx: RerushContext, text: string): void {
  const plot = ctx.settings.plot;
  if (!plot.enabled) return;
  const rules = rulesOf(plot);
  if (rules.length === 0) return;
  const fresh = collectLandingContents(rules, collectTextTagMap(text));
  void enqueueSync(() => runWorldbookSync(ctx, fresh)).catch((error) => {
    console.warn('[剧情推进助手] 暂存区编辑同步世界书失败', error);
  });
}

/** 两个清理按钮共用的返回。 */
export interface WbCleanupResult {
  /** 实际删到条目的书 */
  books: string[];
  /** 删掉的条目总数 */
  deleted: number;
}

/**
 * 「只清理当前角色卡的」（批 36 用户定）。
 *
 * 范围 = 角色卡绑定的书（主书 + 附加书）；认领 = **当前规则推导出的完整条目名**。
 * 玩家手动自选、且不属于角色卡绑定的书不在这档 —— 要清那些请用 `cleanupAllWorldbooks`。
 */
export async function cleanupCurrentCardWorldbooks(rules: PlotWorldbookWriteRule[]): Promise<WbCleanupResult> {
  const claimed = claimedEntryNames(rules);
  const byClaimedName = (name: string): boolean => claimed.includes(name);
  return cleanupBooks(readCharacterBooks(), byClaimedName, '当前角色卡的世界书');
}

/**
 * 「清理本机所有世界书的」（批 36 用户定）。
 *
 * 范围 = `getWorldbookNames()` 全部书；认领 = **前缀** `plot_assistant-` ——
 * 按名字认领兜不住改名 / 删规则留下的孤儿，按前缀扫才扫得干净（批 38 用户定）。
 */
export async function cleanupAllWorldbooks(): Promise<WbCleanupResult> {
  const byPrefix = (name: string): boolean => name.startsWith(PLOT_WB_WRITE_PREFIX);
  return cleanupBooks(readShelf(), byPrefix, '本机全部世界书');
}

/** 两个按钮共用的执行体：逐本删 → 清本聊天的账本 → 记日志。只走自己的队列，不碰别的。 */
async function cleanupBooks(books: string[], match: (name: string) => boolean, label: string): Promise<WbCleanupResult> {
  return enqueueSync(async () => {
    const touched: string[] = [];
    let deleted = 0;
    for (const book of books) {
      try {
        const { deleted_entries } = await deleteWorldbookEntries(
          book,
          entry => match(String(entry.name ?? '').trim()),
          { render: 'debounced' },
        );
        if (Array.isArray(deleted_entries) && deleted_entries.length > 0) {
          deleted += deleted_entries.length;
          touched.push(book);
        }
      } catch (error) {
        console.warn(`[剧情推进助手] 清理世界书失败：${book}`, error);
      }
    }
    // 条目删了，本聊天的账也从头记：账本里留的内容已经没有对应的条目了
    try {
      resolveChatStateStore().saveWbWriteLedger(createWbWriteLedger(resolveChatKey(), readCharacterKey()));
    } catch (error) {
      console.warn('[剧情推进助手] 清空世界书写入账本失败（不影响已删的条目）', error);
    }
    console.info(`[剧情推进助手] 清理${label}完成：删了 ${deleted} 条，涉及 ${touched.length} 本书`);
    return { books: touched, deleted };
  });
}
