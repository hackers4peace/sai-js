<template>
  <v-main>
    <v-card v-if="step === 'signIn'">
      <v-card-item>
        <v-card-title> Sign In </v-card-title>
        <v-card-subtitle> If account doesn't exist one will be created for you </v-card-subtitle>
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
        <v-card-title> Create handle </v-card-title>
        <v-card-subtitle> It will be used for your ID and Data Pod subdomain. </v-card-subtitle>
        <v-card-text>
          <v-form @submit.prevent="signUp">
            <v-text-field
              v-bind="$ta('handle-input')"
              v-model="handle"
              :error-messages="errors"
              required
            />
            <v-btn
              type="submit"
              block
              class="mt-2"
              :loading="checking"
              :disabled="!handleAvailable"
            >
              {{ $t('create') }}
            </v-btn>
          </v-form>
          <dl>
            <dt>ID</dt>
            <dd>
              <v-chip :color="chipColor" variant="flat"
                >https://<span class="handle">{{ handle }}</span
                >.{{ config.idOrigin }}</v-chip
              >
            </dd>
            <dt>Pod</dt>
            <dd>
              <v-chip :color="chipColor" variant="flat"
                >https://<span class="handle">{{ handle }}</span
                >.{{ config.dataOrigin }}</v-chip
              >
            </dd>
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
  align-items: baseline;
}
dt,
dd {
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
import { refDebounced } from '@vueuse/core'
import { computed, ref, watch } from 'vue'

import { bootstrapAccount, checkHandle } from '@/effect'
import { getRuntimeConfig } from '@/runtime-config'
import { useCoreStore } from '@/store/core'

const config = getRuntimeConfig()
const coreStore = useCoreStore()
const email = ref('')
const password = ref('')
const showPassword = ref(false)
const handle = ref('')
const step = ref('signIn')

// The answer belongs to `checkedHandle`, not to `handle`: a pending check must
// not reuse the previous answer (that rendered every unchecked handle as "is
// already taken") and `undefined`/rejected checks must not be read as "taken".
const checkedHandle = ref<string>()
const checkedAvailable = ref(false)
const checkFailed = ref(false)
const checking = ref(false)

const debouncedHandle = refDebounced(handle, 300)
watch(
  debouncedHandle,
  async (value, _previous, onCleanup) => {
    if (value.length < 3) {
      checkedHandle.value = undefined
      checking.value = false
      return
    }
    let cancelled = false
    onCleanup(() => {
      cancelled = true
    })
    checking.value = true
    try {
      const available = await checkHandle(value)
      if (cancelled) return
      checkedHandle.value = value
      checkedAvailable.value = available
    } catch (error) {
      if (cancelled) return
      checkedHandle.value = undefined
      checkFailed.value = true
      console.error('failed to check handle availability', error)
    } finally {
      if (!cancelled) checking.value = false
    }
  },
  { immediate: true }
)
// a new input invalidates the previous failure, not just the previous answer
watch(handle, () => {
  checkFailed.value = false
})

const handleChecked = computed(
  () => handle.value.length >= 3 && checkedHandle.value === handle.value
)
const handleAvailable = computed(() => handleChecked.value && checkedAvailable.value)
const handleTaken = computed(() => handleChecked.value && !checkedAvailable.value)
const chipColor = computed(() =>
  handleAvailable.value ? 'green' : handleTaken.value ? 'red' : undefined
)
const errors = computed(() => {
  if (handle.value.length < 3) return 'must be at least 3 characters'
  if (handleTaken.value) return 'is already taken'
  if (checkFailed.value) return 'could not check handle availability'
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
