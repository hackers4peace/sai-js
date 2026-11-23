<template>
  <Suspense>
    <router-view />
    <template #fallback>
      <v-progress-circular indeterminate color="primary" />
    </template>
  </Suspense>
</template>

<script lang="ts" setup>
import { watch } from 'vue'
import { useTheme } from 'vuetify'

import { startEvents, stopEvents } from '@/events'
import { useCoreStore } from '@/store/core'

const coreStore = useCoreStore()

// keep the /.sai/events stream open while signed in — full refresh on
// (re)connect + completion-driven refreshes (see openwiki/ui/authorization-ui.md)
watch(
  () => coreStore.userId,
  (userId) => {
    if (userId) {
      startEvents()
    } else {
      stopEvents()
    }
  },
  { immediate: true }
)

const theme = useTheme()

function toggleDark(on: boolean) {
  if (on) {
    theme.change('dark')
  } else {
    theme.change('light')
  }
}

const mq = window.matchMedia('(prefers-color-scheme: dark)')

toggleDark(mq.matches)

mq.addEventListener('change', () => {
  toggleDark(mq.matches)
})
</script>
