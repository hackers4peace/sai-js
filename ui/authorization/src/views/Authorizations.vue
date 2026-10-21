<template>
  <v-container>
    <div class="d-flex align-center mb-4">
      <v-btn icon="mdi-arrow-left" variant="text" @click="router.back()" />
      <div class="ml-2 flex-grow-1">
        <div class="text-h6">{{ granteeLabel }}</div>
        <div class="text-body-2 text-medium-emphasis">{{ $t('authorizations') }}</div>
      </div>
      <v-checkbox
        v-if="appStore.authorizationList.length"
        :model-value="allSelected"
        :indeterminate="someSelected && !allSelected"
        :label="$t('select-all')"
        hide-details
        density="compact"
        class="mr-2"
        @click.prevent="toggleAll"
      />
      <v-btn
        color="error"
        variant="flat"
        :disabled="selection.size === 0"
        @click="confirmRevoke = true"
      >
        {{ $t('revoke') }}
      </v-btn>
    </div>

    <v-alert v-if="!grantee" color="warning" icon="mdi-alert-circle-outline">
      {{ $t('no-authorizations') }}
    </v-alert>
    <v-alert
      v-else-if="!appStore.authorizationList.length"
      color="info"
      icon="mdi-information-outline"
    >
      {{ $t('no-authorizations') }}
    </v-alert>

    <v-card v-for="group in groups" :key="group.key" class="mb-4">
      <v-card-title class="d-flex align-center">
        <v-icon
          class="mr-2"
          :icon="
            group.dataOwner === coreStore.userId
              ? 'mdi-account-circle'
              : 'mdi-account-circle-outline'
          "
        />
        <span class="flex-grow-1">{{ dataOwnerLabel(group.dataOwner) }}</span>
        <v-chip size="small" label>{{ group.nodes.length }}</v-chip>
      </v-card-title>
      <v-list lines="two">
        <v-list-item
          v-for="node in group.nodes"
          :key="node.authorization.id"
          :style="{ paddingLeft: `${16 + node.depth * 24}px` }"
        >
          <template #prepend>
            <v-checkbox-btn
              :model-value="selection.has(node.authorization.id)"
              :indeterminate="isIndeterminate(node.authorization.id)"
              @click.stop.prevent="toggle(node.authorization.id)"
            />
            <v-icon :icon="chooseIcon(node.authorization.accessMode)" />
          </template>
          <v-list-item-title>
            <v-icon v-if="node.depth > 0" size="small" class="mr-1">
              mdi-subdirectory-arrow-right
            </v-icon>
            {{ node.authorization.shapeTreeLabel }}
          </v-list-item-title>
          <v-list-item-subtitle>
            <span>{{ scopeLabel(node.authorization.scopeOfAuthorization) }}</span>
            <span v-if="node.authorization.hasDataRegistration">
              · {{ shortIri(node.authorization.hasDataRegistration) }}
            </span>
            <span v-if="node.authorization.grantee !== grantee">
              · {{ $t('via-role') }} {{ shortIri(node.authorization.grantee) }}
            </span>
          </v-list-item-subtitle>
          <template #append>
            <v-chip
              v-for="mode in node.authorization.accessMode"
              :key="mode"
              size="x-small"
              class="mr-1"
              variant="tonal"
            >
              {{ modeLabel(mode) }}
            </v-chip>
          </template>
        </v-list-item>
      </v-list>
    </v-card>

    <v-dialog v-model="confirmRevoke" max-width="480">
      <v-card>
        <v-card-title>{{ $t('revoke-confirm-title') }}</v-card-title>
        <v-card-text>
          {{ $t('revoke-confirm-text') }}
          <v-alert v-if="revokeError" type="error" density="compact" class="mt-3">
            {{ revokeError }}
          </v-alert>
        </v-card-text>
        <v-card-actions>
          <v-btn variant="tonal" @click="confirmRevoke = false">{{ $t('cancel') }}</v-btn>
          <v-spacer />
          <v-btn color="error" :loading="revoking" @click="revoke">{{ $t('revoke') }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-container>
</template>

<script lang="ts" setup>
import type { RecordedDataAuthorization } from '@janeirodigital/sai-api-messages'
import type * as S from 'effect/Schema'
import { useFluent } from 'fluent-vue'
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import { useAppStore } from '@/store/app'
import { useCoreStore } from '@/store/core'

type DataAuthorization = S.Schema.Type<typeof RecordedDataAuthorization>

interface AuthorizationNode {
  authorization: DataAuthorization
  depth: number
}

interface AuthorizationGroup {
  key: string
  dataOwner?: string
  nodes: AuthorizationNode[]
}

const router = useRouter()
const route = useRoute()
const appStore = useAppStore()
const coreStore = useCoreStore()
const { $t } = useFluent()

const grantee = computed(() =>
  typeof route.query.grantee === 'string' ? route.query.grantee : undefined
)

// ── selection (C2): parent toggles its inheritance descendants; the revoke
// dialog calls the authorization-level RPC — grants are never targeted ──
const selection = reactive(new Set<string>())
const confirmRevoke = ref(false)
const revoking = ref(false)
const revokeError = ref<string>()

const childrenById = computed(() => {
  const children = new Map<string, string[]>()
  for (const authorization of appStore.authorizationList) {
    const parent = authorization.inheritsFromAuthorization
    if (!parent) continue
    const list = children.get(parent) ?? []
    list.push(authorization.id)
    children.set(parent, list)
  }
  return children
})

function descendantsOf(id: string): string[] {
  const result: string[] = []
  const stack = [...(childrenById.value.get(id) ?? [])]
  while (stack.length > 0) {
    const child = stack.pop()!
    result.push(child)
    stack.push(...(childrenById.value.get(child) ?? []))
  }
  return result
}

function toggle(id: string) {
  if (selection.has(id)) {
    selection.delete(id)
    for (const descendant of descendantsOf(id)) selection.delete(descendant)
  } else {
    selection.add(id)
    for (const descendant of descendantsOf(id)) selection.add(descendant)
  }
}

function isIndeterminate(id: string): boolean {
  const descendants = descendantsOf(id)
  if (descendants.length === 0) return false
  return descendants.some((descendant) => selection.has(descendant)) && !selection.has(id)
}

const allSelected = computed(
  () =>
    appStore.authorizationList.length > 0 && selection.size === appStore.authorizationList.length
)
const someSelected = computed(() => selection.size > 0)

function toggleAll() {
  if (allSelected.value) {
    selection.clear()
  } else {
    for (const authorization of appStore.authorizationList) selection.add(authorization.id)
  }
}

async function revoke() {
  const id = grantee.value
  if (!id) return
  revokeError.value = undefined
  revoking.value = true
  try {
    await appStore.revokeAuthorizations(id, [...selection])
    selection.clear()
    confirmRevoke.value = false
  } catch (err) {
    // typed `AuthorizationRevocationFailure`: show the code (C4 / D11)
    const code = (err as { code?: string } | undefined)?.code
    revokeError.value = code ? $t('revocation-failed-code', { code }) : $t('revocation-failed')
  } finally {
    revoking.value = false
  }
}
const label = computed(() =>
  typeof route.query.label === 'string' ? route.query.label : undefined
)

const granteeLabel = computed(() => {
  const id = grantee.value
  if (label.value) return label.value
  if (!id) return ''
  return (
    appStore.socialAgentList.find((agent) => agent.id === id)?.label ??
    appStore.applicationList.find((application) => application.id === id)?.name ??
    shortIri(id)
  )
})

const groups = computed<AuthorizationGroup[]>(() => {
  const sorted = appStore.authorizationList.toSorted(
    (a, b) => a.shapeTreeLabel.localeCompare(b.shapeTreeLabel) || a.id.localeCompare(b.id)
  )
  const byId = new Map(sorted.map((authorization) => [authorization.id, authorization]))
  const children = new Map<string, DataAuthorization[]>()
  const roots: DataAuthorization[] = []
  for (const authorization of sorted) {
    const parent = authorization.inheritsFromAuthorization
    if (parent && byId.has(parent)) {
      const group = children.get(parent) ?? []
      group.push(authorization)
      children.set(parent, group)
    } else {
      roots.push(authorization)
    }
  }

  // Build the tree once across the whole list: a child whose own `dataOwner`
  // is missing still nests under its parent and joins the parent's group.
  const seen = new Set<string>()
  const nodesFor = (root: DataAuthorization): AuthorizationNode[] => {
    const nodes: AuthorizationNode[] = []
    const visit = (authorization: DataAuthorization, depth: number) => {
      if (seen.has(authorization.id)) return
      seen.add(authorization.id)
      nodes.push({ authorization, depth })
      for (const child of children.get(authorization.id) ?? []) visit(child, depth + 1)
    }
    visit(root, 0)
    return nodes
  }

  const byOwner = new Map<string, AuthorizationNode[]>()
  for (const root of roots) {
    const key = root.dataOwner ?? ''
    const nodes = byOwner.get(key) ?? []
    nodes.push(...nodesFor(root))
    byOwner.set(key, nodes)
  }
  // malformed cycle: the unreachable remainder renders at the root
  for (const authorization of sorted) {
    if (seen.has(authorization.id)) continue
    const key = authorization.dataOwner ?? ''
    const nodes = byOwner.get(key) ?? []
    nodes.push(...nodesFor(authorization))
    byOwner.set(key, nodes)
  }

  return [...byOwner.entries()]
    .filter(([, nodes]) => nodes.length > 0)
    .toSorted(([a], [b]) => (a || '\uffff').localeCompare(b || '\uffff'))
    .map(([key, nodes]) => ({
      key: key || 'all',
      dataOwner: key || undefined,
      nodes,
    }))
})

function shortIri(iri: string): string {
  return iri.replace(/^https?:\/\//, '').replace(/\/$/, '')
}

function tail(iri: string): string {
  return iri.split('#').pop()?.split('/').pop() ?? iri
}

const SCOPE_KEYS: Record<string, string> = {
  All: 'scope-All',
  AllFromAgent: 'scope-AllFromAgent',
  AllFromRole: 'scope-AllFromRole',
  AllFromRegistry: 'scope-AllFromRegistry',
  SelectedFromRegistry: 'scope-SelectedFromRegistry',
  Inherited: 'scope-Inherited',
}

const MODE_KEYS: Record<string, string> = {
  Read: 'mode-Read',
  Update: 'mode-Update',
  Create: 'mode-Create',
  Delete: 'mode-Delete',
}

function scopeLabel(scope: string): string {
  const name = tail(scope)
  const key = SCOPE_KEYS[name]
  return key ? $t(key) : name
}

function modeLabel(mode: string): string {
  const name = tail(mode)
  const key = MODE_KEYS[name]
  return key ? $t(key) : name
}

function chooseIcon(access: readonly string[]): string {
  return access.some((mode) => tail(mode) === 'Update' || tail(mode) === 'Create')
    ? 'mdi-square-edit-outline'
    : 'mdi-eye-outline'
}

function dataOwnerLabel(dataOwner?: string): string {
  if (!dataOwner) return $t('all-data')
  if (dataOwner === coreStore.userId) return $t('me')
  // the current context (personal or org) is a data owner but is not part of
  // the social-agent list; the context switcher already carries its label
  const contextLabel = appStore.contexts.find((entry) => entry.webId === dataOwner)?.label
  if (contextLabel) return contextLabel
  return (
    appStore.socialAgentList.find((agent) => agent.id === dataOwner)?.label ?? shortIri(dataOwner)
  )
}

watch(
  [grantee, () => appStore.context, () => coreStore.lang],
  ([id]) => {
    selection.clear()
    if (id) {
      void appStore.listAuthorizations(id)
    } else {
      appStore.authorizationList = []
    }
  },
  { immediate: true }
)

// a refreshed list (eager or done-event) invalidates the old selection
watch(
  () => appStore.authorizationList,
  () => selection.clear()
)

onMounted(() => {
  // labels for the subject and the data owners (the lists may not be loaded on
  // a direct navigation / reload)
  void appStore.listSocialAgents()
  void appStore.listApplications()
})
</script>
