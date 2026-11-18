export function isMacPlatform(platform = globalThis.navigator?.platform || ''): boolean {
  return /Mac|iPhone|iPad/i.test(platform)
}

/**
 * 规范化按键格式（内部存储统一使用 Mod+Alt+Shift+Key 顺序）
 */
export function normalizeKeybinding(raw: string): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null
  const parts = raw.trim().split('+').map(part => part.trim())
  const key = parts.pop() || ''
  const aliases: Record<string,string> = { mod:'Mod', ctrl:'Mod', meta:'Mod', cmd:'Mod', alt:'Alt', shift:'Shift' }
  const mods = parts.map(part => aliases[part.toLowerCase()])
  if (mods.some(mod => !mod) || new Set(mods).size !== mods.length) return null
  const special = ['Enter','Escape','Tab','Space','Backspace','Delete','Home','End','PageUp','PageDown','Insert','ArrowUp','ArrowDown','ArrowLeft','ArrowRight']
  const normalizedKey = key.length === 1 && /^[a-z0-9=\-\x60\\/\[\];',.]$/i.test(key) ? key.toUpperCase()
    : /^f([1-9]|1[0-2])$/i.test(key) ? key.toUpperCase()
    : special.find(name => name.toLowerCase() === key.toLowerCase())
  if (!normalizedKey || (!mods.includes('Mod') && !mods.includes('Alt') && !/^F\d+$/.test(normalizedKey))) return null
  return [...['Mod','Alt','Shift'].filter(mod => mods.includes(mod)), normalizedKey].join('+')
}

/**
 * 从键盘事件解析并生成规范化快捷键字符串
 */
export function eventToKeybinding(event: KeyboardEvent, platform?: string, imeShortcut = false): string | null {
  if ((event.isComposing && !imeShortcut) || event.getModifierState?.('AltGraph')) return null
  if (isMacPlatform(platform) ? event.ctrlKey : event.metaKey) return null
  // 如果是纯修饰键按下，不构成有效快捷键
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(event.key)) {
    return null
  }

  const isMac = isMacPlatform(platform)
  const isMod = isMac ? event.metaKey : event.ctrlKey
  const isAlt = event.altKey
  const isShift = event.shiftKey

  // 获取主要按键
  let key = event.key === ' ' ? 'Space' : event.key
  if (/^Key[A-Z]$/.test(event.code) && (isAlt || (isMod && !/^[a-z]$/i.test(key)))) key = event.code.slice(3)

  // 针对特定数字键与符号键对齐
  if ((isMod || event.altKey) && /^Digit[0-9]$/.test(event.code)) {
    key = event.code.slice(-1)
  } else if (key === '+' || (event.code === 'Equal' && isShift)) {
    key = '='
  } else if (key === '_' || (event.code === 'Minus' && isShift)) {
    key = '-'
  } else if (key === '|' || (event.code === 'Backslash' && isShift)) {
    key = '\\'
  } else if (key === '?' || (event.code === 'Slash' && isShift)) {
    key = '/'
  } else if (key === '~' || (event.code === 'Backquote' && isShift)) {
    key = '`'
  } else if (key === '{' || (event.code === 'BracketLeft' && isShift)) {
    key = '['
  } else if (key === '}' || (event.code === 'BracketRight' && isShift)) {
    key = ']'
  }

  if (isMod || event.altKey) {
    const physical: Record<string,string> = {Equal:'=',Minus:'-',Backslash:'\\',Slash:'/',Backquote:String.fromCharCode(96),BracketLeft:'[',BracketRight:']',Semicolon:';',Quote:String.fromCharCode(39),Comma:',',Period:'.'}
    key = physical[event.code] || key
  }
  const normalized = normalizeKeybinding(
    [isMod ? 'Mod' : '', isAlt ? 'Alt' : '', isShift ? 'Shift' : '', key].filter(Boolean).join('+')
  )

  return normalized
}

/**
 * 格式化为给用户展示的独立键帽数组（Keycap）
 * 例如 'Mod+Shift+P' 在 Windows 下输出 ['Ctrl', 'Shift', 'P']
 */
export function formatKeycaps(binding: string, platform?: string): string[] {
  if (!binding) return []
  const isMac = isMacPlatform(platform)
  const parts = binding.split('+')
  return parts.map(part => {
    switch (part) {
      case 'Mod':
        return isMac ? '⌘' : 'Ctrl'
      case 'Alt':
        return isMac ? '⌥' : 'Alt'
      case 'Shift':
        return isMac ? '⇧' : 'Shift'
      case 'ArrowUp':
        return '↑'
      case 'ArrowDown':
        return '↓'
      case 'ArrowLeft':
        return '←'
      case 'ArrowRight':
        return '→'
      case 'Enter':
        return 'Enter'
      case 'Escape':
        return 'Esc'
      case 'Backspace':
        return 'Backspace'
      case 'Delete':
        return 'Del'
      case 'Tab':
        return 'Tab'
      case 'Space':
        return 'Space'
      default:
        return part
    }
  })
}

/**
 * 格式化为单行文本标签
 */
export function keybindingLabel(binding: string, platform?: string): string {
  const caps = formatKeycaps(binding, platform)
  return caps.join(' + ')
}
