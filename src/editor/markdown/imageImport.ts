import { StateEffect, StateField, Transaction } from '@codemirror/state'
import { isolateHistory } from '@codemirror/commands'
import { invoke, isTauri } from '@tauri-apps/api/core'
import type { DocumentManager } from '../core/DocumentManager'
import { refreshMarkdownResources } from './images'
import { fitsSettingsText, maxImageDirectoryBytes } from '../../features/shell/settingsLimits'

export interface ImageRules {
  location: 'original' | 'sibling' | 'assets' | 'document' | 'custom'
  customDirectory: string
  relative: boolean
  dotPrefix: boolean
  escape: boolean
}
export const defaultImageRules = (): ImageRules => ({ location: 'assets', customDirectory: './assets/', relative: true, dotPrefix: true, escape: true })
export function imageRulesFrom(raw: unknown): ImageRules {
  const rules = defaultImageRules()
  if (!raw || typeof raw !== 'object') return rules
  const input = raw as Partial<ImageRules>
  if (['original','sibling','assets','document','custom'].includes(input.location || '')) rules.location = input.location!
  // The Rust validator caps this directory by UTF-8 bytes and rejects NUL; an
  // over-long value falls back to the default instead of being truncated.
  if (fitsSettingsText(input.customDirectory, maxImageDirectoryBytes)) rules.customDirectory = input.customDirectory
  for (const key of ['relative','dotPrefix','escape'] as const) if (typeof input[key] === 'boolean') rules[key] = input[key]!
  return rules
}
export const imageRuleKey = (path: string) => {
  const key = path.replace(/^\\\\\?\\UNC\\/i, '//').replace(/^\\\\\?\\/, '').replace(/\\/g, '/')
  return /^[a-z]:\//i.test(key) || key.startsWith('//') ? key.toLowerCase() : key
}
export function imageDirectory(rules: ImageRules, name: string, pixels = false) {
  const stem = name.replace(/\.(md|markdown)$/i, '')
  return ({ original: pixels ? './assets/' : null, sibling: '.', assets: './assets/', document: './${filename}.assets/', custom: rules.customDirectory }[rules.location])?.split('${filename}').join(stem) ?? null
}

