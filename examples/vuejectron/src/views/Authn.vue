<template>
  <v-card v-if="!hasError">
    <v-card-item v-if="!store.userId">
      <v-form @submit.prevent="login">
        <v-text-field
          v-model="oidcIssuer"
          :placeholder="defaultOidcIssuer"
          label="OIDC issuer"
        />
        <v-btn
          type="submit"
          block
          class="mt-2"
        >
          Login
        </v-btn>
      </v-form>
    </v-card-item>
    <v-card-item v-else>
      <v-btn
        block
        class="mt-2"
        @click="requestAuthorization"
      >
        Request Authorization
      </v-btn>
    </v-card-item>
  </v-card>
  <v-card v-else>
    <v-alert
      type="error"
      :title="appStore.saiError"
    />
  </v-card>
</template>

<script lang="ts" setup>
import { getRuntimeConfig } from '@/runtime-config'
import { useAppStore } from '@/store/app'
import { useCoreStore } from '@/store/core'
import { computed, ref } from 'vue'

const store = useCoreStore()
const appStore = useAppStore()
const hasError = computed(() => !!appStore.saiError)

const defaultOidcIssuer = getRuntimeConfig().defaultOidcIssuer
const oidcIssuer = ref('')

// will redirect to OIDC issuer
async function login() {
  return store.login(oidcIssuer.value || defaultOidcIssuer)
}

// will redirect to authorization agent
async function requestAuthorization() {
  return appStore.authorize()
}
</script>
