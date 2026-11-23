<template>
  <v-card :title="resource.label" :subtitle="resource.shapeTree.label">
    <v-card-actions>
      <AccessModeSelector @selected="(mode) => modeSelected(resource.shapeTree.id, mode)" />
    </v-card-actions>
    <v-card-text>
      <v-list>
        <v-list-item v-for="child of resource.children" :key="child.shapeTree.id">
          <v-list-item-title>
            {{ child.shapeTree.label }}
            <v-badge color="secondary" :content="child.count" inline />
          </v-list-item-title>
          <template #append>
            <v-list-item-action>
              <AccessModeSelector
                add
                :disabled="!shareData.accessMode.length"
                @selected="(mode) => modeSelected(child.shapeTree.id, mode)"
              />
            </v-list-item-action>
          </template>
        </v-list-item>
      </v-list>
      <v-list>
        <v-list-subheader>{{ $t('select-peers') }}</v-list-subheader>
        <v-list-item
          v-for="agent of potentialGrantees"
          :key="agent.id"
          :title="agent.label"
          @click="toggleAgent(agent.id)"
        >
          <template #append>
            <v-list-item-action end>
              <v-checkbox-btn :model-value="selectedAgents.has(agent.id)" @click.prevent />
            </v-list-item-action>
          </template>
        </v-list-item>
      </v-list>
      <v-list>
        <v-list-subheader>{{ $t('peers-with-access') }}</v-list-subheader>
        <v-list-item
          v-for="agent of existingGrantees"
          :key="agent.id"
          :title="agent.label"
          :value="agent.id"
        >
          <template v-if="rolesOf(agent.id).length" #append>
            <v-chip
              v-for="role of rolesOf(agent.id)"
              :key="role.role"
              size="small"
              class="mr-1"
              :text="$t('via-role', { role: role.label })"
            />
          </template>
        </v-list-item>
      </v-list>
      <v-list v-if="rolesWithAccess.length">
        <v-list-subheader>{{ $t('roles-with-access') }}</v-list-subheader>
        <v-list-group v-for="role of rolesWithAccess" :key="role.role" :value="role.role">
          <template #activator="{ props: activatorProps }">
            <v-list-item v-bind="activatorProps" :title="role.label">
              <template #append>
                <v-chip size="small" :text="String(role.members.length)" />
              </template>
            </v-list-item>
          </template>
          <v-list-item v-for="member of role.members" :key="member" :title="agentLabel(member)">
            <template v-if="directIds.has(member)" #append>
              <v-chip size="small" :text="$t('direct-access')" />
            </template>
          </v-list-item>
        </v-list-group>
      </v-list>
    </v-card-text>
    <div class="px-2 d-flex justify-space-between">
      <v-btn color="warning" variant="tonal" :disabled="loading">
        {{ $t('cancel') }}
      </v-btn>
      <v-btn
        color="primary"
        variant="flat"
        size="large"
        :loading="loading"
        :disabled="!valid"
        @click="share"
      >
        {{ $t('share') }}
      </v-btn>
    </div>
  </v-card>
  <v-bottom-navigation />
</template>

<script lang="ts" setup>
import {
  AccessModes,
  IRI,
  type Resource,
  ShapeTree,
  type SocialAgentList,
} from '@janeirodigital/sai-api-messages'
import type * as S from 'effect/Schema'
import { computed, reactive, ref, watch } from 'vue'

import AccessModeSelector from '@/components/AccessModeSelector.vue'
import { useAppStore } from '@/store/app'

const appStore = useAppStore()

const props = defineProps<{
  applicationId: string
  resource: S.Schema.Type<typeof Resource>
  socialAgents: S.Schema.Type<typeof SocialAgentList>
}>()

type ShareAuthorizationModes = {
  accessMode: string[]
  children: { shapeTree: string; accessMode: string[] }[]
}
const shareData: ShareAuthorizationModes = reactive({
  accessMode: [],
  children: [],
})

const loading = ref(false)

const selectedAgents = reactive<Set<string>>(new Set())

const valid = computed(() => Boolean(shareData.accessMode.length && selectedAgents.size))

function toggleAgent(id: string) {
  if (selectedAgents.has(id)) {
    selectedAgents.delete(id)
  } else {
    selectedAgents.add(id)
  }
}

const directIds = computed(() => new Set<string>(props.resource.accessGrantedTo))
const rolesWithAccess = computed(() => props.resource.accessGrantedViaRoles ?? [])
const roleMemberIds = computed(
  () => new Set<string>(rolesWithAccess.value.flatMap(({ members }) => members))
)

const existingGrantees = computed(() =>
  props.socialAgents.filter((agent) => directIds.value.has(agent.id))
)

// an agent can hold access directly AND through a granted role (both facts are
// reported by the server); role members are not offered as new grantees — the
// role grant already covers them (one grant per member on the server side)
const potentialGrantees = computed(() =>
  props.socialAgents.filter(
    (agent) => !directIds.value.has(agent.id) && !roleMemberIds.value.has(agent.id)
  )
)

function rolesOf(agentId: S.Schema.Type<typeof IRI>) {
  return rolesWithAccess.value.filter(({ members }) => members.includes(agentId))
}

function agentLabel(agentId: string): string {
  return props.socialAgents.find(({ id }) => id === agentId)?.label ?? agentId
}

function chooseAccessMode(value: string): string[] {
  switch (value) {
    case 'view':
      return [AccessModes.Read]
    case 'edit':
      return [AccessModes.Read, AccessModes.Modify]
    case 'add':
      return [AccessModes.Read, AccessModes.Modify, AccessModes.Create]
    default:
      return []
  }
}
function modeSelected(shapeTree: string, mode: string) {
  if (shapeTree === props.resource.shapeTree.id) {
    shareData.accessMode = chooseAccessMode(mode)
  } else {
    let child = shareData.children.find((c) => c.shapeTree === shapeTree)
    if (!child) {
      child = { shapeTree, accessMode: chooseAccessMode(mode) }
      shareData.children.push(child)
    } else {
      child.accessMode = chooseAccessMode(mode)
    }
  }
}

function share() {
  loading.value = true
  appStore.shareResource({
    applicationId: IRI.make(props.applicationId),
    resource: props.resource.id,
    accessMode: shareData.accessMode.map((m) => IRI.make(m)),
    children: shareData.children.map((c) => ({
      shapeTree: IRI.make(c.shapeTree),
      accessMode: c.accessMode.map((m) => IRI.make(m)),
    })),
    agents: [...selectedAgents].map((a) => IRI.make(a)),
  })
}

watch(
  () => appStore.shareAuthorizationConfirmation,
  (confirmation) => {
    if (confirmation) {
      window.location.href = confirmation.callbackEndpoint
    }
  }
)
</script>
