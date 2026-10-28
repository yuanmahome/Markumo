<template>
  <Transition name="fade">
    <div v-if="visible" class="settingsoverlay" @click.self="close" @keydown.stop="handleKeydown">
      <div ref="dialogRef" class="settings" role="dialog" aria-modal="true" aria-label="首选项设置">
        <header class="settings-head">
          <div class="settings-title"><Icon name="gear" /><h2>设置</h2></div>
          <button class="icon-button" aria-label="关闭设置" title="关闭" @click="close"><Icon name="close" /></button>
        </header>
        <div class="settings-body">
          <nav class="settings-nav" aria-label="设置分类">
            <button v-for="section in sections" :key="section.id" :aria-label="section.title" :aria-current="activeSection === section.id ? 'location' : undefined" :aria-controls="`settings-${section.id}`" :class="{ active: activeSection === section.id }" @click="goToSection(section.id)">
              <Icon :name="section.icon" size="small" /><span>{{ section.title }}</span>
            </button>
          </nav>
          <div ref="contentRef" class="settings-content" tabindex="0" aria-label="设置内容">
            <!-- 1. 外观 -->
            <section id="settings-appearance" class="settings-section">
              <h3>外观</h3>
              <div class="settingrow"><span class="setting-label">颜色主题</span><SegmentedControl id="settings-theme" label="颜色主题" :model-value="theme" :options="[{value:'light',label:'浅色'},{value:'dark',label:'深色'},{value:'system',label:'跟随系统'}]" @update:model-value="emit('update:theme', $event as ThemePreference)" /></div>
              <div class="settingrow"><span class="setting-label">语法高亮风格</span><SegmentedControl id="settings-syntax-style" label="语法高亮风格" :model-value="syntaxStyle || 'soft'" :options="[{value:'soft',label:'柔和'},{value:'standard',label:'标准'},{value:'vivid',label:'鲜明'}]" @update:model-value="emit('update:syntaxStyle', $event as EditorSettings['syntaxStyle'])" /></div>
              <div class="settingrow"><label for="settings-ui-size">界面字号</label><div class="number-control"><input id="settings-ui-size" type="number" min="12" max="20" step="1" :value="uiFontDraft" :aria-invalid="!!uiFontError" aria-describedby="ui-font-hint" @input="updateUiFont" @blur="finishUiFont" @keydown.enter.prevent="finishUiFont" /><span>px</span><button class="reset-font" title="恢复默认界面字号 14px" aria-label="恢复默认界面字号" @click="emit('update:uiFontSize', 14)">恢复默认</button></div></div>
              <p v-if="uiFontError" class="field-error" role="alert">{{ uiFontError }}</p>
              <p id="ui-font-hint" class="setting-hint">仅调整界面文字；编辑器与 Markdown 正文字号分别设置。</p>
              <div class="settingrow"><label for="settings-font">编辑器字体</label><select id="settings-font" :value="fontFamily" @change="$emit('update:fontFamily', ($event.target as HTMLSelectElement).value as EditorSettings['fontFamily'])"><option value="system">系统等宽字体</option><option value="consolas">Consolas</option><option value="cascadia">Cascadia Code</option></select></div>
              <div class="settingrow"><label for="settings-size">编辑器字号</label><div class="number-control"><input id="settings-size" type="number" min="10" max="24" step="1" :value="fontDraft" :aria-invalid="!!fontError" @input="updateFont" @blur="finishFont" @keydown.enter.prevent="finishFont" /><span>px</span></div></div>
              <p v-if="fontError" class="field-error" role="alert">{{ fontError }}</p>
            </section>

            <!-- 2. 编辑 -->
            <section id="settings-editor" class="settings-section">
              <h3>编辑</h3>
              <div class="settingrow"><span class="setting-label">括号高亮</span><SegmentedControl id="settings-bracket-mode" label="括号高亮" :model-value="bracketMode || 'matching'" :options="[{value:'off',label:'关闭'},{value:'matching',label:'仅匹配'},{value:'rainbow',label:'彩虹括号'}]" @update:model-value="emit('update:bracketMode', $event as EditorSettings['bracketMode'])" /></div>
              <div class="settingrow"><span class="setting-label">光标动画</span><SegmentedControl id="settings-caret-animation" label="光标动画" :model-value="caretAnimation" :options="[{value:'off',label:'关闭'},{value:'quick',label:'快速跟手'},{value:'smooth',label:'平滑滑动'}]" @update:model-value="emit('update:caretAnimation', $event as EditorSettings['caretAnimation'])" /></div>
              <div class="settingrow"><label for="settings-wrap">自动软换行</label><input id="settings-wrap" class="setting-switch" type="checkbox" :checked="wordWrap" @change="$emit('update:wordWrap', ($event.target as HTMLInputElement).checked)" /></div>
              <div class="settingrow"><span class="setting-label">打字机模式</span><SegmentedControl id="settings-typewriter-mode" label="打字机模式" :model-value="typewriterMode ? 'on' : 'off'" :options="[{value:'off',label:'关闭（默认）'},{value:'on',label:'开启'}]" @update:model-value="emit('update:typewriterMode', $event === 'on')" /></div>
              <p class="setting-hint">开启后光标保持在可视阅读区域中部，用户持续输入时自然跟随，手动滚动时不抢回视口。</p>
              <div class="settingrow"><label for="settings-outline">显示文档大纲</label><input id="settings-outline" class="setting-switch" type="checkbox" :checked="showOutline" @change="$emit('update:showOutline', ($event.target as HTMLInputElement).checked)" /></div>
              <div class="settingrow"><label for="settings-indent">缩进宽度</label><div class="indent-control"><SegmentedControl label="常用缩进宽度" :model-value="indentSize" :options="[2,4,8].map(value=>({value,label:String(value)}))" @update:model-value="emit('update:indentSize',Number($event))" /><input id="settings-indent" type="number" min="1" max="8" :value="indentSize" aria-label="缩进宽度 1 至 8" @change="updateIndent" /></div></div>
              <div class="settingrow"><label for="settings-tabs">使用 Tab 缩进</label><input id="settings-tabs" class="setting-switch" type="checkbox" :checked="useTabs" @change="$emit('update:useTabs', ($event.target as HTMLInputElement).checked)" /></div>
            </section>

            <section id="settings-workspace" class="settings-section">
              <h3>工作区</h3>
              <div class="settingrow"><span class="setting-label">文件夹展开方式</span><SegmentedControl id="settings-tree-click" label="文件夹展开方式" :model-value="treeClickMode || 'single'" :options="[{value:'single',label:'单击（默认）'},{value:'double',label:'双击'}]" @update:model-value="emit('update:treeClickMode', $event as 'single' | 'double')" /></div>
              <p class="setting-hint">默认单击文件夹整行展开或收起；箭头始终单击切换。文件单击预览，双击固定；修改后自动固定标签。</p>
              <div class="settingrow"><span class="setting-label">自动跟随当前文件</span><SegmentedControl id="settings-auto-follow" label="自动跟随当前文件" :model-value="autoFollowActiveFile ? 'on' : 'off'" :options="[{value:'off',label:'关闭（默认）'},{value:'on',label:'开启'}]" @update:model-value="emit('update:autoFollowActiveFile', $event === 'on')" /></div>
              <p class="setting-hint">关闭时，切换标签保留目录树的浏览位置。点击“定位当前文件”可主动展开并定位；开启后仅在必要时滚动。</p>
              <div class="settingrow"><span class="setting-label">智能展开单子目录</span><SegmentedControl id="settings-smart-expand" label="智能展开单子目录" :model-value="smartExpand ? 'on' : 'off'" :options="[{value:'on',label:'开启（默认）'},{value:'off',label:'关闭'}]" @update:model-value="emit('update:smartExpand', $event === 'on')" /></div>
              <p class="setting-hint">展开文件夹时自动打开连续的单子目录。</p>
              <div class="settingrow"><span class="setting-label">紧凑文件夹</span><SegmentedControl id="settings-compact-folders" label="紧凑文件夹" :model-value="compactFolders ? 'on' : 'off'" :options="[{value:'off',label:'关闭（默认）'},{value:'on',label:'开启'}]" @update:model-value="emit('update:compactFolders', $event === 'on')" /></div>
              <p class="setting-hint">将连续单子目录合并为一行。</p>
            </section>

            <section id="settings-updates" class="settings-section">
              <h3>应用更新</h3>
              <div class="settingrow"><label for="settings-update-check">自动检查更新</label><input id="settings-update-check" class="setting-switch" type="checkbox" :checked="autoCheckUpdates" @change="emit('update:autoCheckUpdates', ($event.target as HTMLInputElement).checked)" /></div>
              <div class="settingrow"><label for="settings-update-download">自动后台下载更新</label><input id="settings-update-download" class="setting-switch" type="checkbox" :checked="autoDownloadUpdates" @change="emit('update:autoDownloadUpdates', ($event.target as HTMLInputElement).checked)" /></div>
              <p class="setting-hint">发现新版本后，在后台下载安装包。下载完成后仍由你决定何时安装和重启。</p>
              <div class="settingrow"><span>当前版本 {{ currentVersion || '读取中…' }}</span><button class="reset-font" @click="emit('check-update')">检查更新</button></div>
            </section>

            <!-- 3. 保存 -->
            <section id="settings-save" class="settings-section">
              <h3>保存</h3>
              <div class="settingrow"><label for="settings-external-monitor">外部文件变化监测</label><input id="settings-external-monitor" class="setting-switch" type="checkbox" :checked="externalFileMonitoring ?? true" @change="emit('update:externalFileMonitoring', ($event.target as HTMLInputElement).checked)" /></div>
              <p class="setting-hint">关闭后仍在保存时校验磁盘版本，阻止旧内容意外覆盖外部修改。</p>
              <div class="settingrow"><label for="settings-external-reload">自动重新加载外部修改的干净文件</label><input id="settings-external-reload" class="setting-switch" type="checkbox" :checked="autoReloadExternal ?? true" @change="emit('update:autoReloadExternal', ($event.target as HTMLInputElement).checked)" /></div>
              <div class="settingrow"><label for="settings-autosave">自动保存</label><input id="settings-autosave" class="setting-switch" type="checkbox" :checked="autoSave" @change="$emit('update:autoSave', ($event.target as HTMLInputElement).checked)" /></div>
              <div class="settingrow"><label for="settings-save-delay">自动保存延迟</label><select id="settings-save-delay" :disabled="!autoSave" :value="autoSaveDelay" @change="$emit('update:autoSaveDelay', Number(($event.target as HTMLSelectElement).value))"><option v-if="!delays.includes(autoSaveDelay)" :value="autoSaveDelay">{{ autoSaveDelay / 1000 }} 秒</option><option v-for="delay in delays" :key="delay" :value="delay">{{ delay / 1000 }} 秒</option></select></div>
            </section>

            <!-- 4. Markdown -->
            <section id="settings-markdown" class="settings-section">
              <h3>Markdown</h3>
              <h4 class="subhead">默认复制行为（{{ shortcutLabel('Mod+C') }}）</h4>
              <div class="settingrow"><label for="settings-md-copy">跨段自动复制 Markdown</label><input id="settings-md-copy" type="checkbox" :checked="markdownClipboard?.copyAcrossBlocks ?? true" @change="updateClipboard('copyAcrossBlocks', ($event.target as HTMLInputElement).checked)" /></div>
              <div class="settingrow"><label for="settings-md-copy-line">无文字选中时，复制或剪切光标所在的一整行</label><input id="settings-md-copy-line" type="checkbox" :checked="markdownClipboard?.copyWholeLine ?? false" @change="updateClipboard('copyWholeLine', ($event.target as HTMLInputElement).checked)" /></div>
              <p class="setting-hint">单个文本块内选区复制纯文字；开启后跨段选区保留 Markdown 结构，关闭后复制可读纯文字。自动折行不算跨段，表格保留原有单元格复制规则。粘贴到富文本应用时保留所选格式。仅在 Markdown 富文本编辑区生效。复制为 Markdown（不受此开关影响）：{{ shortcutLabel('Mod+Shift+C') }}；粘贴为纯文本：{{ shortcutLabel('Mod+Shift+V') }}。</p>
              <h4 class="subhead">排版</h4>
              <div class="settingrow"><label for="settings-md-width">正文宽度</label><input id="settings-md-width" type="number" min="480" max="1400" :value="markdownTypography?.width || 860" @change="updateMd('width', Number(($event.target as HTMLInputElement).value))" /></div>
              <div class="settingrow"><label for="settings-md-size">正文字号</label><input id="settings-md-size" type="number" min="12" max="28" :value="markdownTypography?.fontSize || 16" @change="updateMd('fontSize', Number(($event.target as HTMLInputElement).value))" /></div>
              <div class="settingrow"><label for="settings-md-height">正文行高</label><input id="settings-md-height" type="number" min="1.2" max="2.4" step="0.1" :value="markdownTypography?.lineHeight || 1.7" @change="updateMd('lineHeight', Number(($event.target as HTMLInputElement).value))" /></div>
              <div class="settingrow"><label for="settings-md-font">正文字体</label><select id="settings-md-font" :value="markdownTypography?.fontFamily || 'system'" @change="updateMd('fontFamily', ($event.target as HTMLSelectElement).value)"><option value="system">中英文系统字体</option><option value="serif">衬线字体</option><option value="mono">等宽字体</option></select></div>
              <div class="settingrow"><label for="settings-md-numbers">代码块行号</label><input id="settings-md-numbers" type="checkbox" :checked="markdownTypography?.codeLineNumbers ?? true" @change="updateMd('codeLineNumbers', ($event.target as HTMLInputElement).checked)" /></div>
              <div class="settingrow"><label for="settings-md-wrap">代码块自动换行</label><input id="settings-md-wrap" type="checkbox" :checked="markdownTypography?.codeWrap ?? false" @change="updateMd('codeWrap', ($event.target as HTMLInputElement).checked)" /></div>
              <div class="settingrow"><label for="settings-md-image-border">显示图片边框</label><input id="settings-md-image-border" type="checkbox" :checked="markdownTypography?.imageBorder ?? true" @change="updateMd('imageBorder', ($event.target as HTMLInputElement).checked)" /></div>
              <div class="settingrow"><span class="setting-label">Markdown 默认模式</span><SegmentedControl id="settings-md-mode" label="Markdown 默认模式" :model-value="defaultMdMode" :options="[{value:'live',label:'即时排版'},{value:'source',label:'源码'},{value:'split',label:'双栏'}]" @update:model-value="emit('update:defaultMdMode', $event as MarkdownMode)" /></div>
              <div class="settingrow"><label for="settings-md-toolbar">显示 Markdown 格式工具栏</label><input id="settings-md-toolbar" type="checkbox" :checked="liveToolbar !== false" @change="emit('update:liveToolbar', ($event.target as HTMLInputElement).checked)" /></div>
              <ImageSettings :global-rules="imageRules" :document-rules="documentImageRules" :document-path="markdownPath" :document-name="markdownName" @global="emit('update:imageRules', $event)" @document="emit('update:documentImageRules', $event)" />
            </section>

            <!-- 5. 导入与导出 -->
            <section id="settings-conversion" class="settings-section">
              <h3>导入与导出</h3>
              <div class="settingrow">
                <label for="settings-ask-location">导出时询问保存位置</label>
                <input id="settings-ask-location" class="setting-switch" type="checkbox" :checked="conversionSettings.askSaveLocation" @change="updateConversion('askSaveLocation', ($event.target as HTMLInputElement).checked)" />
              </div>
              <div class="settingrow">
                <label for="settings-embed-images">离线图片内嵌为 Data URI</label>
                <input id="settings-embed-images" class="setting-switch" type="checkbox" :checked="conversionSettings.embedImagesAsDataUri" @change="updateConversion('embedImagesAsDataUri', ($event.target as HTMLInputElement).checked)" />
              </div>

              <h4 class="subhead">PDF 导出</h4>
              <div class="settingrow">
                <label for="settings-pdf-paper">默认纸张大小</label>
                <select id="settings-pdf-paper" :value="conversionSettings.pdf.paperSize" @change="updatePdf('paperSize', ($event.target as HTMLSelectElement).value as 'A4' | 'Letter')">
                  <option value="A4">A4 纸张</option>
                  <option value="Letter">US Letter</option>
                </select>
              </div>
              <div class="settingrow">
                <span class="setting-label">页面方向</span>
                <SegmentedControl id="settings-pdf-orientation" label="页面方向" :model-value="conversionSettings.pdf.orientation" :options="[{value:'portrait',label:'纵向'},{value:'landscape',label:'横向'}]" @update:model-value="updatePdf('orientation', $event as 'portrait' | 'landscape')" />
              </div>
              <div class="settingrow">
                <label for="settings-pdf-margins">页边距</label>
                <select id="settings-pdf-margins" :value="conversionSettings.pdf.margins" @change="updatePdf('margins', ($event.target as HTMLSelectElement).value as 'default' | 'compact' | 'loose')">
                  <option value="default">默认 (18mm)</option>
                  <option value="compact">紧凑 (12mm)</option>
                  <option value="loose">宽松 (25mm)</option>
                </select>
              </div>
              <div class="settingrow">
                <label for="settings-pdf-bg">包含背景色与代码块底色</label>
                <input id="settings-pdf-bg" class="setting-switch" type="checkbox" :checked="conversionSettings.pdf.printBackground" @change="updatePdf('printBackground', ($event.target as HTMLInputElement).checked)" />
              </div>
              <div class="settingrow">
                <label for="settings-pdf-codewrap">代码块长行自动换行</label>
                <input id="settings-pdf-codewrap" class="setting-switch" type="checkbox" :checked="conversionSettings.pdf.codeWrap" @change="updatePdf('codeWrap', ($event.target as HTMLInputElement).checked)" />
              </div>

              <h4 class="subhead">Word (Pandoc) 状态</h4>
              <div class="settingrow pandoc-row">
                <div class="pandoc-info">
                  <span class="pandoc-indicator" :class="{ ok: pandocStatus.available }"></span>
                  <span v-if="pandocStatus.available">已检测到 Pandoc：{{ pandocStatus.version }}</span>
                  <span v-else>未检测到 Pandoc（Word 导入导出需要 Pandoc）</span>
                </div>
                <div class="pandoc-actions">
                  <button type="button" class="small-btn" @click="checkPandoc">重新检测</button>
                  <button v-if="!pandocStatus.available" type="button" class="small-btn" @click="openPandocSite">官网下载</button>
                </div>
              </div>
              <p v-if="pandocStatus.path" class="setting-hint">路径：{{ pandocStatus.path }}</p>
            </section>

            <!-- 6. 快捷键（全新独立完整配置体系） -->
            <section id="settings-shortcuts" class="settings-section shortcuts-management-section">
              <h3>快捷键</h3>
              <header class="shortcuts-toolbar">
                <div class="toolbar-field">
                  <label for="settings-keymap-preset">键位方案</label>
                  <select
                    id="settings-keymap-preset"
                    :value="keymapPreset || 'markumo'"
                    class="preset-select"
                    @change="onPresetChange(($event.target as HTMLSelectElement).value as KeymapPresetId); ($event.target as HTMLSelectElement).value = currentPresetId"
                  >
                    <option v-for="preset in Object.values(keymapPresets)" :key="preset.id" :value="preset.id">
                      {{ preset.name }}
                    </option>
                  </select>
                </div>

                <div class="toolbar-search">
                  <input
                    v-model="searchQuery"
                    type="text"
                    placeholder="搜索快捷键或命令名称…"
                    class="shortcut-search-input"
                    aria-label="搜索快捷键"
                  />
                  <button v-if="searchQuery" class="clear-search-btn" title="清除搜索" @click="searchQuery = ''">✕</button>
                </div>

                <button type="button" class="reset-all-btn" title="重置为当前方案的默认快捷键" @click="resetAllToDefault">
                  恢复默认
                </button>
                <SegmentedControl label="筛选快捷键" v-model="shortcutFilter" :options="[{value:'all',label:'全部'},{value:'modified',label:'已修改'},{value:'unbound',label:'未绑定'}]" />
              </header>

              <div v-if="pendingPreset" class="preset-confirm" role="alert">
                <p>应用 {{ keymapPresets[pendingPreset].name }} 将替换当前绑定（{{ modifiedCount }} 项已修改）。清除的绑定也会恢复。</p>
                <p v-for="warning in presetWarnings" :key="warning">{{ warning }}</p>
                <p v-if="pendingPreset === 'fleet'">Mod+B 用于侧边栏；Markdown 加粗默认未绑定。</p>
                <p v-if="pendingPreset === 'typora'">Mod+Shift+F 用于侧边栏，Mod+Shift+K 用于代码块；工作区搜索和删除当前行默认未绑定。</p>
                <button :disabled="!!presetWarnings.length" @click="confirmPreset">确认应用</button><button @click="pendingPreset=null">取消</button>
              </div>
              <p class="setting-hint">Markdown 正文中 Mod+0 优先转换为普通段落；其他位置恢复字号。行编辑命令适用于文本、源码和内嵌代码块。</p>
              <!-- 按分类展示命令列表 -->
              <div class="shortcuts-groups">
                <div
                  v-for="cat in filteredCategories"
                  :key="cat"
                  class="shortcut-category-group"
                >
                  <h4 class="category-title">{{ categoryLabels[cat] }}</h4>
                  <div class="category-commands">
                    <div
                      v-for="cmd in getCategoryCommands(cat)"
                      :key="cmd.id"
                      class="shortcut-item-row"
                    >
                      <div class="cmd-info">
                        <span class="cmd-label">{{ cmd.label }} <small v-if="(localShortcuts[cmd.id] || '') !== (defaultBindings[cmd.id] || '')" class="modified-badge">已修改</small></span>
                        <span class="cmd-desc">{{ cmd.description }}</span>
                        <span v-if="effectiveBindings(cmd.id,localShortcuts).length > 1" class="cmd-desc">兼容键：{{ effectiveBindings(cmd.id,localShortcuts).slice(1).map(value=>keybindingLabel(value)).join(' / ') }}</span>
                        <span v-if="existingConflict(cmd.id)" class="binding-warning" role="status">{{ existingConflict(cmd.id) }}</span>
                      </div>

                      <div class="cmd-recorder">
                        <ShortcutRecorder
                          v-if="cmd.supported && cmd.userOverridable"
                          :command-id="cmd.id"
                          :binding="localShortcuts[cmd.id]"
                          :default-binding="defaultBindings[cmd.id]"
                          :all-bindings="localShortcuts"
                          :aria-label="`快捷键 ${cmd.label}`"
                          @update:binding="onUpdateSingleBinding(cmd.id, $event)"
                          @reassign="onReassignBinding"
                        /><span v-else class="cmd-desc">{{ cmd.supported ? '固定快捷键' : '尚未支持' }}</span>
                      </div>
                    </div>
                  </div>
                </div>

                <div v-if="filteredCategories.length === 0" class="empty-shortcuts">
                  无匹配的命令快捷键
                </div>
              </div>
            </section>
          </div>
        </div>
        <footer class="settings-foot"><button class="close-btn" @click="close">完成</button></footer>
      </div>
    </div>
  </Transition>
