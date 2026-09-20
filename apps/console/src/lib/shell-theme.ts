/**
 * shell-theme.ts — xterm 主题映射（tokens.css → xterm theme 对象）。
 *
 * xterm 不吃 CSS 变量，初始化/切换时必须读计算值；ANSI 16 色深浅两套
 * （跟随 <html data-theme>），前景/光标/选区绑设计 tokens（墨主紫辅契约：
 * 紫 = 指向与状态 —— 光标、选区）。纯函数（读 DOM 计算值），无 React。
 */

/** 当前是否暗色主题（缺省按暗色 —— tokens 的 :root:not([light]) 语义）。 */
export function isDarkTheme(): boolean {
  if (typeof document === 'undefined') return true
  return (document.documentElement.getAttribute('data-theme') ?? 'dark') !== 'light'
}

/** 读设计令牌计算值，读不到回落给定兜底。 */
export function readToken(name: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return v || fallback
}

/** ANSI 16 色：深浅两套，前景/光标/选区绑设计 tokens。 */
export function xtermTheme(dark: boolean) {
  const fg = readToken('--fg', dark ? '#e8e8e8' : '#0d0d0d')
  const cursor = readToken('--accent', '#6c5ce7')
  const selection = readToken('--accent-soft', '#ede9fc')
  const ansi = dark
    ? {
        black: '#1f2328', red: '#ff6b6b', green: '#3fb950', yellow: '#d29922',
        blue: '#58a6ff', magenta: '#bc8cff', cyan: '#39c5cf', white: '#b1bac4',
        brightBlack: '#8b949e', brightRed: '#ff9492', brightGreen: '#56d364',
        brightYellow: '#e3b341', brightBlue: '#79c0ff', brightMagenta: '#d2a8ff',
        brightCyan: '#56d4dd', brightWhite: '#f0f6fc',
      }
    : {
        black: '#24292f', red: '#cf222e', green: '#1a7f37', yellow: '#9a6700',
        blue: '#0969da', magenta: '#8250df', cyan: '#1b7c83', white: '#57606a',
        brightBlack: '#6e7781', brightRed: '#a40e26', brightGreen: '#116329',
        brightYellow: '#4d2d00', brightBlue: '#0550ae', brightMagenta: '#684dcd',
        brightCyan: '#0d7782', brightWhite: '#24292f',
      }
  return {
    foreground: fg,
    cursor,
    cursorAccent: readToken('--bg', dark ? '#101014' : '#ffffff'),
    selectionBackground: selection,
    // 透明底：终端底色由容器（--surface-sunk）决定，主题切换无需重绘历史
    background: 'rgba(0,0,0,0)',
    ...ansi,
  }
}
