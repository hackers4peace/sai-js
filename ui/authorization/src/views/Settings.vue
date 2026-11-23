<template>
  <v-list>
    <v-list-item>
      <v-form @submit.prevent="signOut">
        <v-btn type="submit" block class="mt-2">
          {{ $t('sign-out') }}
        </v-btn>
      </v-form>
    </v-list-item>
    <v-list-item>
      <v-list-item-title>{{ $t('language') }}</v-list-item-title>
      <template #append>
        <v-select v-model="coreStore.lang" :items="languages" />
      </template>
    </v-list-item>
    <v-list-item id="translation">
      <a href="https://hosted.weblate.org/projects/sai/" target="_blank">
        {{ $t('help-translating') }}
      </a>
    </v-list-item>
  </v-list>
</template>

<script lang="ts" setup>
import locale from 'locale-codes'
import { computed } from 'vue'

import { useCoreStore } from '@/store/core'

const coreStore = useCoreStore()

const languages = computed(() =>
  coreStore.availableLanguages.map((lang) => ({
    title: locale.getByTag(lang)?.local || lang,
    value: lang,
  }))
)

async function signOut() {
  if (await coreStore.signOut()) {
    coreStore.navigateHome()
  }
}
</script>
<style scoped>
#translation {
  text-align: right;
}
</style>
