import { menuCommand as cmd, separator as sep, recentFileCommand, recentWorkspaceCommand, type MenuNode, type MenuGroup } from './menuModel'
import { readablePath } from './pathDisplay'
import type { MarkdownMode } from '../../types'
export interface MainMenuState {
  sidebar: boolean; outline: boolean; wrap: boolean; split: boolean; focus: boolean; typewriter?: boolean
  markdown: boolean; markdownMode?: MarkdownMode; composing: boolean
  recentFiles: { path:string; name:string }[]; recentWorkspaces: string[]
  canExport?: boolean
}
export function mainMenu(state: MainMenuState): MenuGroup[] {
  const submenu = (id: string, label: string, children: MenuNode[], enabled = true): MenuNode => ({type:'submenu',id,label,children,enabled})
  const checkbox = (id: string, label: string, checked: boolean): MenuNode => ({type:'checkbox',id,commandId:id,label,checked})
  // Menu state is built from persisted recents. Missing or malformed records
  // degrade to an empty submenu; they must never throw while App.vue renders.
  const recentFiles = Array.isArray(state.recentFiles) ? state.recentFiles.filter(file => !!file && typeof file.path === 'string') : []
  const recentWorkspaces = Array.isArray(state.recentWorkspaces) ? state.recentWorkspaces.filter((path): path is string => typeof path === 'string') : []
  const baseName = (path: string) => readablePath(path).split(/[\\/]/).filter(Boolean).pop() || readablePath(path)
  // Command-backed Markdown formats use their canonical command id so the menu,
  // the palette and the shortcut settings resolve to a single catalog entry.
  // `menuOnlyFormat` covers the formats that have no configurable command.
  const menuOnlyFormat = (id: string, label?: string) => cmd(`format-${id}`, label)
  const heading = (level: number, label: string) => cmd(`heading-${level}`, label)
  return [
    {id:'file',title:'文件',items:[cmd('new','新建文件'),cmd('new-markdown','新建 Markdown'),cmd('open','打开文件…'),
      submenu('recent-files','最近打开',recentFiles.map(file => cmd(recentFileCommand(file.path), file.name + (recentFiles.filter(other => other.name === file.name).length > 1 ? ` — ${readablePath(file.path).split(/[\\/]/).slice(-2,-1)[0]}` : '')))),
      submenu('workspace-menu','工作区',[cmd('open-workspace','打开文件夹…'),cmd('add-workspace','添加文件夹…'),
        submenu('recent-workspaces','最近工作区',recentWorkspaces.map(path => cmd(recentWorkspaceCommand(path),baseName(path)))),
        sep('workspace-search-section'),cmd('workspace-search'),cmd('workspace-replace'),cmd('refresh-workspace')]),
      sep('save-section'),cmd('save','保存'),cmd('save-as','另存为…'),cmd('history','历史版本…'),
      sep('import-section'),
      submenu('import-menu', '导入', [
        cmd('import-html', 'HTML'),
        cmd('import-docx', 'Word (.docx)'),
      ]),

      submenu('export-menu', '导出', [
        cmd('export-pdf', 'PDF'),
        cmd('export-html', 'HTML'),
        cmd('export-html-plain', 'HTML（无主题样式）'),
        cmd('export-docx', 'Word (.docx)'),
        cmd('export-png', 'PNG 长图'),
        sep('export-repeat-section'),
        cmd('export-repeat', '使用上一次设置导出'),
        cmd('export-settings', '导出设置…'),
      ], state.canExport ?? state.markdown),
      sep('close-section'),cmd('close-current','关闭文件'),cmd('quit','退出')]},
    {id:'edit',title:'编辑',items:[cmd('undo'),cmd('redo'),sep('clipboard-section'),cmd('cut'),cmd('copy'),cmd('paste'),cmd('select-all'),
      sep('search-section'),cmd('find','查找'),cmd('replace','替换'),cmd('workspace-search','在文件中查找…'),cmd('workspace-replace','在文件中替换…'),cmd('directory-search','在此目录中查找…'),cmd('directory-replace','在此目录中替换…'),cmd('goto-line','跳转行…')]},
    {id:'format',title:'格式',items:[cmd('bold'),cmd('italic'),cmd('strike'),cmd('inline-code'),sep('structure-section'),
      submenu('headings','标题',Array.from({length:6},(_,i) => heading(i+1,`H${i+1} · ${['一级','二级','三级','四级','五级','六级'][i]}标题`)),state.markdown && !state.composing),
      submenu('lists','列表',[menuOnlyFormat('bullet'),menuOnlyFormat('ordered'),menuOnlyFormat('task')],state.markdown && !state.composing),
      submenu('blocks','块级元素',[cmd('quote'),cmd('code-block'),menuOnlyFormat('rule')],state.markdown && !state.composing),
      sep('insert-section'),cmd('link','插入链接'),cmd('image','插入图片'),cmd('table','插入表格')]},
    {id:'view',title:'视图',items:[checkbox('sidebar','显示侧边栏',state.sidebar),checkbox('toggle-outline','显示文档大纲',state.outline),checkbox('wrap','自动换行',state.wrap),
      sep('mode-section'),submenu('markdown-mode','Markdown 编辑模式',(['live','source','split'] as const).map(mode => ({type:'radio',id:`mode-${mode}`,commandId:`md-mode-${mode}`,group:'markdown-mode',checked:state.markdownMode === mode,label:{live:'实时排版',source:'源码编辑',split:'双栏预览'}[mode]})),state.markdown),
      submenu('editor-layout','编辑器布局',[
        cmd('split-editor','向右拆分'),
        cmd('split-down','向下拆分'),
        cmd('maximize-pane','最大化当前编辑器'),
        cmd('restore-pane','恢复编辑器布局'),
        cmd('merge-panes','合并所有分栏'),
      ]),
      checkbox('toggle-focus','专注模式',state.focus),checkbox('toggle-typewriter','打字机模式',!!state.typewriter)]},
  ]
}