</template>

<script setup lang="ts">
import { useModal } from '../../features/shell/useModal'
import { nextTick, ref, computed, watch, onUnmounted } from 'vue'
import Icon from '../common/Icon.vue'
import SegmentedControl from '../common/SegmentedControl.vue'
import ImageSettings from './ImageSettings.vue'
import ShortcutRecorder from '../common/ShortcutRecorder.vue'
import type { ImageRules } from '../../editor/markdown/imageImport'
import type { EditorSettings } from '../../features/shell/editorSettings'
import type { ThemePreference, MarkdownMode } from '../../types'
import { defaultMarkdownTypography, defaultMarkdownClipboard, type MarkdownClipboardSettings, type MarkdownTypography } from '../../editor/markdown/wysiwyg/contracts'
import { shortcutLabel } from '../../features/shell/editorSettings'
import {
  loadConversionSettings,
  saveConversionSettings,
  type ConversionSettings,
  getPandocStatus,
  type PandocStatus,
} from '../../features/document-conversion'
import {
  type KeymapPresetId,
  type CommandCategory,
  categoryLabels,
  allCommands,
  keymapPresets,
  getPresetBindings, reassignBinding, validatePresetConflicts, keybindingLabel, checkBindingConflict, isPriorityConflict, effectiveBindings,
} from '../../features/shell/keybindings'

