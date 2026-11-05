/**
 * 面板主题。
 *
 * 色值来自 ACU（数据库）v2 的内置主题 —— `D:\Github\_refs\shujuku\src\presentation-v2\theme\builtin-themes.ts`
 * 的 `ACU_V2_BUILTIN_THEMES`，一共五套：浅色 / 深色 / 奶油风 / 地雷色 / 奶龙配色。
 * 用户 2026-11-01 指定：全搬过来，默认用「奶龙配色」（ACU 那边它也是默认），
 * 原来那套白紫留着当第六个选项，等以后单独打磨。
 *
 * **只搬色**，不搬字体和圆角：
 *   - 字体：面板里混了中文正文和等宽代码框，ACU 的 `fontUi` 只写了西文字族，
 *     照抄会让中文掉到系统默认字体上，反而更乱。
 *   - 圆角：ACU 一套主题的圆角是 6/6/6 到 18/16/12，而这面板的圆角分散在几十条规则里
 *     （卡片 16、按钮 8、块 10……），换主题就换圆角要动的地方太多，收益不抵风险。
 *
 * 色值落地方式是**内联 CSS 变量**（见 `themeVars`）：`.rh-mask` 自己声明了一整套
 * `--rh-*` 令牌，内联样式优先级更高，切换主题时只覆盖变量、不用重写任何一条规则。
 */

import type { CSSProperties } from 'vue';

/** 一套主题对面板的落地形态：直接给 `--rh-*` 令牌赋值。 */
export interface PanelTheme {
  /** 存进 `settings.look.themeId` 的稳定标识；改名会让老用户回退到默认主题。 */
  id: string;
  /** 下拉里显示的名字。 */
  name: string;
  /** 深色主题要把 `color-scheme` 一起切，否则滚动条和原生控件还是亮的。 */
  colorScheme: 'light' | 'dark';
  /** `--rh-*` 变量表；空对象 = 不吃主题，用样式表里写死的白紫默认值。 */
  vars: Record<string, string>;
}

/**
 * 默认主题。
 *
 * 面板第一次被打开时走这个值；老用户升级上来、`look.themeId` 还不存在时也走这个值。
 */
export const MILK_DRAGON_THEME_ID = 'milk-dragon';

/** 「星空神庙」的主题 id。 */
export const STARRY_TEMPLE_THEME_ID = 'starry-temple';

/** 默认主题（用户 2026-11-04 指定：星空神庙）。 */
export const DEFAULT_THEME_ID = STARRY_TEMPLE_THEME_ID;

