/**
 * 剧情推进 — API 密钥的落盘混淆。
 *
 * ## 先说清楚这层东西能挡什么、挡不住什么
 *
 * **能挡**：随手截图面板、把设置贴进群里问人、翻看日志时撞见——这些场景里它不会是一串能直接用的 `sk-xxx`。
 * **挡不住**：真有人能跑脚本读你的浏览器存储，他也能拿到这份代码和解法。**它不是加密，是混淆。**
 *
 * 为什么还做：用户的诉求就是「防误露」。把它当成保险柜是错的，当成磨砂纸是对的。
 *
 * ## 方案
 *
 * 取 **XOR + Base64 + 固定前缀**。选择理由：
 *
 * - 不用 CryptoJS / WebCrypto：前者要加依赖，后者的 `subtle` API 是**异步**的，
 *   会让「读设置」这条同步路径全部变成 async，牵连一大片代码。
 * - XOR 可逆且极快，密钥很短（几十字节），性能不是问题。
 * - 加固定前缀 `obf1:` 是为了**能区分「混淆过的」和「用户手动填的明文」**，
 *   否则读旧数据时无法判断该不该解。
 *
 * ## 兼容
 *
 * 用户机器上可能已经有明文存的密钥（本轮之前存的设置）。所以 `unobfuscate` 的判断顺序是：
 * 有前缀且解得开 → 解；否则**原样返回**（当成用户手动写的明文）。
 * 这样老数据不用迁移就能继续用，用户改一次就会变成混淆格式。
 */

/** 混淆后的密钥前缀。`obf1` 里的 1 是版本号，将来换算法时能并存。 */
const MARK = 'obf1:';

/**
 * XOR 用的种子。
 *
 * 不用随机数是因为：密钥要能被「同一个版本的程序」解回来，种子必须稳定。
 * 写成这样一串是因为它只需要稳定、不需要保密 —— 反正这层本来就不是加密。
 */
const SEED = 'reroll-plot-api-key-v1';

/** 把字符串按 UTF-8 编成字节。密钥理论上都是 ASCII，但用户可能填中文备注式的东西。 */
function toBytes(text: string): number[] {
  const bytes: number[] = [];
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x80) {
      bytes.push(code);
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    }
  }
  return bytes;
}

/** 字节还原成字符串。解出来是坏数据时返回空串（调用方按「没有密钥」处理）。 */
function fromBytes(bytes: number[]): string {
  let out = '';
  let index = 0;
  while (index < bytes.length) {
    const first = bytes[index];
    if (first < 0x80) {
      out += String.fromCodePoint(first);
      index += 1;
    } else if (first < 0xe0) {
      out += String.fromCodePoint(((first & 0x1f) << 6) | (bytes[index + 1] & 0x3f));
      index += 2;
    } else if (first < 0xf0) {
      out += String.fromCodePoint(((first & 0x0f) << 12) | ((bytes[index + 1] & 0x3f) << 6) | (bytes[index + 2] & 0x3f));
      index += 3;
    } else {
      out += String.fromCodePoint(
        ((first & 0x07) << 18) |
          ((bytes[index + 1] & 0x3f) << 12) |
          ((bytes[index + 2] & 0x3f) << 6) |
          (bytes[index + 3] & 0x3f),
      );
      index += 4;
    }
  }
  return out;
}

/** 按种子逐字节异或。同一个函数做两次就还原（XOR 的自反性）。 */
function xorWithSeed(bytes: number[]): number[] {
  const seed = toBytes(SEED);
  return bytes.map((byte, index) => byte ^ seed[index % seed.length]);
}

/** 字节 → Base64。浏览器与 Node 都有 btoa，但每 4 个字符才吃一个字节，要先塞进 Latin-1 字符串。 */
function bytesToBase64(bytes: number[]): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Base64 → 字节。解失败（长度不是 4 的倍数、含非法字符）时返回 null。 */
function base64ToBytes(text: string): number[] | null {
  if (text.length % 4 !== 0) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text)) return null;
  let binary: string;
  try {
    binary = atob(text);
  } catch {
    return null;
  }
  const bytes: number[] = [];
  for (let index = 0; index < binary.length; index += 1) bytes.push(binary.charCodeAt(index));
  return bytes;
}

/**
 * 把密钥混淆成可落盘的字符串。
 *
 * 空串进空串出 —— 没配密钥的条目不该被塞一个 `obf1:` 进去（那样每次读都要白解一遍，
 * 而且面板上会显示一个"有内容"的样子）。
 */
export function obfuscateApiKey(plain: string): string {
  if (plain === '') return '';
  return MARK + bytesToBase64(xorWithSeed(toBytes(plain)));
}

/**
 * 把落盘的字符串还原成密钥。
 *
 * 判断顺序（关键）：
 * 1. 空串 → 空串
 * 2. 有 `obf1:` 前缀且 Base64 解得开 → 还原
 * 3. 其它一律**原样返回** —— 用户可能手填了明文，也可能是本轮之前的老数据
 *
 * 第 3 条不能改成「返回空」：那会让所有老用户的密钥在我升级之后凭空消失，
 * 而且不报错，表现为"剧情推进突然调不通 AI"。
 */
export function unobfuscateApiKey(stored: string): string {
  if (stored === '') return '';
  if (!stored.startsWith(MARK)) return stored;

  const body = stored.slice(MARK.length);
  const bytes = base64ToBytes(body);
  if (bytes === null) return stored; // 前缀对但内容坏了：当明文用，别把数据丢掉
  return fromBytes(xorWithSeed(bytes));
}

/**
 * 日志/面板里显示用的打码文本。
 *
 * 只看长度决定露几个字符，**不还原真实密钥** —— 这个函数进日志就是安全的。
 */
export function maskApiKey(plain: string): string {
  if (plain === '') return '(未填)';
  if (plain.length <= 6) return '••••';
  return `${plain.slice(0, 3)}••••${plain.slice(-2)}`;
}
