import { defineAsyncComponent } from 'vue'

// Share component definitions, not viewer instances. Import/CSS preload
// callbacks must not close over an EditorPane setup and its document/VNodes.
export const ImageViewer = defineAsyncComponent(() => import('./ImageViewer.vue'))
export const PdfViewer = defineAsyncComponent(() => import('./PdfViewer.vue'))