export const PANEL_THEMES: readonly PanelTheme[] = [
  {
    id: MILK_DRAGON_THEME_ID,
    name: '奶龙配色',
    colorScheme: 'light',
    // 浅奶黄底 + 奶油黄强调 + 暖棕灰文字，层次照奶油风，低饱和、扁平。
    vars: {
      '--rh-fg': '#4A3F2C',
      '--rh-fg-soft': '#6E5F45',
      '--rh-fg-mid': '#6E5F45',
      '--rh-fg-dim': '#9A8A6B',
      '--rh-fg-faint': '#9A8A6B',
      '--rh-bg': '#FBF6E9',
      '--rh-bg-pure': '#FFFCF3',
      '--rh-bg-soft': '#F3EAD2',
      '--rh-bg-hover': '#F3EAD2',
      '--rh-line': 'rgba(150, 112, 30, 0.18)',
      '--rh-line-soft': 'rgba(150, 112, 30, 0.12)',
      '--rh-line-input': 'rgba(150, 112, 30, 0.18)',
      '--rh-line-dashed': 'rgba(150, 112, 30, 0.30)',
      '--rh-accent': '#E9BE45',
      '--rh-accent-deep': '#D9AB2E',
      '--rh-accent-wash': 'rgba(233, 190, 69, 0.22)',
      '--rh-accent-wash-soft': 'rgba(233, 190, 69, 0.12)',
      '--rh-accent-ring': 'rgba(233, 190, 69, 0.30)',
      '--rh-accent-selection': 'rgba(233, 190, 69, 0.38)',
      '--rh-danger': '#B8665F',
      '--rh-ok': '#7FA06A',
      '--rh-ok-wash': 'rgba(127, 160, 106, 0.14)',
      '--rh-ok-ring': 'rgba(127, 160, 106, 0.24)',
      '--rh-ok-glow-faint': 'rgba(127, 160, 106, 0.06)',
      '--rh-ok-glow-strong': 'rgba(127, 160, 106, 0.35)',
      '--rh-scrim': 'rgba(61, 48, 22, 0.45)',
      '--rh-shadow': 'rgba(120, 90, 30, 0.30)',
      '--rh-thumb': 'rgba(150, 112, 30, 0.30)',
      '--rh-card-edge': 'rgba(150, 112, 30, 0.20)',
      '--rh-scrim-btn': 'rgba(74, 63, 44, 0.40)',
    },
  },
  {
    id: 'creamy-minimal',
    name: '奶油风',
    colorScheme: 'light',
    vars: {
      '--rh-fg': '#514638',
      '--rh-fg-soft': '#735F4A',
      '--rh-fg-mid': '#735F4A',
      '--rh-fg-dim': '#9A8268',
      '--rh-fg-faint': '#9A8268',
      '--rh-bg': '#F7F0E6',
      '--rh-bg-pure': '#FCF8F1',
      '--rh-bg-soft': '#EFE4D7',
      '--rh-bg-hover': '#EFE4D7',
      '--rh-line': 'rgba(116, 91, 62, 0.18)',
      '--rh-line-soft': 'rgba(116, 91, 62, 0.12)',
      '--rh-line-input': 'rgba(116, 91, 62, 0.18)',
      '--rh-line-dashed': 'rgba(116, 91, 62, 0.30)',
      '--rh-accent': '#85A76A',
      '--rh-accent-deep': '#738F5B',
      '--rh-accent-wash': 'rgba(133, 167, 106, 0.22)',
      '--rh-accent-wash-soft': 'rgba(133, 167, 106, 0.12)',
      '--rh-accent-ring': 'rgba(133, 167, 106, 0.28)',
      '--rh-accent-selection': 'rgba(133, 167, 106, 0.38)',
      '--rh-danger': '#A76561',
      '--rh-ok': '#7F9B69',
      '--rh-ok-wash': 'rgba(127, 155, 105, 0.14)',
      '--rh-ok-ring': 'rgba(127, 155, 105, 0.24)',
      '--rh-ok-glow-faint': 'rgba(127, 155, 105, 0.06)',
      '--rh-ok-glow-strong': 'rgba(127, 155, 105, 0.35)',
      '--rh-scrim': 'rgba(74, 60, 42, 0.45)',
      '--rh-shadow': 'rgba(92, 70, 44, 0.30)',
      '--rh-thumb': 'rgba(116, 91, 62, 0.30)',
      '--rh-card-edge': 'rgba(116, 91, 62, 0.20)',
      '--rh-scrim-btn': 'rgba(81, 70, 56, 0.40)',
    },
  },
  {
    id: 'default-light',
    name: '浅色',
    colorScheme: 'light',
    vars: {
      '--rh-fg': '#11110f',
      '--rh-fg-soft': '#46443d',
      '--rh-fg-mid': '#46443d',
      '--rh-fg-dim': '#77736a',
      '--rh-fg-faint': '#77736a',
      '--rh-bg': '#f8f5ee',
      '--rh-bg-pure': '#fbfaf6',
      '--rh-bg-soft': '#ebe9e3',
      '--rh-bg-hover': '#ebe9e3',
      '--rh-line': 'rgba(23, 23, 20, 0.10)',
      '--rh-line-soft': 'rgba(23, 23, 20, 0.06)',
      '--rh-line-input': 'rgba(23, 23, 20, 0.10)',
      '--rh-line-dashed': 'rgba(23, 23, 20, 0.20)',
      '--rh-accent': '#11110f',
      '--rh-accent-deep': '#2d2b26',
      '--rh-accent-wash': 'rgba(17, 17, 15, 0.10)',
      '--rh-accent-wash-soft': 'rgba(17, 17, 15, 0.06)',
      '--rh-accent-ring': 'rgba(17, 17, 15, 0.14)',
      '--rh-accent-selection': 'rgba(17, 17, 15, 0.18)',
      '--rh-danger': '#95514b',
      '--rh-ok': '#4d6b56',
      '--rh-ok-wash': 'rgba(77, 107, 86, 0.12)',
      '--rh-ok-ring': 'rgba(77, 107, 86, 0.22)',
      '--rh-ok-glow-faint': 'rgba(77, 107, 86, 0.05)',
      '--rh-ok-glow-strong': 'rgba(77, 107, 86, 0.35)',
      '--rh-scrim': 'rgba(17, 17, 15, 0.45)',
      '--rh-shadow': 'rgba(23, 23, 20, 0.25)',
      '--rh-thumb': 'rgba(23, 23, 20, 0.22)',
      '--rh-card-edge': 'rgba(23, 23, 20, 0.10)',
      '--rh-scrim-btn': 'rgba(23, 23, 20, 0.40)',
    },
  },
  {
    id: 'default-dark',
    name: '深色',
    colorScheme: 'dark',
    vars: {
      '--rh-fg': '#F0F3F6',
      '--rh-fg-soft': '#C9D1D9',
      '--rh-fg-mid': '#C9D1D9',
      '--rh-fg-dim': '#8B949E',
      '--rh-fg-faint': '#8B949E',
      '--rh-bg': '#1F2428',
      '--rh-bg-pure': '#24292E',
      '--rh-bg-soft': '#2D343B',
      '--rh-bg-hover': '#2D343B',
      '--rh-line': 'rgba(205, 217, 229, 0.14)',
      '--rh-line-soft': 'rgba(205, 217, 229, 0.08)',
      '--rh-line-input': 'rgba(205, 217, 229, 0.16)',
      '--rh-line-dashed': 'rgba(205, 217, 229, 0.24)',
      '--rh-accent': '#7FD6CA',
      '--rh-accent-deep': '#69C7BC',
      '--rh-accent-wash': 'rgba(127, 214, 202, 0.18)',
      '--rh-accent-wash-soft': 'rgba(127, 214, 202, 0.10)',
      '--rh-accent-ring': 'rgba(127, 214, 202, 0.26)',
      '--rh-accent-selection': 'rgba(127, 214, 202, 0.34)',
      '--rh-danger': '#D07A74',
      '--rh-ok': '#8DBA9A',
      '--rh-ok-wash': 'rgba(141, 186, 154, 0.16)',
      '--rh-ok-ring': 'rgba(141, 186, 154, 0.26)',
      '--rh-ok-glow-faint': 'rgba(141, 186, 154, 0.06)',
      '--rh-ok-glow-strong': 'rgba(141, 186, 154, 0.35)',
      '--rh-scrim': 'rgba(1, 4, 9, 0.60)',
      '--rh-shadow': 'rgba(1, 4, 9, 0.55)',
      '--rh-thumb': 'rgba(205, 217, 229, 0.24)',
      '--rh-card-edge': 'rgba(205, 217, 229, 0.14)',
      '--rh-scrim-btn': 'rgba(1, 4, 9, 0.45)',
    },
  },
  {
    id: 'jirai-kei',
    name: '地雷色',
    colorScheme: 'dark',
    // ACU 原版把 border / border2 设成 transparent。本面板靠边框分区（标签下划线、
    // 小节分隔线、输入框轮廓），全透明会糊成一片，所以换成低透明白来保持结构。
    vars: {
      '--rh-fg': '#FFFFFF',
      '--rh-fg-soft': 'rgba(255, 255, 255, 0.70)',
      '--rh-fg-mid': 'rgba(255, 255, 255, 0.70)',
      '--rh-fg-dim': 'rgba(255, 255, 255, 0.50)',
      '--rh-fg-faint': 'rgba(255, 255, 255, 0.45)',
      '--rh-bg': '#2B2B2B',
      '--rh-bg-pure': '#1F1F1F',
      '--rh-bg-soft': '#333333',
      '--rh-bg-hover': 'rgba(255, 196, 212, 0.10)',
      '--rh-line': 'rgba(255, 255, 255, 0.12)',
      '--rh-line-soft': 'rgba(255, 255, 255, 0.07)',
      '--rh-line-input': 'rgba(255, 255, 255, 0.16)',
      '--rh-line-dashed': 'rgba(255, 255, 255, 0.22)',
      '--rh-accent': '#FFC4D4',
      '--rh-accent-deep': '#FFD9E4',
      '--rh-accent-wash': 'rgba(255, 196, 212, 0.18)',
      '--rh-accent-wash-soft': 'rgba(255, 196, 212, 0.10)',
      '--rh-accent-ring': 'rgba(255, 196, 212, 0.25)',
      '--rh-accent-selection': 'rgba(255, 196, 212, 0.34)',
      '--rh-danger': '#D96C6C',
      '--rh-ok': '#E5A0B5',
      '--rh-ok-wash': 'rgba(229, 160, 181, 0.16)',
      '--rh-ok-ring': 'rgba(229, 160, 181, 0.26)',
      '--rh-ok-glow-faint': 'rgba(229, 160, 181, 0.06)',
      '--rh-ok-glow-strong': 'rgba(229, 160, 181, 0.35)',
      '--rh-scrim': 'rgba(0, 0, 0, 0.60)',
      '--rh-shadow': 'rgba(0, 0, 0, 0.55)',
      '--rh-thumb': 'rgba(255, 255, 255, 0.24)',
      '--rh-card-edge': 'rgba(255, 255, 255, 0.12)',
      '--rh-scrim-btn': 'rgba(0, 0, 0, 0.45)',
    },
  },
  {
    id: STARRY_TEMPLE_THEME_ID,
    name: '星空神庙',
    colorScheme: 'light',
    /*
     * 用户 2026-11-03 指定：原来那套白紫升级成「星空神庙」——
     * 大理石白底 + 古希腊金线 + 紫水晶毛玻璃 + 蓝紫星空。
     *
     * 这里只放色；大理石纹路、金线、桂枝、星空那些是背景图，
     * 由样式表里 `[data-rh-theme='starry-temple']` 那段按主题 id 上。
     */
    vars: {
      // 墨色：偏冷的中性灰，压在大理石上不刺眼
      '--rh-fg': '#23252F',
      '--rh-fg-soft': '#414455',
      '--rh-fg-mid': '#565A6D',
      '--rh-fg-dim': '#6E7286',
      '--rh-fg-faint': '#8F93A6',
      // 大理石：暖白打底，纯白留给输入框那种要「浮起来」的地方
      '--rh-bg': '#F7F4EF',
      '--rh-bg-pure': '#FDFBF7',
      '--rh-bg-soft': '#EFEAE3',
      '--rh-bg-hover': '#EAE4DB',
      '--rh-line': 'rgba(120, 116, 140, 0.22)',
      '--rh-line-soft': 'rgba(120, 116, 140, 0.14)',
      '--rh-line-input': 'rgba(120, 116, 140, 0.34)',
      '--rh-line-dashed': 'rgba(120, 116, 140, 0.42)',
      // 紫水晶：蓝紫之间，刻意不往纯紫走（纯紫显廉价）
      '--rh-accent': '#6C60C9',
      '--rh-accent-deep': '#554AA8',
      '--rh-accent-wash': 'rgba(108, 96, 201, 0.13)',
      '--rh-accent-wash-soft': 'rgba(108, 96, 201, 0.07)',
      '--rh-accent-ring': 'rgba(108, 96, 201, 0.24)',
      '--rh-accent-selection': 'rgba(108, 96, 201, 0.26)',
      '--rh-danger': '#B04A3A',
      '--rh-ok': '#3F7F63',
      '--rh-ok-wash': 'rgba(63, 127, 99, 0.12)',
      '--rh-ok-ring': 'rgba(63, 127, 99, 0.22)',
      '--rh-ok-glow-faint': 'rgba(63, 127, 99, 0.05)',
      '--rh-ok-glow-strong': 'rgba(63, 127, 99, 0.30)',
      '--rh-scrim': 'rgba(26, 24, 38, 0.52)',
      '--rh-shadow': 'rgba(38, 34, 64, 0.26)',
      '--rh-thumb': 'rgba(120, 116, 140, 0.34)',
      '--rh-card-edge': 'rgba(120, 116, 140, 0.26)',
      '--rh-scrim-btn': 'rgba(35, 37, 47, 0.44)',
      // 这套主题专用：金线、紫水晶、星点
      '--rh-gold': '#B08D4F',
      '--rh-gold-soft': 'rgba(176, 141, 79, 0.28)',
      '--rh-gold-line': 'rgba(176, 141, 79, 0.55)',
      '--rh-amethyst': '#7B6FD6',
      '--rh-amethyst-deep': '#5B4FB2',
      '--rh-star': 'rgba(120, 108, 220, 0.55)',
    },
  },
];

/** 按 id 找主题；找不到回退默认（老用户存了已删除的主题名时不会白屏）。 */
export function themeById(id: string | undefined | null): PanelTheme {
  const wanted = typeof id === 'string' ? id : '';
  const found = PANEL_THEMES.find((theme) => theme.id === wanted);
  return found ?? PANEL_THEMES[0];
}

/** 校验一个来路不明的值是不是已知主题 id，不是就退回默认。 */
export function asThemeId(raw: unknown): string {
  const wanted = typeof raw === 'string' ? raw : '';
  return PANEL_THEMES.some((theme) => theme.id === wanted) ? wanted : DEFAULT_THEME_ID;
}

/**
 * 把主题摊成可以直接绑到 `:style` 的样式对象。
 *
 * 除令牌外还带上 `color-scheme`：`.rh-mask` 里那条 `color-scheme: light !important`
 * 会压过内联样式，所以样式表里改成了 `color-scheme: var(--rh-scheme, light) !important`，
 * 这里只需提供变量。
 */
export function themeVars(id: string | undefined | null): CSSProperties {
  const theme = themeById(id);
  return { '--rh-scheme': theme.colorScheme, ...theme.vars } as CSSProperties;
}
