import { menuCommand, type MenuCommand, type MenuNode } from '../shell/menuModel'

export const workspaceFileTypes = {
  text: { label: '文本文件', extension: '.txt' },
  markdown: { label: 'Markdown 文件', extension: '.md' },
  file: { label: '文件', extension: '' },
}

export type WorkspaceFileType = keyof typeof workspaceFileTypes

export function workspaceFileCreationMenu(create: (type: WorkspaceFileType) => void | Promise<void>) {
  const commands: MenuCommand[] = (Object.keys(workspaceFileTypes) as WorkspaceFileType[]).map(type => ({
    id: `workspace-new-${type}`,
    title: workspaceFileTypes[type].label,
    enabled: true,
    run: () => create(type),
  }))
  const item: MenuNode = {
    type: 'submenu', id: 'workspace-new-file', label: '新建文件',
    children: commands.map(command => menuCommand(command.id)),
  }
  return { commands, item }
}