const props = defineProps<{
  autoCheckUpdates: boolean
  autoDownloadUpdates: boolean
  currentVersion: string
  markdownClipboard?: MarkdownClipboardSettings
  markdownTypography?: MarkdownTypography
  theme: ThemePreference
  uiFontSize: number
  fontSize: number
  caretAnimation: EditorSettings['caretAnimation']
  syntaxStyle?: EditorSettings['syntaxStyle']
  bracketMode?: EditorSettings['bracketMode']
  wordWrap: boolean
  typewriterMode?: boolean
  showOutline: boolean
  defaultMdMode: MarkdownMode
  liveToolbar?: boolean
  fontFamily: EditorSettings['fontFamily']
  indentSize: number
  useTabs: boolean
  shortcuts: EditorSettings['shortcuts']
  keymapPreset?: KeymapPresetId
  externalFileMonitoring?: boolean
  autoReloadExternal?: boolean
  autoSave: boolean
  autoSaveDelay: number
  treeClickMode?: 'double' | 'single'
  autoFollowActiveFile?: boolean
  smartExpand?: boolean
  compactFolders?: boolean
  imageRules: ImageRules
  documentImageRules: ImageRules | null
  markdownPath?: string
  markdownName?: string
}>()

const emit = defineEmits<{
  (e: 'update:autoCheckUpdates' | 'update:autoDownloadUpdates', value: boolean): void
  (e: 'check-update'): void
  (e: 'update:markdownClipboard', value: MarkdownClipboardSettings): void
  (e: 'update:markdownTypography', value: MarkdownTypography): void
  (e: 'update:theme', val: ThemePreference): void
  (e: 'update:uiFontSize', val: number): void
  (e: 'update:fontSize', val: number): void
  (e: 'update:caretAnimation', val: EditorSettings['caretAnimation']): void
  (e: 'update:syntaxStyle', val: EditorSettings['syntaxStyle']): void
  (e: 'update:bracketMode', val: EditorSettings['bracketMode']): void
  (e: 'update:wordWrap', val: boolean): void
  (e: 'update:typewriterMode', val: boolean): void
  (e: 'update:showOutline', val: boolean): void
  (e: 'update:defaultMdMode', val: MarkdownMode): void
  (e: 'update:liveToolbar', val: boolean): void
  (e: 'update:fontFamily', val: EditorSettings['fontFamily']): void
  (e: 'update:indentSize', val: number): void
  (e: 'update:useTabs', val: boolean): void
  (e: 'update:treeClickMode', val: 'double' | 'single'): void
  (e: 'update:autoFollowActiveFile', val: boolean): void
  (e: 'update:smartExpand', val: boolean): void
  (e: 'update:compactFolders', val: boolean): void
  (e: 'update:keymap', val: {preset:KeymapPresetId;bindings:Record<string,string>}): void
  (e: 'update:shortcuts', val: Record<string, string>): void
  (e: 'update:externalFileMonitoring', val: boolean): void
  (e: 'update:autoReloadExternal', val: boolean): void
  (e: 'update:autoSave', val: boolean): void
  (e: 'update:autoSaveDelay', val: number): void
  (e: 'update:imageRules', val: ImageRules): void
  (e: 'update:documentImageRules', val: ImageRules | null): void
}>()

