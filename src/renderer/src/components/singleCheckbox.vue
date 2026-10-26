<script setup lang="ts">
import { v4 as uuidV4 } from 'uuid'
import { computed, ref, watch } from 'vue'

const uuid = uuidV4()
const props = defineProps({
  modelValue: {
    type: Boolean || undefined,
    required: true
  },
  id: {
    type: String,
    default: null
  },
  disabled: {
    type: Boolean,
    default: false
  },
  ariaLabel: {
    type: String,
    default: undefined
  }
})

const inputId = computed(() => props.id || 'checkBoxInput' + uuid)

const value = ref(props.modelValue)
const emits = defineEmits(['update:modelValue', 'change'])
watch(
  () => value.value,
  (val) => {
    emits('update:modelValue', val)
  }
)

watch(
  () => props.modelValue,
  () => {
    value.value = props.modelValue
  }
)

function handleChange() {
  emits('change', value.value)
}
</script>
<template>
  <div class="checkBoxContainer" :class="{ 'is-disabled': props.disabled }">
    <div class="checkBox">
      <input
        :id="inputId"
        v-model="value"
        class="sure"
        type="checkbox"
        :value="true"
        :disabled="props.disabled"
        :aria-label="props.ariaLabel"
        @change="handleChange"
      />
      <label class="box" :for="inputId"></label>
    </div>
    <label class="text" :for="inputId">
      <slot />
    </label>
  </div>
</template>
<style lang="scss" scoped>
input[type='checkbox'] {
  visibility: hidden;
}

.checkBoxContainer {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.checkBoxContainer.is-disabled {
  opacity: 0.55;
  pointer-events: none;
}

.checkBox {
  position: relative;
  width: 18px;
  height: 18px;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: 3px;
}

.checkBox .box {
  position: absolute;
  width: 18px;
  height: 18px;
  top: 0;
  left: 0;
  background: var(--bg-elev);
  border-radius: 3px;
}

.checkBox .box:after {
  opacity: 0;
  /*修改为0*/
  content: '';
  position: absolute;
  width: 11px;
  height: 7px;
  background: transparent;
  top: 2px;
  left: 3px;
  border: 1px solid var(--accent);
  border-top: none;
  border-right: none;

  -webkit-transform: rotate(-45deg);
  -moz-transform: rotate(-45deg);
  -o-transform: rotate(-45deg);
  -ms-transform: rotate(-45deg);
  transform: rotate(-45deg);
}

.checkBox .box:hover::after {
  opacity: 0;
}

.checkBox input[type='checkbox']:checked + .box:after {
  opacity: 1;
}

.text {
  cursor: pointer;
  user-select: none;
  color: var(--text);
}
</style>
