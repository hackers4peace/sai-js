<template>
  <v-container>
    <v-card v-if="appStore.socialAgentList">
      <v-card-title>
        <template v-if="route.query.agent === coreStore.userId">
          <v-icon color="agent" icon="mdi-account-circle" />
          <span class="label flex-grow-1">{{ $t('me') }}</span>
        </template>
        <template v-else>
          <v-icon color="agent" icon="mdi-account-circle-outline" />
          <span class="label flex-grow-1">{{ agent?.label }}</span>
        </template>
      </v-card-title>
    </v-card>
    <v-expansion-panels>
      <v-expansion-panel
        v-for="registry in appStore.dataRegistryList[route.query.agent as string]"
        :key="registry.id"
      >
        <v-expansion-panel-title class="d-flex flex-row">
          <v-icon color="primary" icon="mdi-hexagon-outline" />
          <span class="label flex-grow-1">{{ registry.label }}</span>
        </v-expansion-panel-title>
        <v-expansion-panel-text>
          <v-expansion-panels>
            <v-expansion-panel
              v-for="registration in registry.registrations"
              :key="registration.id"
              :title="registration.label"
              @click="appStore.listDataInstances(route.query.agent as string, registration.id)"
            >
              <v-expansion-panel-text>
                <v-list v-if="appStore.loadedDataInstances[registration.id]">
                  <v-list-item
                    v-for="dataInstance of appStore.loadedDataInstances[registration.id]"
                    :key="dataInstance.id"
                  >
                    <v-list-item-title>
                      <v-icon color="secondary" icon="mdi-star-three-points-outline" />
                      {{ dataInstance.label }}
                    </v-list-item-title>
                  </v-list-item>
                </v-list>
                <v-skeleton-loader v-else type="list-item@2" />
              </v-expansion-panel-text>
            </v-expansion-panel>
          </v-expansion-panels>
        </v-expansion-panel-text>
      </v-expansion-panel>
    </v-expansion-panels>
    <v-card v-if="agent && appStore.dataRegistryList[agent.id] && !hasData">
      <template v-if="agent.accessRequestsSent.length === 0">
        <v-card-title>{{ $t('request-access') }}</v-card-title>
        <v-btn prepend-icon="mdi-security" @click="appListDialog = true">
          {{ $t('based-on-an-application') }}
        </v-btn>
      </template>
      <v-card-title v-else>
        {{ $t('access-requested') }}
      </v-card-title>
    </v-card>

    <!-- peer detail — open access requests (see the OpenWiki `services/activity-lifecycle.md`):
         incoming approval entries + outgoing sent requests, one action per
         request (approve/archive any of them — the multi-request future) -->
    <v-card
      v-if="
        agent && (agent.accessRequestsReceived.length > 0 || agent.accessRequestsSent.length > 0)
      "
    >
      <v-card-title>{{ $t('open-requests') }}</v-card-title>
      <v-list v-if="agent.accessRequestsReceived.length > 0">
        <v-list-item
          v-for="request in agent.accessRequestsReceived"
          :key="request"
          prepend-icon="mdi-inbox"
          :subtitle="request"
        >
          <template #append>
            <v-btn
              size="small"
              prepend-icon="mdi-security"
              :to="{
                name: 'authorization',
                query: { webid: agent.id, redirect: 'false', request },
              }"
            >
              {{ $t('approve') }}
            </v-btn>
          </template>
        </v-list-item>
      </v-list>
      <v-list v-if="agent.accessRequestsSent.length > 0">
        <v-list-item
          v-for="request in agent.accessRequestsSent"
          :key="request"
          prepend-icon="mdi-outbox"
          :subtitle="request"
        >
          <template #append>
            <v-btn size="small" prepend-icon="mdi-archive-outline" @click="archiveRequest(request)">
              {{ $t('archive') }}
            </v-btn>
          </template>
        </v-list-item>
      </v-list>
    </v-card>

    <v-dialog :model-value="appListDialog">
      <v-list>
        <v-list-item
          v-for="application in appStore.applicationList"
          :key="application.id"
          :prepend-avatar="application.logo"
          :title="application.name"
          @click="requestAccess(application.id)"
        />
      </v-list>
    </v-dialog>
  </v-container>
</template>
<script lang="ts" setup>
import { computed, ref, watch } from 'vue'
import { useRoute } from 'vue-router'

import { useAppStore } from '@/store/app'
import { useCoreStore } from '@/store/core'

const appStore = useAppStore()
const coreStore = useCoreStore()
const route = useRoute()
const appListDialog = ref(false)

appStore.listSocialAgents()
appStore.listApplications()

function requestAccess(applicationId: string) {
  if (!route.query.agent) return
  appStore.requestAccess(applicationId, route.query.agent as string)
  appListDialog.value = false
}

function archiveRequest(request: string) {
  appStore.archiveAccessRequest(request)
}

const agent = computed(() => appStore.socialAgentList.find((a) => a.id === route.query.agent))

const hasData = computed(() => !!appStore.dataRegistryList[route.query.agent as string]?.length)

watch(
  () => route.query.agent,
  async (agentId) => {
    if (agentId) {
      await appStore.listDataRegistries(agentId as string, coreStore.lang)
    }
  },
  { immediate: true }
)

// Access-state changes while ON this view must re-fetch the agent's data
// registries: the profile refreshes on activity events (grant detected,
// archived, direct share — `DelegatedGrantsUpdated`, revoke), and the data
// this user can see from the agent depends on exactly that access state.
// The route watcher above covers the first load; this covers in-place
// changes (the reported gap: the approved request clears after the event
// streamed, but the granted registries never appeared until re-navigation).
watch(
  () => agent.value,
  async (next, prev) => {
    if (!next || !prev || next.id !== route.query.agent) return
    await appStore.listDataRegistries(next.id, coreStore.lang)
  }
)
</script>

<style>
span.label {
  padding-left: 6px;
}
</style>
