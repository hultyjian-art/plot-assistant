/**
 * 剧情推进的持久化：暂存账本与运行日志落在**聊天文件**里。
 *
 * 为什么走 `getVariables({type:'chat'})` 而不是自己摸 `chat_metadata`：
 *   1. 那是酒馆助手认的读写口，随聊天文件一起保存、切聊天自动换一份；
 *   2. 用户能看见、能改、能用脚本批量替换 —— 这是需求里明确要的；
 *   3. 不用碰 `SillyTavern.chatMetadata` 这种底层对象，避开版本差异。
 *
 * ⚠️ 这一层最容易踩的坑，写在这里省得后来人再踩一次：
 *   `replaceVariables(vars, {type:'chat'})` 是**整份替换**，不是合并。
 *   所以每次保存都必须「先读出全部、改我们那两个键、再整份写回」。
 *   少了这一步，别人的聊天变量（别的脚本、别的卡）会被我们一次保存全清掉。
 */

import { isPlainObject } from './guards';
import { createLog, type PlotRunLog } from './log-model';
import { createStash, type Stash } from './stash-model';

/** 我们独占的两个键。清空时只删这几个，别的一概不碰。 */
export const STASH_KEY = 'reroll_plot_stash';
export const LOG_KEY = 'reroll_plot_log';

/**
 * 世界书写入账本（2026-11-07 批 36-38 用户定）。
 *
 * 记「这个聊天往哪几本书写过哪些标签的内容」，按聊天分家 —— 切聊天后新账为空，
 * 重算结果自然为空，角色卡世界书里就不会残留上一聊天的条目（用户批 36 的核心要求）。
 * 刻意**不记实际条目名**（批 38 用户定）：条目名永远按当前规则现推，改名就失效、
 * 改回来又生效，脚本不做兼容。
 */
export const WB_WRITE_KEY = 'reroll_plot_wb_write';
/** 读坏了的原文往这里存一份，免得「切聊天恢复条目」的依据被我们悄悄丢掉。 */
export const WB_WRITE_BAD_KEY = 'reroll_plot_wb_write_bad';

/** 读坏了的原文往这里存一份，免得用户的数据被我们悄悄丢掉。 */
export const STASH_BAD_KEY = 'reroll_plot_stash_bad';
export const LOG_BAD_KEY = 'reroll_plot_log_bad';

/** 变量表的读写口。真实环境是 `getVariables` / `replaceVariables`，测试里换成假的。 */
export interface VariableStorage {
  readAll: () => Record<string, any>;
  writeAll: (next: Record<string, any>) => void;
}

/** 读取时发现的问题。不抛异常 —— 账本读坏了不该让整个推进停摆，但要留下痕迹。 */
export type StateWarning =
  | 'stash_unreadable'
  | 'log_unreadable'
  | 'stash_chat_key_mismatch'
  | 'wb_write_unreadable'
  | null;

/** 世界书写入账本的样子（纯数据，存聊天变量）。 */
export interface WbWriteLedger {
  version: 1;
  /** 记账那一刻的聊天标识（对不上 = 聊天被复制/改名，账按新账处理） */
  chatKey: string;
  /** 记账那一刻的角色卡标识（对不上 = 同一聊天换了卡打开，重算一遍） */
  charKey: string;
  /** 往哪几本书写过条目。重算时先在这些书里清托管条目，再按当前规则重放 */
  books: string[];
  /** 已写入的标签内容：**标签名** → 条目内容（`<标签>…</标签>` 整块）。重放时从这里取 */
  contents: Record<string, string>;
}

export function createWbWriteLedger(chatKey: string, charKey: string): WbWriteLedger {
  return { version: 1, chatKey, charKey, books: [], contents: {} };
}

export interface LoadedStash {
  stash: Stash;
  warning: StateWarning;
}

export interface ChatStateStore {
  loadStash: (chatKey: string) => LoadedStash;
  saveStash: (stash: Stash) => void;
  loadLog: () => { log: PlotRunLog; warning: StateWarning };
  saveLog: (log: PlotRunLog) => void;
  /** 世界书写入账本：没有 = `null`（新账）；读坏 = 原文备份后给空账。 */
  loadWbWriteLedger: () => { ledger: WbWriteLedger | null; warning: StateWarning };
  saveWbWriteLedger: (ledger: WbWriteLedger) => void;
  /** 只删我们自己那几把钥匙（含坏数据备份位），别人的变量一个不动。 */
  clearOwnKeys: () => void;
}

/**
 * 窄校验：只要结构对得上就认，不逐字段挑刺。
 *
 * 为什么不严格校验每个 landing：那是用户能手改的数据，多一个字段就该救活而不是判死。
 * 只有「连骨架都不对」（不是对象 / version 不是 1 / entries 不是数组）才算读坏。
 */