const { visible, dialogRef, open, close, handleKeydown } = useModal()
void dialogRef // Bound by name in the template.

function updateClipboard(key: keyof MarkdownClipboardSettings, value: boolean) {
  emit('update:markdownClipboard', { ...(props.markdownClipboard || defaultMarkdownClipboard()), [key]: value })
}

function updateMd(key: keyof MarkdownTypography, value: number | string | boolean) {
  if (
    typeof value === 'number' &&
    (!Number.isFinite(value) ||
      (key === 'width' && (value < 480 || value > 1400)) ||
      (key === 'fontSize' && (value < 12 || value > 28)) ||
      (key === 'lineHeight' && (value < 1.2 || value > 2.4)))
  ) {
    return
  }
  emit('update:markdownTypography', {
    ...(props.markdownTypography || defaultMarkdownTypography()),
    [key]: value,
  })
}

const contentRef = ref<HTMLElement | null>(null)
const uiFontDraft = ref(String(props.uiFontSize)), uiFontError = ref('')
watch(() => props.uiFontSize, value => { uiFontDraft.value = String(value) })

function updateUiFont(event: Event) {
  uiFontDraft.value = (event.target as HTMLInputElement).value
  const value = Number(uiFontDraft.value)
  uiFontError.value = !uiFontDraft.value || !Number.isInteger(value) || value < 12 || value > 20 ? '请输入 12–20 的整数字号' : ''
  if (!uiFontError.value) emit('update:uiFontSize', value)
}
function finishUiFont() { uiFontDraft.value = String(props.uiFontSize); uiFontError.value = '' }

