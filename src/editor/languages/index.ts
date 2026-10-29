import type { Extension } from '@codemirror/state'
import { StreamLanguage, LanguageDescription, LanguageSupport, type StreamParser } from '@codemirror/language'

interface LanguageDefinition {
  id: string; name: string; extensions: readonly string[]; aliases: readonly string[]; filenames: readonly string[]
  highlights: boolean; fallback: 'plain-text-with-error'; load: (fence?:boolean) => Promise<Extension>
  parser: 'lezer' | 'stream' | 'none'; coverage: 'full' | 'partial' | 'plain'
}
const stream = (parser: StreamParser<unknown>) => new LanguageSupport(StreamLanguage.define(parser))
const entry = <N extends string>(id: string, name: N, extensions: string[], aliases: string[], load: (fence?:boolean) => Promise<Extension>, filenames: string[] = [], highlights = true) =>
  ({ id, name, extensions, aliases, filenames, highlights, fallback: 'plain-text-with-error', load,
    parser: highlights ? 'lezer' : 'none', coverage: highlights ? 'full' : 'plain' } as const satisfies LanguageDefinition)
const lexical = <N extends string>(id: string, name: N, extensions: string[], aliases: string[], load: (fence?:boolean) => Promise<Extension>, filenames: string[] = []) =>
  ({...entry(id, name, extensions, aliases, load, filenames), parser: 'stream', coverage: 'partial'} as const satisfies LanguageDefinition)

