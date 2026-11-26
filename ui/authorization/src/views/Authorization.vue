<template>
  <v-main>
    <AuthenticateApp v-if="registered && !route.query.resource" :application="registered" />
    <AuthorizeApp
      v-if="
        !registered &&
        !route.query.resource &&
        appStore.authorizationData &&
        (agent || role || appStore.application)
      "
      :application="appStore.application"
      :agent="agent"
      :role="role"
      :authorization-data="appStore.authorizationData"
      :redirect="route.query.redirect !== 'false'"
    />
    <ShareResource
      v-if="!route.query.webid && clientId && appStore.resource"
      :application-id="clientId"
      :resource="appStore.resource"
      :social-agents="appStore.socialAgentList"
    />
  </v-main>
</template>

<script lang="ts" setup>
import type { Role } from '@janeirodigital/sai-api-messages'
import { computed, ref, watch } from 'vue'
import { useRoute } from 'vue-router'

import AuthenticateApp from '@/components/AuthenticateApp.vue'
import AuthorizeApp from '@/components/AuthorizeApp.vue'
import ShareResource from '@/components/ShareResource.vue'
import { useAppStore } from '@/store/app'
import { useCoreStore } from '@/store/core'

const appStore = useAppStore()
const coreStore = useCoreStore()

const route = useRoute()
const clientId = ref<string | null>(null)
const agentId = ref<string | null>(null)
const roleId = ref<string | null>(null)
const resourceId = ref<string | undefined>()
const accessNeedGroupIri = ref<string | undefined>()
const registered = computed(() => appStore.applicationList.find((app) => app.id === clientId.value))

watch(
  () => [route.query.client_id, route.query.resource],
  async ([cId, resource]) => {
    if (route.name !== 'authorization') {
      return
    }
    if (route.query.webid || route.query.role) {
      return
    }
    if (!cId || Array.isArray(cId)) {
      // Advance the interaction (WebID pick) before anything app-specific is
      // rendered: the resume rotates the interaction cookie to the consent
      // step, and a consent fetched against the consumed pick step answers
      // without OIDC controls.
      await coreStore.setWebId()
      clientId.value = await coreStore.getClientInfo()
      await appStore.listApplications()
      return
    }
    clientId.value = cId
    if (resource) {
      if (Array.isArray(resource)) {
        throw new Error('only one resource is allowed')
      }
      resourceId.value = resource
    }
    const needs = route.query.needs
    if (needs && !Array.isArray(needs)) {
      accessNeedGroupIri.value = needs
    }
  },
  { immediate: true }
)

watch(
  () => route.query.webid,
  (webid) => {
    if (webid) {
      appStore.listSocialAgents()
      if (Array.isArray(webid)) {
        throw new Error('only one agent is allowed')
      }
      agentId.value = webid
      // the approval entry (authorization-granting.md §6.8): a social-agent
      // authorization ALWAYS originates from a pending need-based access
      // request — the group comes from its embedded copy. There is no other
      // group source (registrations carry none) and no producer builds a
      // bare `?webid=` entry, so a missing request is a malformed entry.
      const request = route.query.request
      if (!request || Array.isArray(request)) {
        throw new Error('a social-agent authorization requires an access request')
      }
      appStore.getAuthoriaztion(webid, undefined, undefined, request)
    }
  },
  { immediate: true }
)

watch(
  () => route.query.role,
  (roleQueryParam) => {
    if (roleQueryParam) {
      appStore.listRoles()
      if (Array.isArray(roleQueryParam)) {
        throw new Error('only one role is allowed')
      }
      roleId.value = roleQueryParam
      const needs = route.query.needs
      if (needs && !Array.isArray(needs)) {
        accessNeedGroupIri.value = needs
      }
      if (accessNeedGroupIri.value) {
        appStore.getAuthoriaztion(roleQueryParam, undefined, accessNeedGroupIri.value)
      }
    }
  },
  { immediate: true }
)

watch(
  resourceId,
  (id) => {
    if (id) {
      appStore.getResource(id)
      appStore.listSocialAgents()
    }
  },
  { immediate: true }
)

watch(
  clientId,
  (id) => {
    if (id && !resourceId.value) {
      appStore.getUnregisteredApplication(id)
      appStore.getAuthoriaztion(id, undefined, accessNeedGroupIri.value)
    }
  },
  { immediate: true }
)

const agent = computed(() => appStore.socialAgentList.find((a) => a.id === agentId.value))
const role = computed(() =>
  roleId.value ? appStore.roleList.find((r) => r.id === roleId.value) : undefined
)
</script>
