<template>
  <div class="file-mask">
    <span>{{ label }}</span>
    <input :value="modelValue" :placeholder="placeholder" :aria-label="label" :disabled="disabled"
      autocomplete="off" spellcheck="false" @input="emit('update:modelValue', ($event.target as HTMLInputElement).value)" />
    <div class="mask-presets">
      <select :aria-label="'选择' + label" :disabled="disabled" value="" @change="choose">
        <option value="" disabled>预设</option>
        <option v-for="preset in presets" :key="preset" :value="preset">{{ preset }}</option>
        <option value="clear">清空</option>
      </select>
      <Icon name="chevron-down" size="small" aria-hidden="true" />
    </div>
  </div>
</template>

<script setup lang="ts">
import Icon from '../common/Icon.vue'
defineProps<{label:string;modelValue:string;placeholder:string;presets:string[];disabled?:boolean}>()
const emit = defineEmits<{(event:'update:modelValue', value:string):void}>()
function choose(event: Event) {
  const select = event.target as HTMLSelectElement
  emit('update:modelValue', select.value==='clear'?'':select.value)
  select.value=''
}
</script>

<style scoped>
.file-mask { display:flex; align-items:center; min-width:0; gap:5px; color:var(--sub); white-space:nowrap }
.file-mask input,.file-mask select { height:26px; border:1px solid var(--line); background:var(--editor); color:var(--ink); font:inherit }
.file-mask input { width:clamp(50px,13vw,150px); min-width:0; padding:3px 6px; border-radius:5px 0 0 5px }
.mask-presets { width:27px; height:26px; position:relative; margin-left:-6px; flex:none }
.mask-presets select { width:100%; border-radius:0 5px 5px 0; appearance:none; color:transparent; cursor:pointer }
.mask-presets option { color:var(--ink); background:var(--editor) }
.mask-presets svg { position:absolute; inset:0; margin:auto; pointer-events:none }
.file-mask input:focus,.file-mask select:focus { outline:1px solid var(--accent); z-index:1 }
</style>