function looksLikeStash(value: unknown): value is Stash {
  if (!isPlainObject(value)) return false;
  if (value.version !== 1) return false;
  if (!Array.isArray(value.entries)) return false;
  if (!Array.isArray(value.orphans)) return false;
  return true;
}

function looksLikeLog(value: unknown): value is PlotRunLog {
  if (!isPlainObject(value)) return false;
  if (value.version !== 1) return false;
  return Array.isArray(value.rounds);
}

/** 世界书写入账本：结构对得上就认，脏内容逐条丢（内容重放时才有用，坏了顶多少恢复一份）。 */
function looksLikeWbWriteLedger(value: unknown): value is WbWriteLedger {
  if (!isPlainObject(value)) return false;
  if (value.version !== 1) return false;
  if (!Array.isArray(value.books)) return false;
  return isPlainObject(value.contents);
}

export function createChatStateStore(storage: VariableStorage): ChatStateStore {
  /** 每次保存都走这同一道口：读出全部 → 只改我们的键 → 整份写回。 */
  const writeOwn = (patch: Record<string, any>): void => {
    const all = storage.readAll() || {};
    storage.writeAll({ ...all, ...patch });
  };

  const loadStash = (chatKey: string): LoadedStash => {
    const all = storage.readAll() || {};
    const raw = all[STASH_KEY];

    if (raw === undefined || raw === null) {
      return { stash: createStash(chatKey), warning: null };
    }

    if (!looksLikeStash(raw)) {
      // 先备份原文再给一份空账本 —— 顺序反了就等于把用户的账本抹了。
      writeOwn({ [STASH_BAD_KEY]: raw });
      return { stash: createStash(chatKey), warning: 'stash_unreadable' };
    }

    if (raw.chatKey !== chatKey) {
      // 聊天被复制/改名后会出现这种情况。楼层号是跟着聊天走的，所以数据仍然有效，
      // 只是把章重新盖一下；警告留给调用方记进运行日志。
      return { stash: { ...raw, chatKey }, warning: 'stash_chat_key_mismatch' };
    }

    return { stash: raw, warning: null };
  };

  const loadLog = (): { log: PlotRunLog; warning: StateWarning } => {
    const all = storage.readAll() || {};
    const raw = all[LOG_KEY];

    if (raw === undefined || raw === null) {
      return { log: createLog(), warning: null };
    }

    if (!looksLikeLog(raw)) {
      writeOwn({ [LOG_BAD_KEY]: raw });
      return { log: createLog(), warning: 'log_unreadable' };
    }

    return { log: raw, warning: null };
  };

  const loadWbWriteLedger = (): { ledger: WbWriteLedger | null; warning: StateWarning } => {
    const all = storage.readAll() || {};
    const raw = all[WB_WRITE_KEY];

    if (raw === undefined || raw === null) return { ledger: null, warning: null };

    if (!looksLikeWbWriteLedger(raw)) {
      // 先备份原文再给空账 —— 顺序反了就等于把「切聊天恢复条目」的依据抹了。
      writeOwn({ [WB_WRITE_BAD_KEY]: raw });
      return { ledger: null, warning: 'wb_write_unreadable' };
    }

    const contents: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw.contents as Record<string, unknown>)) {
      const name = key.trim();
      if (name === '' || typeof value !== 'string' || value.trim() === '') continue;
      contents[name] = value;
    }
    const books = raw.books
      .filter((name): name is string => typeof name === 'string' && name.trim() !== '')
      .map(name => name.trim());
    return {
      ledger: {
        version: 1,
        chatKey: typeof raw.chatKey === 'string' ? raw.chatKey : '',
        charKey: typeof raw.charKey === 'string' ? raw.charKey : '',
        books: [...new Set(books)],
        contents,
      },
      warning: null,
    };
  };

  return {
    loadStash,
    saveStash: (stash) => writeOwn({ [STASH_KEY]: stash }),
    loadLog,
    saveLog: (log) => writeOwn({ [LOG_KEY]: log }),
    loadWbWriteLedger,
    saveWbWriteLedger: (ledger) => writeOwn({ [WB_WRITE_KEY]: ledger }),
    clearOwnKeys: () => {
      const all = storage.readAll() || {};
      const next = { ...all };
      delete next[STASH_KEY];
      delete next[LOG_KEY];
      delete next[STASH_BAD_KEY];
      delete next[LOG_BAD_KEY];
      delete next[WB_WRITE_KEY];
      delete next[WB_WRITE_BAD_KEY];
      storage.writeAll(next);
    },
  };
}

/** 真实环境用的存储在 `data/chat-vars.ts`（那边要碰酒馆全局函数，本文件保持纯逻辑以便测试）。 */