const activeSection = ref('appearance')
const fontDraft = ref(String(props.fontSize)), fontError = ref('')
const delays = [500, 1500, 3000, 5000]

const conversionSettings = ref<ConversionSettings>(loadConversionSettings())
const pandocStatus = ref<PandocStatus>({ available: false })

async function checkPandoc() {
  pandocStatus.value = await getPandocStatus(true)
}

function openPandocSite() {
  window.open('https://pandoc.org/installing.html', '_blank')
}

function updateConversion<K extends keyof ConversionSettings>(key: K, val: ConversionSettings[K]) {
  conversionSettings.value[key] = val
  saveConversionSettings(conversionSettings.value)
}

function updatePdf<K extends keyof ConversionSettings['pdf']>(key: K, val: ConversionSettings['pdf'][K]) {
  conversionSettings.value.pdf[key] = val
  saveConversionSettings(conversionSettings.value)
}

const sections = [
  { id: 'appearance', title: '外观', icon: 'sun' },
  { id: 'editor', title: '编辑', icon: 'font' },
  { id: 'workspace', title: '工作区', icon: 'folder' },
  { id: 'updates', title: '更新', icon: 'download' },
  { id: 'save', title: '保存', icon: 'save' },
  { id: 'markdown', title: 'Markdown', icon: 'files' },
  { id: 'conversion', title: '导入与导出', icon: 'export' },
  { id: 'shortcuts', title: '快捷键', icon: 'keyboard' },
]