// One registry for filenames, fences, Source codeLanguages and both selectors.
// Explicit dynamic imports keep every unused parser out of the startup bundle.
export const languageRegistry = [
  entry('text', 'Plain Text', ['txt', 'text'], ['text', 'plain', 'plaintext'], async () => [], [], false),
  entry('markdown', 'Markdown', ['md', 'markdown', 'mdown'], ['md', 'gfm'], loadMarkdown),
  lexical('jade', 'Jade', ['jade', 'pug'], ['pug'], async () => {
    const {pug} = await import('@codemirror/legacy-modes/mode/pug')
    return stream({...pug, token(input, state) {
      const token = pug.token(input, state)
      return token === 'indent' ? null : token
    }})
  }),
  lexical('batch', 'Batch', ['bat', 'cmd'], ['bat', 'cmd', 'dos'], async () => (await import('./batch')).batch()),
  entry('json', 'JSON', ['json'], [], async () => (await import('@codemirror/lang-json')).json()),
  lexical('jsonc', 'JSONC', ['jsonc'], [], async () => (await import('./structured')).jsonc()),
  entry('yaml', 'YAML', ['yaml', 'yml'], ['yml'], async () => (await import('./yaml')).yaml()),
  lexical('toml', 'TOML', ['toml'], [], async () => (await import('./toml')).toml()),
  entry('javascript', 'JavaScript', ['js', 'mjs', 'cjs'], ['js', 'text/javascript'], async () => (await import('./javascript')).javascript()),
  entry('typescript', 'TypeScript', ['ts', 'mts', 'cts'], ['ts'], async () => (await import('./javascript')).javascript({ typescript: true })),
  entry('jsx', 'JSX', ['jsx'], ['react'], async () => (await import('./javascript')).javascript({ jsx: true })),
  entry('tsx', 'TSX', ['tsx'], [], async () => (await import('./javascript')).javascript({ typescript: true, jsx: true })),
  entry('vue', 'Vue', ['vue'], ['vue.js', 'vue-template'], async () => (await import('./html')).vue()),
  entry('html', 'HTML', ['html', 'htm'], ['htmlmixed'], async () => (await import('./html')).html()),
  entry('css', 'CSS', ['css'], [], async () => (await import('./native')).css()),
  lexical('scss', 'SCSS', ['scss'], [], async () => stream((await import('@codemirror/legacy-modes/mode/css')).sCSS)),
  lexical('less', 'Less', ['less'], [], async () => stream((await import('@codemirror/legacy-modes/mode/css')).less)),
  entry('python', 'Python', ['py', 'pyw'], ['py', 'python3'], async () => (await import('./native')).python()),
  entry('go', 'Go', ['go'], ['golang'], async () => (await import('./native')).go()),
  entry('rust', 'Rust', ['rs'], ['rs'], async () => (await import('./native')).rust()),
  entry('java', 'Java', ['java'], [], async () => {
    const [{javaLanguage},{styleTags,tags},{syntaxTags}] = await Promise.all([import('@codemirror/lang-java'),import('@lezer/highlight'),import('../core/syntaxTheme')])
    return new LanguageSupport(javaLanguage.configure({props:[styleTags({
      'ClassDeclaration/Definition InterfaceDeclaration/Definition EnumDeclaration/Definition RecordDeclaration/Definition': tags.definition(tags.className),
      'MethodDeclaration/Definition MethodName/Identifier': tags.function(tags.propertyName),
      'FieldAccess/Identifier': tags.propertyName,
      'FormalParameter/Definition': syntaxTags.parameter,
      'Annotation/Identifier': tags.annotation,
    })]}))
  }),
  lexical('c', 'C', ['c', 'h'], ['h'], async () => stream((await import('@codemirror/legacy-modes/mode/clike')).c)),
  entry('cpp', 'C++', ['cpp', 'cc', 'cxx', 'hpp', 'hh', 'hxx'], ['cpp', 'cc', 'cxx', 'hpp'], async () => (await import('@codemirror/lang-cpp')).cpp()),
  lexical('csharp', 'C#', ['cs', 'csx'], ['cs', 'csharp'], async () => stream((await import('@codemirror/legacy-modes/mode/clike')).csharp)),
  lexical('kotlin', 'Kotlin', ['kt', 'kts'], ['kt'], async () => stream((await import('@codemirror/legacy-modes/mode/clike')).kotlin)),
  lexical('swift', 'Swift', ['swift'], [], async () => stream((await import('@codemirror/legacy-modes/mode/swift')).swift)),
  entry('php', 'PHP', ['php', 'phtml'], ['php+html'], async fence => (await import('@codemirror/lang-php')).php({plain:fence===true})),
  lexical('ruby', 'Ruby', ['rb', 'rake', 'gemspec'], ['rb'], async () => stream((await import('@codemirror/legacy-modes/mode/ruby')).ruby), ['Gemfile', 'Rakefile']),
  lexical('dart', 'Dart', ['dart'], [], async () => stream((await import('@codemirror/legacy-modes/mode/clike')).dart)),
  lexical('shell', 'Shell', ['sh', 'bash', 'zsh'], ['sh', 'bash', 'zsh'], async () => stream((await import('@codemirror/legacy-modes/mode/shell')).shell), ['.bashrc', '.zshrc', '.profile', '.bash_profile', '.zprofile']),
  lexical('powershell', 'PowerShell', ['ps1', 'psm1', 'psd1'], ['ps1', 'pwsh'], async () => stream((await import('@codemirror/legacy-modes/mode/powershell')).powerShell)),
  lexical('dockerfile', 'Dockerfile', ['dockerfile'], ['docker'], async () => stream((await import('@codemirror/legacy-modes/mode/dockerfile')).dockerFile), ['Dockerfile', 'Containerfile']),
  lexical('makefile', 'Makefile', ['mk', 'mak'], ['make'], async () => (await import('./makefile')).makefile(), ['Makefile', 'GNUmakefile']),
  entry('sql', 'SQL', ['sql'], [], async () => (await import('@codemirror/lang-sql')).sql()),
  entry('mysql', 'MySQL', [], ['mariadb'], async () => { const m = await import('@codemirror/lang-sql'); return m.sql({ dialect: m.MySQL }) }),
  entry('postgresql', 'PostgreSQL', ['pgsql'], ['postgres', 'pgsql'], async () => { const m = await import('@codemirror/lang-sql'); return m.sql({ dialect: m.PostgreSQL }) }),
  entry('plsql', 'PL/SQL', ['pls', 'plsql', 'pks', 'pkb'], ['plsql', 'pl/sql'], async () => { const m = await import('@codemirror/lang-sql'); return m.sql({ dialect: m.PLSQL }) }),
  entry('xml', 'XML', ['xml', 'svg', 'xsd'], [], async () => (await import('@codemirror/lang-xml')).xml()),
  lexical('ini', 'INI', ['ini', 'cfg', 'properties', 'env'], ['properties', 'dotenv'], async () => (await import('./structured')).ini(), ['.env', '.editorconfig']),
  lexical('ignore', 'Ignore', [], ['gitignore', 'dockerignore'], async () => (await import('./structured')).ignore(), ['.gitignore', '.dockerignore', '.ignore']),
  lexical('lua', 'Lua', ['lua'], [], async () => stream((await import('@codemirror/legacy-modes/mode/lua')).lua)),
  lexical('perl', 'Perl', ['pl', 'pm'], [], async () => stream((await import('@codemirror/legacy-modes/mode/perl')).perl)),
  lexical('r', 'R', ['r'], ['rlang', 'r-lang'], async () => stream((await import('@codemirror/legacy-modes/mode/r')).r)),
  lexical('diff', 'Diff', ['diff', 'patch'], ['patch'], async () => stream((await import('@codemirror/legacy-modes/mode/diff')).diff)),
  lexical('cmake', 'CMake', ['cmake'], [], async () => (await import('./native')).cmake(), ['CMakeLists.txt']),
  lexical('mermaid', 'Mermaid', ['mmd', 'mermaid'], [], async () => (await import('./structured')).mermaid()),
  lexical('csv', 'CSV', ['csv'], [], async () => (await import('./structured')).csv()),
  lexical('log', 'Log', ['log'], [], async () => (await import('./structured')).log()),
] as const
export type LanguageName = typeof languageRegistry[number]['name']
export const languageNames = languageRegistry.map(language => language.name)
const byName = new Map<string, typeof languageRegistry[number]>()
for (const language of languageRegistry) for (const key of [language.id, language.name, ...language.aliases]) byName.set(key.toLowerCase(), language)

