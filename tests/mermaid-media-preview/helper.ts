import { createApp, h } from 'vue'
import SplitPreview from '/src/editor/markdown/splitPreview.vue'
import { markdownResources } from '/src/editor/markdown/images.ts'

let splitApp: ReturnType<typeof createApp> | null = null

export function unmountTestSplitPreview() {
  splitApp?.unmount()
  splitApp = null
  document.querySelector('[data-preview]')?.remove()
}

export function mountTestSplitPreview(manager: any, id: string) {
  unmountTestSplitPreview()
  const root = document.querySelector('#app')!
  const host = document.createElement('section')
  host.dataset.preview = ''
  root.append(host)
  const state = manager.getState(id)
  const resources = state?.facet(markdownResources)
  splitApp = createApp({
    render: () =>
      h(SplitPreview, {
        content: manager.getText(id),
        resources,
        resourceKey: `fixture|${id}`,
      }),
  })
  splitApp.mount(host)
}
