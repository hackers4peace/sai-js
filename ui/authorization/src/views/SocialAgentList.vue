<template>
  <v-sheet>
    <v-card
      v-for="agent in appStore.socialAgentList"
      :key="agent.id"
      :title="agent.label"
      :subtitle="agent.note"
    >
      <v-card-subtitle v-if="agent.admin">
        <v-chip size="small" color="primary" class="mr-1">
          {{ $t('admin') }}
        </v-chip>
      </v-card-subtitle>
      <v-card-actions>
        <v-spacer />
        <!-- promote/demote admins: org context — fellow admins of the org;
             personal context (Phase 5, org-admin-feature.md) — the user's
             OWN admins, so a regular user can manage their own registry set.
             `agent.admin` is the direct marker in both contexts. -->
        <v-btn
          :disabled="inOrgContext && agent.admin && adminCount <= 1"
          :prepend-icon="agent.admin ? 'mdi-shield-remove-outline' : 'mdi-shield-plus-outline'"
          @click="appStore.toggleAdmin(agent.id, !agent.admin)"
        >
          {{ agent.admin ? $t('remove-admin') : $t('add-admin') }}
        </v-btn>
        <v-btn
          prepend-icon="mdi-hexagon-multiple-outline"
          :to="{ name: 'data-registry-list', query: { agent: agent.id } }"
        >
          {{ $t('data') }}
          <template v-if="agent.accessRequestsSent.length > 0" #append>
            <v-badge inline color="warning">
              <!-- direction icon + count via the custom badge slot (Vuetify
                   renders `icon` and `content` mutually exclusively) -->
              <template #badge>
                <v-icon icon="mdi-outbox" size="small" />
                {{ agent.accessRequestsSent.length }}
              </template>
            </v-badge>
          </template>
        </v-btn>
        <v-btn
          :disabled="agent.accessRequestsReceived.length === 0"
          prepend-icon="mdi-security"
          :to="accessRoute(agent)"
        >
          {{ $t('access') }}
          <template v-if="agent.accessRequestsReceived.length > 0" #append>
            <v-badge inline color="warning">
              <template #badge>
                <v-icon icon="mdi-inbox" size="small" />
                {{ agent.accessRequestsReceived.length }}
              </template>
            </v-badge>
          </template>
        </v-btn>
      </v-card-actions>
    </v-card>
    <v-card
      v-for="invitation in appStore.invitationList"
      :key="invitation.id"
      :title="invitation.label"
      :subtitle="invitation.note"
    >
      <v-card-actions>
        <v-spacer />
        <v-btn prepend-icon="mdi-content-copy" @click="copyCapabilityUrl(invitation)">
          {{ $t('copy-link') }}
        </v-btn>
        <v-btn
          v-if="shareAvaliable()"
          prepend-icon="mdi-email-fast-outline"
          @click="webShareUrl(invitation)"
        >
          {{ $t('send-link') }}
        </v-btn>
      </v-card-actions>
    </v-card>
    <v-btn id="add" icon="mdi-plus-circle-outline" @click="showAdd = true" />
    <v-bottom-sheet v-model="showAdd">
      <v-list>
        <v-list-item
          prepend-icon="mdi-account-arrow-right"
          @click="router.push({ name: 'invitation', query: { direction: 'create' } })"
        >
          {{ $t('create-invitation') }}
        </v-list-item>
        <v-list-item
          prepend-icon="mdi-account-arrow-left"
          @click="router.push({ name: 'invitation', query: { direction: 'accept' } })"
        >
          {{ $t('accept-invitation') }}
        </v-list-item>
      </v-list>
    </v-bottom-sheet>
  </v-sheet>
</template>
<script lang="ts" setup>
import type { SocialAgentInvitation } from '@janeirodigital/sai-api-messages'
import type * as S from 'effect/Schema'
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'

import { useAppStore } from '@/store/app'
import { useCoreStore } from '@/store/core'

const router = useRouter()
const coreStore = useCoreStore()
const appStore = useAppStore()
appStore.listSocialAgents()
appStore.listSocialAgentInvitations()
const showAdd = ref(false)

/** Open incoming request count + the access-button target: a SINGLE open
 *  request keeps the direct-to-authorization flow (`request: <iri>` opens
 *  the approval screen); multiple requests route to the peer detail where
 *  each entry is approvable (see the OpenWiki `services/activity-lifecycle.md`). */
function accessRoute(agent: { id: string; accessRequestsReceived: readonly string[] }) {
  if (agent.accessRequestsReceived.length === 1) {
    return {
      name: 'authorization',
      query: { webid: agent.id, redirect: 'false', request: agent.accessRequestsReceived[0] },
    }
  }
  return { name: 'data-registry-list', query: { agent: agent.id } }
}

/** switching contexts re-targets the list; the last-admin disable applies to
 *  an org context only (Phase 5: in the personal context the owner remains —
 *  the RPC guard is skipped there, so demoting the last admin is allowed) */
const inOrgContext = computed(() => !!appStore.context && appStore.context !== coreStore.userId)

/** last-admin guard: refuse to demote the only remaining admin in an org
 *  context (the RPC enforces it there too) */
const adminCount = computed(() => appStore.socialAgentList.filter((agent) => agent.admin).length)

function copyCapabilityUrl(invitation: S.Schema.Type<typeof SocialAgentInvitation>) {
  navigator.clipboard.writeText(invitation.capabilityUrl)
}

function webShareUrl(invitation: S.Schema.Type<typeof SocialAgentInvitation>) {
  navigator.share({
    title: invitation.label,
    text: invitation.note,
    url: invitation.capabilityUrl,
  })
}

function shareAvaliable() {
  return navigator.share
}
</script>

<style>
#add {
  position: absolute;
  bottom: 60px;
  left: calc(50% - 24px);
}
</style>