export function resolveLanguage(label: string) { return byName.get(label.trim().toLowerCase()) }
export function parseFenceInfo(info: string) {
  const match = /^(\s*)(\S+)?([\s\S]*)$/.exec(info)!
  return { label: match[2] || '', parameters: match[3] || '', language: resolveLanguage(match[2] || '') }
}
export function fenceLanguage(info: string): LanguageName { return parseFenceInfo(info).language?.name || 'Plain Text' }
export function detectLanguage(name: string): LanguageName {
  const filename = (name.split(/[\\/]/).pop() || name).toLowerCase()
  const exact = languageRegistry.find(language => language.filenames.some(f => f.toLowerCase() === filename))
  if (exact) return exact.name
  if (filename.startsWith('.env.')) return 'INI'
  if (/^(?:dockerfile|containerfile)\./i.test(filename)) return 'Dockerfile'
  const ext = filename.includes('.') ? filename.split('.').pop()! : ''
  return languageRegistry.find(language => language.extensions.some(e => e === ext))?.name || 'Plain Text'
}
async function loadMarkdown(): Promise<Extension> {
  const [{ markdown }, { markdownSmartEditing }, { markdownSyntaxExtensions }] = await Promise.all([import('@codemirror/lang-markdown'), import('../markdown/smartEditing'), import('../markdown/semantics')])
  const codeLanguages = languageRegistry.filter(language => language.highlights && language.name !== 'Markdown').map(language => LanguageDescription.of({
    name: language.name, alias: [...language.aliases, language.id], extensions: [...language.extensions],
    load: async () => await loadLanguage(language.name,'fence') as LanguageSupport,
  }))
  const support = markdown({ extensions: markdownSyntaxExtensions, codeLanguages, addKeymap: false })
  return new LanguageSupport(support.language, [support.support, markdownSmartEditing])
}
export function createLanguageLoader() {
  const pending = new Map<string, Promise<Extension>>()
  return (name: LanguageName, context:'file'|'fence'='file') => {
    const key=`${name}:${context}`
    let result = pending.get(key)
    if (!result) {
      result = Promise.resolve().then(() => {
        const language = resolveLanguage(name)
        if (!language) throw new Error('未注册语言；使用纯文本。')
        return language.load(context==='fence')
      }).catch(error => { pending.delete(key); throw error })
      pending.set(key, result)
    }
    return result
  }
}
export const loadLanguage = createLanguageLoader()
