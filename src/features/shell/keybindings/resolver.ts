import type { KeymapPresetId, KeybindingContext } from './contracts'
import { allCommands, commandMap } from './definitions'
import { normalizeKeybinding } from './normalizer'
import { getPresetBindings } from './presets'

/** The contextual paragraph command intentionally takes Mod+0 before zoom reset.
 * No other overlap is implicit; a user reassignment removes every overlapping owner. */
export function intentionalOverlap(a: string, b: string, binding: string) {
  return binding === 'Mod+0' && [a,b].includes('heading-0') && [a,b].includes('zoom-reset')
}
export function commandsOverlap(a: string, b: string): boolean {
  const left = commandMap.get(a), right = commandMap.get(b)
  if (!left || !right || !left.supported || !right.supported) return false
  return !!left.contexts?.some(context => right.contexts?.includes(context))
}
export function effectiveBindings(id:string, bindings:Record<string,string>) {
  const command=commandMap.get(id), binding=normalizeKeybinding(bindings[id] || '')
  if (!binding) return []
  return [binding,...(binding===normalizeKeybinding(command?.defaultBinding || '') ? command?.defaultAliases || [] : [])]
}
export function matchingCommand(binding: string, bindings: Record<string,string>, context: KeybindingContext) {
  if (!binding) return undefined
  const eligible=allCommands.filter(command=>command.supported && command.contexts?.includes(context))
  const exact=eligible.filter(command=>bindings[command.id]===binding)
  return (exact.length ? exact : eligible.filter(command=>effectiveBindings(command.id,bindings).includes(binding)))
    .sort((a,b) => (a.contexts?.length || 0) - (b.contexts?.length || 0))[0]
}
export function reassignBinding(bindings: Record<string,string>, id: string, raw: string) {
  const binding = normalizeKeybinding(raw)
  if (!binding || !commandMap.get(id)?.userOverridable) return null
  const next = {...bindings}
  for (const other of Object.keys(next)) if (other !== id && effectiveBindings(other,next).includes(binding) && commandsOverlap(id,other)) next[other] = ''
  next[id] = binding
  return next
}

/** Aliases owned by configurable commands in the editor kernels. Only these
 * keys are suppressed after rebinding; native cursor/clipboard/IME remain. */
const kernelAliases: Record<string,string[]> = {
  redo:['Mod+Shift+Z'], strike:['Mod+Shift+X'], 'inline-code':['Mod+`'],
  'code-block':['Mod+Shift+K'],
  ...Object.fromEntries([1,2,3,4,5,6].map(level => ['heading-'+level,['Mod+Alt+'+level]])),
}
export function isManagedDefault(binding: string, context: KeybindingContext, preset:KeymapPresetId = 'markumo') {
  if (!binding) return false
  const defaults = getPresetBindings(preset)
  return allCommands.some(command => command.contexts?.includes(context) &&
    [defaults[command.id],normalizeKeybinding(command.defaultBinding || ''),...(command.defaultAliases || []),...(kernelAliases[command.id] || [])].includes(binding))
}
export function keybindingContext(target: EventTarget | null, markdown: boolean): KeybindingContext {
  if (!(target instanceof Element)) return 'shell'
  if (target.closest('[role=dialog],.settingsoverlay,.workspace-operation-dialog')) return 'dialog'
  if (target.closest('.cm-search,.md-search,.md-live-search,.fleet-search')) return 'search'
  if (target.closest('input,textarea,select,.md-inline-source-input')) return 'input'
  if (target.closest('.markdown-live .cm-editor,.md-code-block .cm-editor,.md-html-block-view .cm-editor,.md-html-inline-view .cm-editor')) return 'code-block'
  if (target.closest('.cm-content')) return markdown ? 'source' : 'text'
  if (target.closest('.md-prose')) return 'live'
  return 'shell'
}