/** OS paths become Markdown destinations; angle brackets keep unescaped spaces parseable. */
export function imageMarkdown(path: string, documentPath: string, name: string, rules: ImageRules) {
  const normalized = (value: string) => value.replace(/^\\\\\?\\UNC\\/i, '//').replace(/^\\\\\?\\/, '').replace(/\\/g, '/')
  let target = normalized(path)
  const base = normalized(documentPath).split('/').slice(0, -1)
  const parts = target.split('/')
  const windows = /^[a-z]:\//i.test(target) || target.startsWith('//')
  const equal = (a: string, b: string) => windows ? a.toLowerCase() === b.toLowerCase() : a === b
  const sameRoot = windows ? equal(base[0],parts[0]) && (!target.startsWith('//') || equal(base[2],parts[2]) && equal(base[3],parts[3])) : base[0] === '' && parts[0] === ''
  if (rules.relative && sameRoot) {
    let common = 0
    while (common < base.length && common < parts.length && equal(base[common],parts[common])) common++
    target = [...base.slice(common).map(() => '..'), ...parts.slice(common)].join('/')
    if (rules.dotPrefix && !target.startsWith('../')) target = './' + target
  }
  if (rules.escape) target = target.split('/').map((part,index) => index === 0 && /^[a-z]:$/i.test(part) ? part : encodeURIComponent(part).replace(/[!'()*]/g, ch => '%' + ch.charCodeAt(0).toString(16).toUpperCase())).join('/')
  else target = '<' + target.replace(/[%<>\r\n]/g, ch => encodeURIComponent(ch)) + '>'
  const alt = name.replace(/\.[^.]+$/, '').replace(/[\\[\]]/g, '\\$&').replace(/[\r\n]/g, ' ')
  return `![${alt}](${target})`
}

interface Bookmark { key: number; from: number; to: number }
const bookmark = StateEffect.define<Bookmark | number>()
export const imageImportBookmarks = StateField.define<Map<number, Bookmark>>({
  create: () => new Map(),
  update(value, tr) {
    const next = new Map([...value].map(([key,b]) => [key,{...b,from:tr.changes.mapPos(b.from,1),to:tr.changes.mapPos(b.to,1)}]))
    for (const effect of tr.effects) if (effect.is(bookmark)) {
      if (typeof effect.value === 'number') next.delete(effect.value)
      else next.set(effect.value.key, effect.value)
    }
    return next
  },
})
export interface NativeImageInput { token: string; name: string }
export type ImageSource = NativeImageInput | File
interface ImportResult { path: string; name: string }
export interface ImageGateway {
  import(input: { token: string; sourceToken?: string; bytes?: number[]; name: string; directory: string | null }): Promise<ImportResult>
  authorize(token: string, relative: string): Promise<boolean>
  release(tokens: string[]): Promise<unknown>
}
export const imageGateway: ImageGateway = {
  import: input => invoke('import_markdown_image', { input }),
  authorize: (token, relative) => invoke('authorize_markdown_image_directory', { token, relative }),
  release: tokens => invoke('release_image_inputs', { tokens }),
}
let sequence = 0
/** Every ingress uses this service; bookmarks track intervening CodeMirror transactions. */
export class ImageImporter {
  constructor(private manager: DocumentManager, private gateway: ImageGateway, private save: (id: string) => Promise<boolean>, private rules: (id: string) => ImageRules) {}
  async insert(id: string, input: ImageSource[] | (() => Promise<ImageSource[]>)) {
    const key = ++sequence, manager = this.manager
    let sources: ImageSource[] = Array.isArray(input) ? input : []
    const tokens = () => sources.filter((s): s is NativeImageInput => 'token' in s).map(s => s.token)
    const state = manager.getState(id)
    if (!state || state.readOnly || manager.isComposing) { await this.gateway.release(tokens()); return }
    const range = state.selection.main
    manager.pin(id)
    manager.dispatch(id, { effects: bookmark.of({key,from:range.from,to:range.to}), annotations: Transaction.addToHistory.of(false) })
    try {
      if (typeof input === 'function') sources = await input()
      if (!sources.length) return
      if (!manager.metadata(id)?.fileToken && !await this.save(id)) return
      const doc = manager.metadata(id)
      if (!doc?.fileToken || !doc.path || !/\.(md|markdown)$/i.test(doc.name)) throw new Error('图片导入需要先将文档保存为 .md 或 .markdown。')
      const rules = this.rules(id)
      const references: string[] = []
      for (const source of sources) {
        const native = 'token' in source
        if (!native && source.size > 100 * 1024 * 1024) throw new Error('图片超过 100 MiB 上限。')
        const directory = imageDirectory(rules,doc.name,!native)
        const input = { token:doc.fileToken, name:source.name, directory, ...(native ? {sourceToken:source.token} : {bytes:Array.from(new Uint8Array(await source.arrayBuffer()))}) }
        let result: ImportResult
        try { result = await this.gateway.import(input) }
        catch (error) {
          if (!directory || !error || typeof error !== 'object' || !('code' in error) || error.code !== 'image_directory_permission') throw error
          if (!await this.gateway.authorize(doc.fileToken,directory)) return
          result = await this.gateway.import(input)
        }
        if (manager.metadata(id)?.path !== doc.path || manager.metadata(id)?.fileToken !== doc.fileToken) throw new Error(`导入期间文档位置变化，未插入过期路径。图片已保存至：${result.path}`)
        if (manager.isComposing) throw new Error(`请完成输入法输入后重新插入；图片已保存至：${result.path}`)
        references.push(imageMarkdown(result.path,doc.path,result.name,rules))
      }
      const current = manager.getState(id), mapped = current?.field(imageImportBookmarks).get(key)
      if (!mapped || !references.length) return
      const textBefore = current!.doc.sliceString(0, mapped.from).split('\n').at(-1) || ''
      const textAfter = current!.doc.sliceString(mapped.to).split('\n')[0]
      const inline = /\S/.test(textBefore + textAfter)
      const text = inline ? references.join(' ') : references.join('\n\n') + '\n'
      manager.dispatch(id, { changes: { from: mapped.from, to: mapped.to, insert: text },
        selection: { anchor: mapped.from + text.length }, effects: refreshMarkdownResources.of(null),
        annotations: isolateHistory.of('full'), userEvent: 'input.image' })
    } finally {
      if (manager.getState(id)) manager.dispatch(id, { effects:bookmark.of(key), annotations:Transaction.addToHistory.of(false) })
      await this.gateway.release(tokens())
    }
  }
}

export const isImageFile = (name: string) => /\.(png|jpe?g|gif|webp|svg)$/i.test(name)

/** CF_HDROP has priority over a thumbnail bitmap on Windows. */
export async function clipboardImages(): Promise<ImageSource[]> {
  if (!isTauri()) return []
  const files = await invoke<NativeImageInput[]>('clipboard_image_files')
  if (files.length) {
    const images = files.filter(file => isImageFile(file.name))
    await imageGateway.release(files.filter(file => !isImageFile(file.name)).map(file => file.token))
    return images
  }
  const { readImage } = await import('@tauri-apps/plugin-clipboard-manager')
  let image: Awaited<ReturnType<typeof readImage>>
  try { image = await readImage() } catch (error) {
    // arboard's no-image error is expected when pasting ordinary text.
    if (/not available|does not contain|no image|not found|No matching/i.test(String(error))) return []
    throw error
  }
  try {
    const {width,height} = await image.size()
    if (!width || !height || width > 65535 || height > 65535 || width * height > 150_000_000) throw new Error('剪贴板图片尺寸超过安全范围。')
    const rgba = await image.rgba()
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height
    try {
      canvas.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(rgba),width,height),0,0)
      const blob = await new Promise<Blob>((resolve,reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('截图编码失败。')),'image/png'))
      if (blob.size > 50 * 1024 * 1024) throw new Error('剪贴板图片超过 50 MiB 上限。')
      return [new File([blob],`image-${Date.now()}.png`,{type:'image/png'})]
    } finally { canvas.width = canvas.height = 0 }
  } finally { await image.close() }
}
