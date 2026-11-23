<template>
  <v-sheet>
    <v-card>
      <v-card-item>
        <v-form @submit.prevent="create">
          <v-text-field
            v-if="route.query.direction === 'accept'"
            v-model="capabilityUrl"
            v-bind="$ta('invitation-link-input')"
            :rules="[rules.required]"
          />
          <v-text-field
            v-model="label"
            v-bind="$ta('invitation-label-input')"
            :rules="[rules.required]"
          />
          <v-text-field v-model="note" v-bind="$ta('invitation-note-input')" />
          <v-btn type="submit" block class="mt-2" :loading="loading" :disabled="!valid">
            {{
              route.query.direction === 'create' ? $t('create-invitation') : $t('accept-invitation')
            }}
          </v-btn>
        </v-form>
      </v-card-item>
    </v-card>
  </v-sheet>
</template>
<script lang="ts" setup>
import { useFluent } from 'fluent-vue'
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import { useAppStore } from '@/store/app'

const router = useRouter()
const route = useRoute()
const appStore = useAppStore()
const { $t } = useFluent()

const capabilityUrl = ref('')
const label = ref('')
const note = ref('')
const loading = ref(false)

const valid = computed(
  () => label.value && (route.query.direction === 'accept' ? capabilityUrl.value : true)
)

watch(
  () => route.query.text,
  (text) => {
    if (text) {
      capabilityUrl.value = text as string
    }
  },
  { immediate: true }
)

const rules = {
  required: (value: string) => !!value || $t('required'),
}

async function create() {
  loading.value = true
  if ((route.query.direction as string) === 'create') {
    const invitation = await appStore.createInvitation(label.value, note.value)
    router.push({ name: 'social-agent-list', query: { invitation: invitation.id } })
  } else {
    if (!capabilityUrl.value) {
      return
    }
    await appStore.acceptInvitation(capabilityUrl.value, label.value, note.value)
    router.push({ name: 'social-agent-list' })
  }
}
</script>
