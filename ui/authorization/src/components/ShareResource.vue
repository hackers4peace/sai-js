<template>
  <v-card
    :title="resource.label"
    :subtitle="resource.shapeTree.label"
  >
    <v-card-actions>
      <AccessModeSelector @selected="(mode) => modeSelected(resource.shapeTree.id, mode)" />
    </v-card-actions>
    <v-card-text>
      <v-list>
        <v-list-item
          v-for="child of resource.children"
          :key="child.shapeTree.id"
        >
          <v-list-item-title>
            {{ child.shapeTree.label }}
            <v-badge
              color="secondary"
              :content="child.count"
              inline
            />
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
              <v-checkbox-btn
                :model-value="selectedAgents.has(agent.id)"
                @click.prevent
              />
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
          <template #append>
            <v-list-item-action end>
              <v-btn
                icon="mdi-arrow-right-thick"
                variant="text"
                @click="router.push({ name: 'authorization', query: { webid: agent.id } })"
              />
            </v-list-item-action>
          </template>
        </v-list-item>
      </v-list>
    </v-card-text>
    <div class="px-2 d-flex justify-space-between">
      <v-btn
        color="warning"
        variant="tonal"
        :disabled="loading"
      >
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
import AccessModeSelector from '@/components/AccessModeSelector.vue'
import { useAppStore } from '@/store/app'
import {
  AccessModes,
  IRI,
  type Resource,
  ShapeTree,
  type SocialAgentList,
} from '@janeirodigital/sai-api-messages'
import type * as S from 'effect/Schema'
import { computed, reactive, ref, watch } from 'vue'
import { useRouter } from 'vue-router'

const router = useRouter()
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

const existingGrantees = computed(() =>
  props.socialAgents.filter((agent) => props.resource.accessGrantedTo.includes(agent.id))
)

const potentialGrantees = computed(() =>
  props.socialAgents.filter((agent) => !props.resource.accessGrantedTo.includes(agent.id))
)

function chooseAccessMode(value: string): string[] {
  switch (value) {
    case 'view':
      return [AccessModes.Read]
    case 'edit':
      return [AccessModes.Read, AccessModes.Update]
    case 'add':
      return [AccessModes.Read, AccessModes.Update, AccessModes.Create]
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
    if (confirmation) window.location.href = confirmation.callbackEndpoint
  }
)
</script>
