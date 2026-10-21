<template>
  <v-container>
    <v-list>
      <v-list-item
        v-for="application in appStore.applicationList"
        :key="application.id"
        :prepend-avatar="application.logo"
        :title="application.name"
      >
        <template #append>
          <v-btn
            icon="mdi-shield-key-outline"
            :title="$t('manage-access')"
            :aria-label="$t('manage-access')"
            :to="{
              name: 'authorizations',
              query: { grantee: application.id, label: application.name, kind: 'application' },
            }"
          />
          <a
            v-if="application.callbackEndpoint"
            :href="application.callbackEndpoint"
            target="_blank"
          >
            <v-icon icon="mdi-open-in-new" />
          </a>
        </template>
      </v-list-item>
    </v-list>
    <v-btn id="add-button" color="primary" @click="addDialog = true">
      <v-icon icon="mdi-plus" />{{ $t('add-application') }}
    </v-btn>
    <v-dialog v-model="addDialog" persistent fullscreen width="100vw">
      <v-card>
        <v-card-title>{{ $t('add-application') }}</v-card-title>
        <v-card-text>
          <v-text-field v-model="addClientId" v-bind:="$ta('add-application-input')" />
        </v-card-text>
        <v-card-actions>
          <v-btn color="warning" variant="tonal" @click="addDialog = false">
            {{ $t('cancel') }}
          </v-btn>
          <v-spacer />
          <v-btn color="primary" :disabled="!addClientId" @click="addApplication">
            {{ $t('next') }}
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-container>
</template>
<script lang="ts" setup>
import { ref } from 'vue'
import { useRouter } from 'vue-router'

import { useAppStore } from '@/store/app'

const router = useRouter()

const appStore = useAppStore()
appStore.listApplications()

const addDialog = ref(false)
const addClientId = ref('')

// https://acme.pod.docker/projectron/vue
function addApplication() {
  addDialog.value = false
  if (addClientId.value) {
    router.push({
      name: 'authorization',
      query: { client_id: addClientId.value, redirect: 'false' },
    })
  }
}
</script>

<style>
#add-button {
  display: block;
  margin: 16px auto 0;
}
</style>
