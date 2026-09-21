// 自定义主题强调色：运行时通过内联 CSS 变量覆盖 main.scss 中 .theme-light/.theme-dark 的 --accent。
// 主题类同时挂在 html / body / #app 上，类选择器定义的变量会覆盖祖先内联值，
// 因此三个元素都必须内联设置（内联优先级高于同元素上的类规则）。

export const DEFAULT_ACCENT_COLOR = '#0078d4'

const ACCENT_HEX_PATTERN = /^#[0-9a-f]{6}$/

export const normalizeAccentColor = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined
  const color = value.trim().toLowerCase()
  return ACCENT_HEX_PATTERN.test(color) ? color : undefined
}

export const applyAccentColor = (value: unknown): void => {
  try {
    const color = normalizeAccentColor(value)
    const targets: Array<Element | null> = [
      document.documentElement,
      document.body,
      document.getElementById('app')
    ]
    for (const el of targets) {
      if (!(el instanceof HTMLElement)) continue
      if (color) {
        el.style.setProperty('--accent', color)
      } else {
        el.style.removeProperty('--accent')
      }
    }
  } catch {}
}

// 读取当前生效的 --accent（canvas 绘制场景用），非法/缺失时回退默认蓝
export const readCurrentAccentColor = (): string => {
  try {
    const value = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()
    return value || DEFAULT_ACCENT_COLOR
  } catch {
    return DEFAULT_ACCENT_COLOR
  }
}
