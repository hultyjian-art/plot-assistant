/**
 * 决定「这一轮的 `$1` 用哪几本世界书」。
 *
 * 为什么单独抽出来：库里能读到的书名（`getWorldbookNames()`）和角色卡绑定的书
 * （`getCharWorldbookNames('current')`）是两回事 —— 手动模式下用户可以选一本
 * 根本没绑到角色卡上的书当全局设定。这两种来源的取舍规则写在这里，面板只负责
 * 勾选，读表那边只负责读，判断只此一处，将来加「排除某本」也不用改两遍。
 */

export type WorldbookSource = 'character' | 'manual';

export interface WorldbookPick {
  source: WorldbookSource;
  /** 手动模式勾选的书名；顺序按用户勾选顺序，展示时再按书架顺序排 */
  books: string[];
}

function cleanName(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function dedupe(names: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of names) {
    if (name === '' || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

/**
 * 算出这次真正要读的书。
 *
 * `allBooks` 传「世界书库里现在有哪些书」：手动模式勾了一本已经被删掉的书时，
 * 这里要把它剔掉 —— 否则每一轮都会去读一本不存在的书，报一条永远修不好的警告。
 * 但 `allBooks` 为空（比如世界书接口暂时读不到）时不能据此认定「全都删了」，
 * 那种情况下原样保留，让下游去读、去报警。
 */
export function resolveWorldbookBooks(
  pick: WorldbookPick | null | undefined,
  characterBooks: string[],
  allBooks: string[],
): string[] {
  const characters = dedupe(characterBooks.map(cleanName));
  if (!pick || pick.source !== 'manual') return characters;

  const picked = dedupe((Array.isArray(pick.books) ? pick.books : []).map(cleanName));
  const shelf = dedupe(allBooks.map(cleanName));
  if (shelf.length === 0) return picked;

  const exists = new Set(shelf);
  return picked.filter(name => exists.has(name));
}
