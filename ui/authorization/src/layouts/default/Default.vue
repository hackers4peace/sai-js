<template>
  <v-app>
    <v-app-bar v-if="coreStore.userId" elevation="0">
      <v-app-bar-title @click="coreStore.navigateHome()">
        <v-icon icon="mdi-shield-account" />
        SAI
      </v-app-bar-title>
      <v-spacer />
      <!-- org-admin context switcher: personal context + each administered org -->
      <v-select
        v-model="currentContext"
        :items="contextItems"
        item-title="title"
        item-value="value"
        hide-details
        density="compact"
        variant="outlined"
        class="context-switcher"
        :label="$t('context')"
      />
    </v-app-bar>
    <router-view />

    <!-- activity indicator (step 0): the latest claimed activity — spinner +
         yellow while pending, ✓ + light green on done, auto-hides 5s after
         completion (the store schedules the hide; timeout=-1 keeps pending
         visible until the workflow finishes) -->
    <v-snackbar
      v-model="appStore.activitySnackbar.visible"
      :color="
        appStore.activitySnackbar.status === 'pending' ? 'amber-lighten-3' : 'light-green-lighten-3'
      "
      :timeout="-1"
      location="top"
    >
      <div class="d-flex align-center">
        <v-progress-circular
          v-if="appStore.activitySnackbar.status === 'pending'"
          indeterminate
          size="18"
          width="2"
          class="mr-2"
        />
        <span v-else class="mr-2">✓</span>
        <span>{{ activityLabel }}</span>
      </div>
    </v-snackbar>
  </v-app>
</template>

<script lang="ts" setup>
import { useFluent } from 'fluent-vue'
import { computed, watch } from 'vue'

import { ACTIVITY_LABELS } from '@/activityLabels'
import { useAppStore } from '@/store/app'
import { useCoreStore } from '@/store/core'

const coreStore = useCoreStore()
const appStore = useAppStore()
const { $t } = useFluent()

const contextItems = computed(() => [
  {
    title: `${$t('personal-context-person')} (${coreStore.userId})`,
    value: coreStore.userId,
  },
  ...appStore.contexts
    .filter((c) => c.webId !== coreStore.userId)
    .map((c) => ({ title: c.label, value: c.webId })),
])

const currentContext = computed({
  get: () => appStore.context ?? coreStore.userId,
  set: (webId: string) => void appStore.switchContext(webId),
})

/** the snackbar label for the claimed activity class (map + class-name fallback) */
const activityLabel = computed(() => {
  const claim = appStore.activitySnackbar.claim
  if (!claim) {
    return ''
  }
  const key = ACTIVITY_LABELS[claim.type]
  return key ? $t(key) : claim.type
})

// prime the switcher list once the user is known (personal-context discovery)
watch(
  () => coreStore.userId,
  (userId) => {
    if (userId) {
      void appStore.listSocialAgents(true)
    }
  },
  { immediate: true }
)
</script>

<style scoped>
.context-switcher {
  max-width: 320px;
}
</style>
