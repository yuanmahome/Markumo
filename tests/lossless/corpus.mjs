import fs from 'node:fs'
const names = ['complex', 'boundaries', 'unclosed-fence', 'extensions']
export const corpus = names.map(name => ({ name, source: fs.readFileSync(new URL(`./fixtures/${name}.md`, import.meta.url), 'utf8').replace(/\r\n/g, '\n') }))
corpus.push({ name: 'empty', source: '' }, { name: 'newlines-only', source: '\n\n\n\n\n' },
  { name: 'spaces-tabs', source: ' \t\n\t\n\n# 标题\n\n \t\n\n\t\n\nLOCAL_EDIT_TARGET\n \t\n' },
  { name: 'no-eof', source: '# 标题\n\nLOCAL_EDIT_TARGET 中文 😀 é' },
  { name: 'many-eof', source: '# 标题\n\nLOCAL_EDIT_TARGET\n\n\n\n\n' },
  { name: 'nested-table', source: '+ 外层\n\n  | A | B |\n  | :- | -: |\n  | CELL_EDIT_TARGET | `x\\|y` |\n\n  > NESTED_EDIT_TARGET\n\nEND_SENTINEL\n' })
export const eolVariants = corpus.flatMap(item => [item, { name: item.name + '-crlf', source: item.source.replace(/\n/g, '\r\n') }])