watch(() => props.fontSize, value => { fontDraft.value = String(value) })
watch(visible, value => {
  if (value) {
    finishUiFont()
    localShortcuts.value = { ...props.shortcuts }
    fontDraft.value = String(props.fontSize)
    fontError.value = ''
    contentRef.value?.scrollTo({top:0,behavior:'instant'})
    activeSection.value = 'appearance'
    pendingPreset.value=null
    searchQuery.value=''
    shortcutFilter.value='all'
    conversionSettings.value = loadConversionSettings()
    void checkPandoc()
  }
})

let scrollFrame = 0
let stopScrollTracking = () => {}
function updateActiveSection() {
  scrollFrame = 0
  const container = contentRef.value
  if (!container) return
  const targets = Array.from(container.querySelectorAll<HTMLElement>('.settings-section'))
  if (container.scrollTop <= 1) {activeSection.value = 'appearance';return}
  if (container.scrollTop + container.clientHeight >= container.scrollHeight - 2) {activeSection.value = 'shortcuts';return}
  const top = container.getBoundingClientRect().top + 36
  let active = targets[0]
  for (const target of targets) { if (target.getBoundingClientRect().top <= top) active = target; else break }
  if (active) activeSection.value = active.id.replace('settings-','')
}
function scheduleScrollTracking() { if (!scrollFrame) scrollFrame = requestAnimationFrame(updateActiveSection) }
watch(contentRef, container => {
  stopScrollTracking()
  if (!container) return
  container.scrollTop = 0
  container.addEventListener('scroll',scheduleScrollTracking,{passive:true})
  const observer = new ResizeObserver(scheduleScrollTracking)
  observer.observe(container)
  container.querySelectorAll('.settings-section').forEach(section=>observer.observe(section))
  stopScrollTracking = () => {container.removeEventListener('scroll',scheduleScrollTracking);observer.disconnect();cancelAnimationFrame(scrollFrame);scrollFrame=0}
  scheduleScrollTracking()
}, {flush:'post'})
onUnmounted(()=>stopScrollTracking())
function goToSection(id: string) {
  const container=contentRef.value, target=container?.querySelector<HTMLElement>('#settings-'+id)
  if (!container || !target) return
  const top=target.getBoundingClientRect().top-container.getBoundingClientRect().top+container.scrollTop-20
  container.scrollTo({top,behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'})
  activeSection.value=id
}
function updateIndent(event:Event) {
  const input=event.target as HTMLInputElement, value=Number(input.value)
  if(Number.isInteger(value)&&value>=1&&value<=8)emit('update:indentSize',value)
  else input.value=String(props.indentSize)
}

function updateFont(event: Event) {
  fontDraft.value = (event.target as HTMLInputElement).value
  const value = Number(fontDraft.value)
  fontError.value = !fontDraft.value || !Number.isInteger(value) || value < 10 || value > 24 ? '请输入 10–24 的整数字号' : ''
  if (!fontError.value) emit('update:fontSize', value)
}
function finishFont() { fontDraft.value = String(props.fontSize); fontError.value = '' }

// --- 快捷键管理逻辑 ---
const localShortcuts = ref<Record<string, string>>({ ...props.shortcuts })
const searchQuery = ref('')
const shortcutFilter = ref('all')
const pendingPreset = ref<KeymapPresetId|null>(null)

watch(() => props.shortcuts, next => {
  localShortcuts.value = { ...next }
}, { deep: true })

const currentPresetId = computed<KeymapPresetId>(() => props.keymapPreset || 'markumo')
const defaultBindings = computed(() => getPresetBindings(currentPresetId.value))

const modifiedCount = computed(()=>allCommands.filter(command=>(localShortcuts.value[command.id]||'')!==(defaultBindings.value[command.id]||'')).length)
const presetWarnings = computed(()=>pendingPreset.value ? validatePresetConflicts(getPresetBindings(pendingPreset.value)) : [])
function existingConflict(id:string) {
  const binding=localShortcuts.value[id], conflict=checkBindingConflict(id,binding,localShortcuts.value)
  return conflict && !isPriorityConflict(id,conflict,binding) ? conflict.description : ''
}
function onPresetChange(newPreset: KeymapPresetId) { pendingPreset.value = newPreset }
function resetAllToDefault() { pendingPreset.value = currentPresetId.value }
function confirmPreset() {
  if (!pendingPreset.value || presetWarnings.value.length) return
  const preset=pendingPreset.value, bindings=getPresetBindings(preset)
  localShortcuts.value=bindings
  pendingPreset.value=null
  emit('update:keymap',{preset,bindings})
}
function onUpdateSingleBinding(cmdId: string, binding: string) {
  localShortcuts.value = {...localShortcuts.value,[cmdId]:binding}
  emit('update:shortcuts', { ...localShortcuts.value })
}
function onReassignBinding(payload: { commandId:string; newBinding: string; takeFromCommandId: string }) {
  const next = reassignBinding(localShortcuts.value,payload.commandId,payload.newBinding)
  if (!next) return
  localShortcuts.value=next
  emit('update:shortcuts',next)
}

// 搜索与分类过滤
const filteredCommands = computed(() => {
  const q = searchQuery.value.trim().toLowerCase()
  return allCommands.filter(cmd => {
    const binding = localShortcuts.value[cmd.id] || ''
    if(shortcutFilter.value==='modified' && binding===(defaultBindings.value[cmd.id]||''))return false
    if(shortcutFilter.value==='unbound' && binding)return false
    if (!q) return true
    const labelMatch = cmd.label.toLowerCase().includes(q)
    const idMatch = cmd.id.toLowerCase().includes(q)
    const bindingMatch = [binding,keybindingLabel(binding),...effectiveBindings(cmd.id,localShortcuts.value).map(value=>keybindingLabel(value))].some(label=>label.toLowerCase().replace(/\s/g,'').includes(q.replace(/\s/g,'')))
    return labelMatch || idMatch || bindingMatch
  })
})

const filteredCategories = computed<CommandCategory[]>(() => {
  const categories: CommandCategory[] = [
    'file',
    'edit',
    'markdown',
    'search',
    'split',
    'navigation',
    'view',
    'general',
  ]
  return categories.filter(cat =>
    filteredCommands.value.some(cmd => cmd.category === cat)
  )
})

function getCategoryCommands(cat: CommandCategory) {
  return filteredCommands.value.filter(cmd => cmd.category === cat)
}

async function openSection(id: string) {
  open()
  await nextTick()
  goToSection(id)
}

defineExpose({ open, close, visible, openSection })
</script>

<style scoped>
.settingsoverlay { position:fixed;inset:0;background:rgba(0,0,0,.35);backdrop-filter:blur(3px);display:flex;justify-content:center;align-items:center;z-index:999;padding:16px }
.settings { width:760px;max-width:100%;height:640px;max-height:100%;display:flex;flex-direction:column;overflow:hidden;background:var(--paper);border:1px solid var(--line);border-radius:16px;box-shadow:var(--shadow) }
.settings-head { display:flex;align-items:center;justify-content:space-between;padding:18px 22px;border-bottom:1px solid var(--line);flex:none }
.settings-title { display:flex;align-items:center;gap:10px;color:var(--bright) }
h2 { margin:0;font-size: calc(var(--ui-font-size) + 2px);font-weight:600 }
.icon-button { display:grid;place-items:center;width:var(--ui-control-height);height:var(--ui-control-height);border-radius:6px;color:var(--muted) }
.icon-button:hover { background:var(--hover);color:var(--bright) }
.settings-body { display:flex;flex:1;min-height:0 }
.settings-nav { flex:none;width:calc(140px + (var(--ui-font-size) - 14px) * 5);padding:16px 10px;background:var(--sidebar);border-right:1px solid var(--line) }
.settings-nav button { width:100%;display:flex;align-items:center;gap:9px;padding:9px 12px;margin-bottom:4px;border-radius:7px;color:var(--sub);font-size: var(--ui-font-size);text-align:left }
.settings-nav button:hover { background:var(--hover) }
.settings-nav button.active { background:var(--accentbg);color:var(--accent);font-weight:600 }
.settings-content { flex:1;min-width:0;overflow-y:auto;overscroll-behavior:contain;padding:20px 26px }
.settings-section { scroll-margin-top:20px;padding-bottom:22px;margin-bottom:22px;border-bottom:1px solid var(--line) }
.settings-section:last-child { border-bottom:0;margin-bottom:0 }
h3 { margin:0 0 12px;font-size: var(--ui-font-size);font-weight:600;color:var(--bright) }
.settingrow { display:flex;align-items:center;justify-content:space-between;gap:16px;min-height:calc(var(--ui-control-height) + 10px);font-size: var(--ui-font-size);color:var(--ink) }
.settingrow label,.settingrow .setting-label { flex:1;min-width:0 }
select { width:176px;max-width:55%;height:var(--ui-control-height);background:var(--editor);border:1px solid var(--line);color:var(--ink);padding:4px 8px;border-radius:6px;font:inherit }
.number-control { display:flex;align-items:center;gap:8px;color:var(--muted) }
.number-control input { width:76px;height:var(--ui-control-height);border:1px solid var(--line);border-radius:6px;background:var(--editor);color:var(--ink);padding:4px 8px;font:inherit }
input:focus-visible,select:focus-visible,button:focus-visible { outline:2px solid var(--accent);outline-offset:2px }
select:disabled { opacity:.45 }
.reset-font { padding:4px 8px;border:1px solid var(--line);border-radius:5px;color:var(--sub);font-size:var(--ui-small-font-size);min-height:var(--ui-control-height) }
.setting-hint { font-size:var(--ui-small-font-size);color:var(--muted);margin:4px 0 12px }
.setting-switch { appearance:none;width:32px;height:18px;border:1px solid var(--line);border-radius:12px;background:var(--soft);position:relative;cursor:pointer;flex:none;transition:background .15s }
.setting-switch::before { content:'';position:absolute;left:3px;top:3px;width:10px;height:10px;border-radius:50%;background:var(--muted);transition:transform .15s }
.setting-switch:checked { background:var(--accent);border-color:var(--accent) }
.setting-switch:checked::before { transform:translateX(14px);background:#fff }
.field-error { color:var(--yellow);font-size: var(--ui-small-font-size);margin:5px 0 }
.settings-foot { display:flex;justify-content:flex-end;padding:12px 22px;border-top:1px solid var(--line);flex:none }
.close-btn { background:var(--accent);color:#fff;padding:7px 24px;border-radius:7px;font-size: var(--ui-font-size);font-weight:600;cursor:pointer }
.close-btn:hover { opacity:.9 }

/* 快捷键重构样式 */
.shortcuts-toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding-bottom: 16px;
  border-bottom: 1px solid var(--line);
  margin-bottom: 16px;
}

.toolbar-field {
  display: flex;
  align-items: center;
  gap: 8px;
}

.toolbar-field label {
  font-size: 13px;
  color: var(--sub);
  white-space: nowrap;
}

.preset-select {
  width: 170px;
  height: 28px;
  font-size: 12px;
}

.toolbar-search {
  flex: 1;
  position: relative;
  display: flex;
  align-items: center;
}

.shortcut-search-input {
  width: 100%;
  height: 28px;
  background: var(--editor);
  border: 1px solid var(--line);
  border-radius: 6px;
  color: var(--ink);
  font-size: 12px;
  padding: 0 24px 0 8px;
}

.clear-search-btn {
  position: absolute;
  right: 6px;
  background: transparent;
  border: none;
  color: var(--muted);
  cursor: pointer;
  font-size: 12px;
}

.reset-all-btn {
  height: 28px;
  padding: 0 10px;
  border: 1px solid var(--line);
  background: var(--bar);
  color: var(--sub);
  border-radius: 6px;
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
}
.reset-all-btn:hover {
  background: var(--hover);
  color: var(--bright);
}

.shortcuts-groups {
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.category-title {
  margin: 0 0 8px;
  font-size: 13px;
  font-weight: 600;
  color: var(--accent);
  padding-bottom: 4px;
  border-bottom: 1px dashed var(--line);
}

.category-commands {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.shortcut-item-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 5px 8px;
  border-radius: 6px;
  transition: background 0.12s;
}

.shortcut-item-row:hover {
  background: var(--soft);
}

.cmd-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  flex: 1;
}

.cmd-label {
  font-size: 13px;
  font-weight: 500;
  color: var(--bright);
}

.cmd-desc {
  font-size: 11px;
  color: var(--muted);
}

.empty-shortcuts {
  padding: 24px;
  text-align: center;
  color: var(--muted);
  font-size: 13px;
}

.subhead {
  margin: 16px 0 8px;
  font-size: 13px;
  font-weight: 600;
  color: var(--accent);
  padding-bottom: 4px;
  border-bottom: 1px dashed var(--line);
}
.pandoc-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.pandoc-info {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
}
.pandoc-indicator {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--muted);
}
.pandoc-indicator.ok {
  background: #2ea44f;
}
.pandoc-actions {
  display: flex;
  gap: 6px;
}
.small-btn {
  padding: 4px 10px;
  font-size: 12px;
  border: 1px solid var(--line);
  background: var(--soft);
  color: var(--text);
  border-radius: 4px;
  cursor: pointer;
}
.small-btn:hover {
  background: var(--hover);
  color: var(--bright);
}

@media(max-width:560px) {
  .settings-nav { width:44px;padding:12px 4px }.settings-nav button { padding:10px;justify-content:center }.settings-nav span { display:none }.settings-content { padding:16px }.settings-head { padding:14px 16px }
}
.fade-enter-active,.fade-leave-active { transition:opacity .15s }.fade-enter-from,.fade-leave-to { opacity:0 }
.shortcuts-toolbar {position:sticky;top:-20px;z-index:2;background:var(--paper);padding:10px 0;flex-wrap:wrap;gap:8px}
.shortcuts-toolbar .toolbar-field{flex:1 1 100%;min-width:0;flex-wrap:wrap}
.shortcuts-toolbar .toolbar-search{min-width:140px}
.shortcuts-toolbar :deep(.segmented-control){font-size:var(--ui-small-font-size)}
.preset-select,.shortcut-search-input,.reset-all-btn{font-size:var(--ui-small-font-size);height:auto;min-height:var(--ui-control-height)}
.shortcut-item-row{gap:12px;align-items:start;flex-wrap:wrap;padding:8px 0}
.cmd-info{flex:1 1 160px;overflow-wrap:anywhere}.cmd-recorder{flex:0 1 260px;min-width:0;max-width:100%}
.cmd-recorder :deep(.shortcut-recorder-wrap){display:flex;flex-wrap:wrap;max-width:100%}
.cmd-recorder :deep(.keycap-container){flex-wrap:wrap;max-width:100%;min-width:0}
.cmd-recorder :deep(.conflict-alert){position:static;flex-basis:100%;max-width:100%;min-width:0;flex-wrap:wrap}
.cmd-label,.category-title,.toolbar-field label{font-size:var(--ui-font-size)}
.cmd-desc,.keycap-unset,.setting-hint{font-size:var(--ui-small-font-size);line-height:1.5}
.binding-warning{font-size:var(--ui-small-font-size);color:var(--yellow);overflow-wrap:anywhere}
.modified-badge{color:var(--accent);font-size:var(--ui-small-font-size);font-weight:400}
.preset-confirm{padding:10px;border:1px solid var(--accent);border-radius:6px;margin-bottom:12px;font-size:var(--ui-small-font-size)}
.preset-confirm p{margin:0 0 8px}.preset-confirm button{padding:5px 10px;background:var(--accentbg);color:var(--accent);border-radius:4px;margin-right:8px}
.settingrow{flex-wrap:wrap;gap:8px;padding:4px 0}.settingrow > label,.settingrow > .setting-label{flex:1 1 140px}.settingrow > :deep(.segmented-control){flex:0 1 auto;min-width:0}
.settingrow > input[type=number]{width:90px;max-width:100%;background:var(--editor);color:var(--ink);border:1px solid var(--line);border-radius:5px;padding:5px;font:inherit}
.indent-control{display:flex;gap:8px;align-items:center;max-width:100%;flex-wrap:wrap}.indent-control input{width:52px;min-height:30px;background:var(--editor);color:var(--ink);border:1px solid var(--line);border-radius:5px;font:inherit}
.number-control{flex-wrap:wrap;max-width:100%}.pandoc-row{flex-wrap:wrap}.pandoc-info{min-width:0;overflow-wrap:anywhere}
.settings-content{overflow-anchor:auto}
.settings-content:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}.settings-section{scroll-margin-top:20px}
@media(prefers-reduced-motion:reduce){.fade-enter-active,.fade-leave-active,.setting-switch,.setting-switch::before{transition:none}}
</style>
