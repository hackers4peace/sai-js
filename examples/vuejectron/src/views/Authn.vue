<template>
  <v-card v-if="!hasError">
    <v-card-item v-if="!store.userId">
      <v-form @submit.prevent="login">
        <v-text-field v-model="oidcIssuer" :placeholder="defaultOidcIssuer" label="OIDC issuer" />
        <v-btn type="submit" block class="mt-2"> Login </v-btn>
      </v-form>
    </v-card-item>
    <!-- the app was just redirected back from its own authorization request:
         the grant generation and the registration projection are still running -->
    <v-card-item v-else-if="waiting">
      <div class="d-flex align-center justify-center ga-3 py-4">
        <v-progress-circular indeterminate size="24" />
        <span>Waiting for the authorization…</span>
      </div>
    </v-card-item>
    <v-card-item v-else>
      <v-btn block class="mt-2" @click="requestAuthorization"> Request Authorization </v-btn>
    </v-card-item>
  </v-card>
  <v-card v-else>
    <v-alert type="error" :title="appStore.saiError" />
  </v-card>
</template>

<script lang="ts" setup>
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'

import { getRuntimeConfig } from '@/runtime-config'
import { useAppStore } from '@/store/app'
import { useCoreStore } from '@/store/core'

const router = useRouter()
const store = useCoreStore()
const appStore = useAppStore()
const hasError = computed(() => !!appStore.saiError)

const defaultOidcIssuer = getRuntimeConfig().defaultOidcIssuer
const oidcIssuer = ref('')

// Only the return from the app's OWN authorization request blocks the screen:
// its registration and grants are guaranteed to arrive. A return from a login
// carries no grant for a first-time user, so it is only followed in the
// background (a unified authN/authZ deployment records the grant during the
// login interaction) — the request button stays available meanwhile.
const pendingKind = appStore.pendingAuthorizationKind()
const waiting = ref(pendingKind === 'request')

onMounted(async () => {
  if (!pendingKind) {
    return
  }
  const authorized = await appStore.pullAuthorization()
  if (authorized) {
    // keep the waiting card up through the navigation: switching back to the
    // request button first would flash it for the time the agent view needs to
    // load (the view is replaced once its async setup and the supervisors are
    // done)
    await router.push({ name: 'agent', query: { agent: store.userId } })
    return
  }
  waiting.value = false
})

// will redirect to OIDC issuer
async function login() {
  return store.login(oidcIssuer.value || defaultOidcIssuer)
}

// will redirect to authorization agent
async function requestAuthorization() {
  return appStore.authorize()
}
</script>
