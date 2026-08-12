export const THEME_STORAGE_KEY = 'monai-web-theme';

export const THEMES = [
  { id: 'violet', label: '紫罗兰', swatch: '#6D5EF6' },
  { id: 'mint', label: '薄荷绿', swatch: '#b2e0df' },
] as const;

export type ThemeId = (typeof THEMES)[number]['id'];

/** 运行时直接写到 <html style>，不依赖 CSS 选择器是否命中 */
const THEME_VARS: Record<ThemeId, Record<string, string>> = {
  violet: {
    '--brand-rgb': '109 94 246',
    '--brand': 'rgb(109 94 246)',
    '--brand-hover-rgb': '88 72 224',
    '--brand-hover': 'rgb(88 72 224)',
    '--brand-soft': 'rgb(109 94 246 / 0.1)',
  },
  mint: {
    // 实心按钮：加深以保证白字对比度；识别色 #b2e0df 用于 soft
    '--brand-rgb': '45 156 151',
    '--brand': 'rgb(45 156 151)',
    '--brand-hover-rgb': '36 130 126',
    '--brand-hover': 'rgb(36 130 126)',
    '--brand-soft': 'rgb(178 224 223 / 0.55)',
  },
};

export function isThemeId(value: string | null | undefined): value is ThemeId {
  return THEMES.some((theme) => theme.id === value);
}

export function readStoredTheme(): ThemeId {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (isThemeId(stored)) return stored;
  } catch {
    /* ignore */
  }
  return 'violet';
}

/** 写入 data-theme + 内联 CSS 变量，并持久化 */
export function applyTheme(theme: ThemeId): void {
  const root = document.documentElement;
  root.setAttribute('data-theme', theme);

  const vars = THEME_VARS[theme];
  for (const [name, value] of Object.entries(vars)) {
    root.style.setProperty(name, value);
  }

  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    /* ignore */
  }
}
