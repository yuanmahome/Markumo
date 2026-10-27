<template>
  <svg
    class="icon"
    :class="[customClass, { 'small-icon': size === 'small' }]"
    aria-hidden="true"
    viewBox="0 0 24 24"
  >
    <template v-if="name === 'copy' || name === 'check'">
      <path :d="commonIconPaths[name]" />
    </template>
    <template v-else-if="symbolIconPaths[name]"><path :d="symbolIconPaths[name]" /></template>
    <template v-else-if="name === 'github'">
      <path d="M9 19c-4.3 1.3-4.3-2.2-6-2.7M15 22v-3.9a3.4 3.4 0 0 0-1-2.7c3.3-.4 6.7-1.6 6.7-7.4a5.8 5.8 0 0 0-1.6-4 5.4 5.4 0 0 0-.1-4s-1.2-.4-4.1 1.5a14 14 0 0 0-7.5 0C4.6-.4 3.4 0 3.4 0a5.4 5.4 0 0 0-.1 4 5.8 5.8 0 0 0-1.6 4c0 5.8 3.4 7 6.7 7.4a3.4 3.4 0 0 0-1 2.7V22" transform="translate(2 1) scale(.86)" />
    </template>
    <template v-else-if="name === 'download'">
      <path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5" />
    </template>
    <template v-else-if="name === 'files'">
      <rect x="5" y="3" width="15" height="18" rx="2" />
      <path d="M9 7h7M9 11h7M9 15h4" />
    </template>
    <template v-else-if="name === 'search'">
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="m16 16 5 5" />
    </template>
    <template v-else-if="name === 'plus'">
      <path d="M12 5v14M5 12h14" />
    </template>
    <template v-else-if="name === 'expand-all'">
      <path d="m8 7 4-4 4 4M8 17l4 4 4-4M4 12h16" />
    </template>
    <template v-else-if="name === 'collapse-all'">
      <path d="m8 3 4 4 4-4M8 21l4-4 4 4M4 12h16" />
    </template>
    <template v-else-if="name === 'locate'">
      <circle cx="12" cy="12" r="6" /><path d="M12 2v4M12 18v4M2 12h4M18 12h4" /><circle cx="12" cy="12" r="1" />
    </template>
    <template v-else-if="name === 'refresh'">
      <path d="M20 7v5h-5M4 17v-5h5M5 8a7 7 0 0 1 12-3l3 7M4 12l3 7a7 7 0 0 0 12-3" />
    </template>
    <template v-else-if="name === 'split'">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M12 4v16" />
    </template>
    <template v-else-if="name === 'panel'">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M8 4v16" />
    </template>
    <template v-else-if="name === 'moon'">
      <path d="M20 15a8 8 0 1 1-11-11 7 7 0 0 0 11 11Z" />
    </template>
    <template v-else-if="name === 'sun'">
      <circle cx="12" cy="12" r="5" />
      <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
    </template>
    <template v-else-if="name === 'system'">
      <rect x="3" y="4" width="18" height="13" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </template>
    <template v-else-if="name === 'gear'">
      <circle cx="12" cy="12" r="3" />
      <path d="M9.5 3h5l.5 2.4 1.6.9 2.3-.8 2.5 4.3-1.8 1.6v1.9l1.8 1.6-2.5 4.3-2.3-.8-1.6.9-.5 2.4h-5L9 19.3l-1.6-.9-2.3.8-2.5-4.3 1.8-1.6v-1.9L2.6 9.8l2.5-4.3 2.3.8L9 5.4Z" />
    </template>
    <template v-else-if="name === 'font'">
      <path d="M4 20 10 4h4l6 16M7 13h10" />
    </template>
    <template v-else-if="name === 'code'">
      <path d="m8 6-6 6 6 6m8-12 6 6-6 6m-3-15-2 18" />
    </template>
    <template v-else-if="name === 'keyboard'">
      <rect x="2" y="5" width="20" height="14" rx="3" />
      <path d="M6 9h1m4 0h1m4 0h1M6 12h1m4 0h1m4 0h1M7 16h10" />
    </template>
    <template v-else-if="name === 'outline'">
      <path d="M4 6h16M4 12h10M4 18h14" />
    </template>
    <template v-else-if="name === 'open'">
      <path d="M4 19V5h6l2 2h8v12Z" />
      <path d="M12 13h6m-3-3 3 3-3 3" />
    </template>
    <template v-else-if="name === 'folder'">
      <path d="M3 7V5h7l2 2h9v13H3Z" />
    </template>
    <template v-else-if="name === 'file'">
      <path d="M5 3h9l5 5v13H5Z" /><path d="M14 3v5h5" />
    </template>
    <template v-else-if="name === 'save'">
      <path d="M4 3h13l4 4v14H4Z" /><path d="M8 3v6h9V3M8 21v-8h9v8" />
    </template>
    <template v-else-if="name === 'wrap'">
      <path d="M3 6h18M3 11h13a3 3 0 1 1 0 6H9m3-3-3 3 3 3" />
    </template>
    <template v-else-if="name === 'max'">
      <path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5" />
    </template>
    <template v-else-if="name === 'pin'"><path d="m15 3 6 6-4 1-4 6-2-2-6 6-1-1 6-6-2-2 6-4z" /></template>
    <template v-else-if="name === 'close'">
      <path d="M18 6 6 18M6 6l12 12" />
    </template>
    <template v-else-if="name === 'export'">
      <path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2M7 11l5-5 5 5M12 6v12" />
    </template>
    <template v-else-if="name === 'chevron-right'">
      <path d="m9 18 6-6-6-6" />
    </template>
    <template v-else-if="name === 'chevron-down'">
      <path d="m6 9 6 6 6-6" />
    </template>
  </svg>
</template>

<script setup lang="ts">
import { commonIconPaths } from './iconPaths'
import { symbolIconPaths } from '../../editor/outline/symbolIcons'
defineProps<{
  name: string
  size?: 'normal' | 'small'
  customClass?: string
}>()
</script>
