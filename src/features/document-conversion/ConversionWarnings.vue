<template>
  <details class="conversion-warnings">
    <summary>{{ label }}（{{ warnings.length }}）<button type="button" aria-label="关闭转换提示" @click.prevent="$emit('close')">×</button></summary>
    <ul><li v-for="(warning, index) in warnings" :key="index">{{ warning.message }}</li></ul>
  </details>
</template>

<script setup lang="ts">
import type { ConversionWarning } from './contracts'
defineProps<{ label: string; warnings: ConversionWarning[] }>()
defineEmits<{ close: [] }>()
</script>

<style scoped>
.conversion-warnings { width:min(420px,calc(100vw - 40px));background:var(--paper);color:var(--ink);border:1px solid var(--line);border-radius:8px;box-shadow:var(--shadow);font-size:var(--ui-font-size); }
summary { padding:10px 14px;cursor:pointer; }
button { float:right;border:0;background:none;color:inherit;cursor:pointer; }
ul { max-height:220px;overflow:auto;margin:0;padding:0 28px 14px; }
li + li { margin-top:8px; }
</style>
