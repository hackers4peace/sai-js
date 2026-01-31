<template>
  <v-sheet>
    <v-card
      v-for="agent in appStore.socialAgentList"
      :key="agent.id"
      :title="agent.label"
      :subtitle="agent.note"
    >
      <v-card-actions>
        <v-spacer />
        <v-btn
          prepend-icon="mdi-hexagon-multiple-outline"
          :to="{name: 'data-registry-list', query: {agent: agent.id}}"
        >
          {{ $t('data') }}
        </v-btn>
        <v-btn
          :disabled="!agent.accessNeedGroup"
          prepend-icon="mdi-security"
          :to="{name: 'authorization', query: {webid: agent.id, redirect: 'false'}}"
        >
          {{ $t('access') }}
          <template
            v-if="agent.accessNeedGroup && !agent.accessGrant"
            #append
          >
            <v-badge
              inline
              color="warning"
              icon="mdi-bell-ring-outline"
            />
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
        <v-btn
          prepend-icon="mdi-content-copy"
          @click="copyCapabilityUrl(invitation)"
        >
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
    <v-btn
      id="add"
      icon="mdi-plus-circle-outline"
      @click="showAdd=true"
    />
    <v-bottom-sheet v-model="showAdd">
      <v-list>
        <v-list-item
          prepend-icon="mdi-account-arrow-right"
          @click="router.push( { name: 'invitation', query: { direction: 'create'}})"
        >
          {{ $t('create-invitation') }}
        </v-list-item>
        <v-list-item
          prepend-icon="mdi-account-arrow-left"
          @click="router.push( { name: 'invitation', query: { direction: 'accept'}})"
        >
          {{ $t('accept-invitation') }}
        </v-list-item>
      </v-list>
    </v-bottom-sheet>
  </v-sheet>
</template>
<script lang="ts" setup>
import { useAppStore } from '@/store/app'
import type { SocialAgentInvitation } from '@janeirodigital/sai-api-messages'
import type * as S from 'effect/Schema'
import { ref } from 'vue'
import { useRouter } from 'vue-router'

const router = useRouter()
const appStore = useAppStore()
appStore.listSocialAgents()
appStore.listSocialAgentInvitations()
const showAdd = ref(false)

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
