<template>
  <v-main>
    <v-card v-if="step === 'signIn'">
      <v-card-item>
        <v-card-title>
          Sign In
        </v-card-title>
        <v-card-subtitle>
          If account doesn't exist one will be created for you
        </v-card-subtitle>
        <v-card-text>
          <v-form @submit.prevent="signIn">
            <v-text-field v-bind="$ta('email-input')" v-model="email" required />
            <v-text-field
              v-bind="$ta('password-input')"
              v-model="password"
              :type="showPassword ? 'text' : 'password'"
              :append-inner-icon="showPassword ? 'mdi-eye-off' : 'mdi-eye'"
              @click:append-inner="showPassword = !showPassword"
              required
            />
            <v-btn type="submit" block class="mt-2" :disabled="!email || !password">
              {{ $t('sign-in') }}
            </v-btn>
          </v-form>
        </v-card-text>
      </v-card-item>
    </v-card>
    <v-card v-if="step === 'signUp'">
      <v-card-item>
        <v-card-title>
          Create handle
        </v-card-title>
        <v-card-subtitle>
          It will be used for your ID and Data Pod subdomain.
        </v-card-subtitle>
        <v-card-text>
          <v-form @submit.prevent="signUp">
            <v-text-field v-bind="$ta('handle-input')" v-model="handle" :error-messages="errors" required />
            <v-btn type="submit" block class="mt-2" :loading="checking" :disabled="!!errors">
              {{ $t('create') }}
            </v-btn>
          </v-form>
          <dl>
            <dt>ID</dt>
            <dd><v-chip :color="handleAvailable ? 'green' : 'red'" variant="flat">https://<span class="handle">{{handle}}</span>.{{config.idOrigin}}</v-chip></dd>
            <dt>Pod</dt>
            <dd><v-chip  :color="handleAvailable ? 'green' : 'red'" variant="flat">https://<span class="handle">{{handle}}</span>.{{config.dataOrigin}}</v-chip></dd>
          </dl>
        </v-card-text>
      </v-card-item>
    </v-card>
  </v-main>
</template>
<style lang="css">
dl {
  margin-top: 1rem;
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 1rem;
  align-items: baseline ;
}
dt, dd {
  margin: 0;
}
dd {
  font-size: 1.25rem;
}
.handle {
  font-weight: bold;
}
</style>

<script lang="ts" setup>
import { bootstrapAccount, checkHandle } from '@/effect'
import { getRuntimeConfig } from '@/runtime-config'
import { useCoreStore } from '@/store/core'
import { computedAsync } from '@vueuse/core'
import { computed, ref } from 'vue'

const config = getRuntimeConfig()
const coreStore = useCoreStore()
const email = ref('')
const password = ref('')
const showPassword = ref(false)
const handle = ref('')
const step = ref('signIn')
const checking = ref(false)
const handleAvailable = computedAsync(async () => {
  if (handle.value.length < 3) return false
  return checkHandle(handle.value)
})
const errors = computed(() => {
  if (handle.value.length < 3) return 'must be at least 3 characters'
  if (!handleAvailable.value) return 'is already taken'
})

async function signIn() {
  if (await coreStore.signIn(email.value, password.value)) {
    coreStore.navigateHome()
  } else {
    if (await coreStore.signUp(email.value, password.value)) {
      step.value = 'signUp'
    } else {
      console.log('failed to create account')
    }
  }
}

async function signUp() {
  if (await bootstrapAccount(handle.value)) coreStore.navigateHome()
  // if (await coreStore.linkWebId(webId)) coreStore.navigateHome()
}
</script>
