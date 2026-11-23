<template>
  <v-card v-if="application" :title="application.name" :prepend-avatar="application.logo" />
  <v-card v-if="agent" :title="agent.label" :subtitle="agent.note" />
  <v-card v-if="role" :title="role.label" />
  <v-alert
    v-if="coreStore.lang !== authorizationData.accessNeedGroup.lang"
    color="info"
    icon="mdi-translate"
  >
    <template #append>
      <template v-if="descriptionLanguages.length === 1">
        {{ descriptionLanguages[0].title }}
      </template>
      <template v-else>
        <v-select v-model="alternativeLang" :items="descriptionLanguages" :disabled="langLoading" />
      </template>
    </template>
  </v-alert>
  <v-skeleton-loader v-if="langLoading" type="card@2" />
  <v-card v-else>
    <v-card-text>
      <v-list-item lines="three" @click="toggleSelect(accessNeed.id)">
        <v-list-item-title>
          <v-icon :icon="chooseIcon(accessNeed.access)" />
          {{ accessNeed.shapeTree.label }}
        </v-list-item-title>
        <v-list-item-subtitle>
          {{ accessNeed.label }}
        </v-list-item-subtitle>
        <template #append>
          <v-list-item-action end>
            <v-checkbox-btn
              :model-value="isSelected(accessNeed.id)"
              :disabled="accessNeed.required"
              @click.prevent
            />
          </v-list-item-action>
        </template>
      </v-list-item>
      <v-list>
        <v-list-item
          v-for="child in accessNeed.children"
          :key="child.id"
          class="ml-3"
          lines="three"
          @click="toggleSelect(accessNeed.id, child.id)"
        >
          <v-list-item-title>
            <v-icon :icon="chooseIcon(child.access)" />
            {{ child.shapeTree.label }}
          </v-list-item-title>
          <v-list-item-subtitle>
            {{ child.label }}
          </v-list-item-subtitle>
          <template #append>
            <v-list-item-action end>
              <v-checkbox-btn
                :model-value="isSelected(accessNeed.id, child.id)"
                :disabled="child.required"
                @click.prevent
              />
            </v-list-item-action>
          </template>
        </v-list-item>
      </v-list>
      <v-tabs v-model="activeTab">
        <v-tab value="peers">Peers</v-tab>
        <v-tab value="roles">Roles</v-tab>
      </v-tabs>

      <v-tabs-window v-model="activeTab">
        <v-tabs-window-item value="peers">
          <v-expansion-panels id="panel-hell" v-model="panelsOpened" variant="popout">
            <v-expansion-panel value="top">
              <v-expansion-panel-title class="d-flex flex-row">
                <span class="flex-grow-1">{{
                  topLevelScope === 'all' ? $t('all-data') : $t('selected-data')
                }}</span>
                <v-chip color="agent" label>
                  {{ props.authorizationData.dataOwners.length }}
                </v-chip>
                <template #actions>
                  <v-badge
                    color="agent"
                    :content="statsForTopLevel()"
                    :model-value="topLevelScope === 'agent'"
                  >
                    <v-checkbox-btn
                      disabled
                      :indeterminate="topLevelScope === 'agent'"
                      :model-value="topLevelScope === 'all'"
                      @click.prevent
                    />
                  </v-badge>
                </template>
              </v-expansion-panel-title>
              <v-expansion-panel-text>
                <v-btn-toggle
                  v-model="topLevelScope"
                  rounded="false"
                  variant="outlined"
                  mandatory
                  class="d-flex flex-row"
                >
                  <v-btn class="flex-grow-1" icon="mdi-checkbox-blank-outline" value="none" />
                  <v-btn class="flex-grow-1" icon="mdi-minus-box-outline" value="agent" />
                  <v-btn class="flex-grow-1" icon="mdi-checkbox-outline" value="all" />
                </v-btn-toggle>
                <v-expansion-panels variant="popout">
                  <v-expansion-panel
                    v-for="owner in props.authorizationData.dataOwners"
                    :key="owner.id"
                    :disabled="topLevelScope !== 'agent'"
                  >
                    <v-expansion-panel-title class="d-flex flex-row">
                      <template v-if="owner.id === coreStore.userId">
                        <v-icon color="agent" icon="mdi-account-circle" />
                        <span class="label flex-grow-1">Me</span>
                      </template>
                      <template v-else>
                        <v-icon color="agent" icon="mdi-account-circle-outline" />
                        <span class="label flex-grow-1">{{ owner.label }}</span>
                      </template>
                      <v-chip color="primary" label>
                        {{ owner.dataRegistrations.length }}
                      </v-chip>
                      <template #actions>
                        <v-badge
                          color="primary"
                          :content="statsForAgent(owner.id)"
                          :model-value="agentsIndex[owner.id].scope === 'some'"
                        >
                          <v-checkbox-btn
                            disabled
                            :indeterminate="agentsIndex[owner.id].scope === 'some'"
                            :model-value="agentsIndex[owner.id].scope === 'all'"
                            @click.prevent
                          />
                        </v-badge>
                      </template>
                    </v-expansion-panel-title>
                    <v-expansion-panel-text>
                      <v-btn-toggle
                        :model-value="agentsIndex[owner.id].scope"
                        rounded="false"
                        variant="outlined"
                        mandatory
                        class="d-flex flex-row"
                        @update:model-value="agentScopeChanged(owner.id, $event)"
                      >
                        <v-btn class="flex-grow-1" icon="mdi-checkbox-blank-outline" value="none" />
                        <v-btn class="flex-grow-1" icon="mdi-minus-box-outline" value="some" />
                        <v-btn class="flex-grow-1" icon="mdi-checkbox-outline" value="all" />
                      </v-btn-toggle>
                      <v-expansion-panels variant="popout">
                        <v-expansion-panel
                          v-for="registration in owner.dataRegistrations"
                          :key="registration.id"
                          :disabled="agentsIndex[owner.id].scope !== 'some'"
                        >
                          <v-expansion-panel-title class="d-flex flex-row">
                            <v-icon color="primary" icon="mdi-hexagon-outline" />
                            <span class="label flex-grow-1">{{ registration.label }}</span>
                            <v-chip color="secondary" label>
                              {{ registration.count }}
                            </v-chip>
                            <template #actions>
                              <v-badge
                                color="secondary"
                                :content="statsForRegistration(registration.id)"
                                :model-value="registrationsIndex[registration.id].scope === 'some'"
                              >
                                <v-checkbox-btn
                                  disabled
                                  :indeterminate="
                                    registrationsIndex[registration.id].scope === 'some'
                                  "
                                  :model-value="registrationsIndex[registration.id].scope === 'all'"
                                  @click.prevent
                                />
                              </v-badge>
                            </template>
                          </v-expansion-panel-title>
                          <v-expansion-panel-text>
                            <v-btn-toggle
                              :model-value="registrationsIndex[registration.id].scope"
                              rounded="false"
                              variant="outlined"
                              mandatory
                              class="d-flex flex-row"
                              @update:model-value="
                                registrationScopeChanged(owner.id, registration.id, $event)
                              "
                            >
                              <v-btn
                                class="flex-grow-1"
                                icon="mdi-checkbox-blank-outline"
                                value="none"
                              />
                              <v-btn
                                class="flex-grow-1"
                                icon="mdi-minus-box-outline"
                                value="some"
                              />
                              <v-btn class="flex-grow-1" icon="mdi-checkbox-outline" value="all" />
                            </v-btn-toggle>
                            <template v-if="registrationsIndex[registration.id].scope === 'some'">
                              <v-list v-if="appStore.loadedDataInstances[registration.id]">
                                <v-list-item
                                  v-for="dataInstance of appStore.loadedDataInstances[
                                    registration.id
                                  ]"
                                  :key="dataInstance.id"
                                  :disabled="registrationsIndex[registration.id].scope !== 'some'"
                                  @click="toggleOneInstance(dataInstance.id)"
                                >
                                  <v-list-item-title>
                                    <v-icon
                                      color="secondary"
                                      icon="mdi-star-three-points-outline"
                                    />
                                    {{ dataInstance.label }}
                                  </v-list-item-title>
                                  <template #append>
                                    <v-list-item-action v-if="dataInstancesIndex[dataInstance.id]">
                                      <v-checkbox-btn
                                        v-model="dataInstancesIndex[dataInstance.id].selected"
                                        :disabled="
                                          registrationsIndex[registration.id].scope !== 'some'
                                        "
                                        @click.prevent
                                      />
                                    </v-list-item-action>
                                  </template>
                                </v-list-item>
                              </v-list>
                              <v-skeleton-loader v-else type="list-item@2" />
                            </template>
                          </v-expansion-panel-text>
                        </v-expansion-panel>
                      </v-expansion-panels>
                    </v-expansion-panel-text>
                  </v-expansion-panel>
                </v-expansion-panels>
              </v-expansion-panel-text>
            </v-expansion-panel>
          </v-expansion-panels>
        </v-tabs-window-item>
        <v-tabs-window-item value="roles">
          <v-expansion-panels variant="popout">
            <v-expansion-panel>
              <v-expansion-panel-title class="d-flex flex-row">
                <span class="flex-grow-1">Roles</span>
                <v-chip color="agent" label>
                  {{ appStore.roleList.length }}
                </v-chip>
              </v-expansion-panel-title>
              <v-expansion-panel-text>
                <v-list>
                  <v-list-item
                    v-for="role in appStore.roleList"
                    :key="role.id"
                    @click="toggleRole(role.id)"
                  >
                    <v-list-item-title>
                      <v-icon color="agent" icon="mdi-account-group-outline" />
                      {{ role.label }}
                    </v-list-item-title>
                    <template #append>
                      <v-list-item-action>
                        <v-checkbox-btn
                          :model-value="rolesIndex[role.id]?.selected ?? false"
                          @click.prevent
                        />
                      </v-list-item-action>
                    </template>
                  </v-list-item>
                </v-list>
              </v-expansion-panel-text>
            </v-expansion-panel>
          </v-expansion-panels>
        </v-tabs-window-item>
      </v-tabs-window>
    </v-card-text>
    <div class="px-2 d-flex justify-space-between">
      <v-btn
        color="error"
        variant="tonal"
        :loading="loadingDeny"
        :disabled="loadingAuthorize"
        @click="authorize(false)"
      >
        {{ $t('deny') }}
      </v-btn>
      <v-btn
        color="success"
        variant="flat"
        size="large"
        :loading="loadingAuthorize"
        :disabled="
          loadingDeny ||
          (activeTab === 'peers' && statsForTopLevel() === 0) ||
          (activeTab === 'roles' && statsForRoles() === 0)
        "
        @click="authorize()"
      >
        {{ $t('authorize') }}
      </v-btn>
    </div>
  </v-card>
</template>
<script lang="ts" setup>
import { AccessModes, IRI, Scopes } from '@janeirodigital/sai-api-messages'
import type {
  AccessNeed,
  Application,
  Authorization,
  AuthorizationData,
  BaseAuthorization,
  DataAuthorization,
  DataInstanceList,
  Role,
  SocialAgent,
} from '@janeirodigital/sai-api-messages'
import type { Schema } from 'effect/Schema'
import locale from 'locale-codes'
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { VExpansionPanel } from 'vuetify/lib/components/index.mjs'

import { useAppStore } from '@/store/app'
import { useCoreStore } from '@/store/core'

const router = useRouter()
const route = useRoute()

const coreStore = useCoreStore()
const appStore = useAppStore()

const props = defineProps<{
  application?: Partial<Schema.Type<typeof Application>>
  agent?: Schema.Type<typeof SocialAgent>
  role?: Schema.Type<typeof Role>
  authorizationData: Schema.Type<typeof AuthorizationData>
  redirect: boolean
}>()

const granteeId = computed(() => props.application?.id ?? props.agent?.id ?? props.role!.id)

// TODO add stepper to support multiple top level access needs
const accessNeed = computed(() => props.authorizationData.accessNeedGroup.needs[0])

const alternativeLang = ref(props.authorizationData.accessNeedGroup.lang)
const langLoading = ref(false)
const descriptionLanguages = computed(() =>
  props.authorizationData.accessNeedGroup.descriptionLanguages.map((lang) => ({
    title: locale.getByTag(lang)?.local || lang,
    value: lang,
  }))
)

watch(accessNeed, (need) => {
  if (need) {
    langLoading.value = false
  }
})

watch(alternativeLang, (selectedLang) => {
  langLoading.value = true
  // preserve the current query (the request approval entry or the explicit
  // access need group) — the needs come from the request's embedded copy or
  // accessNeedGroupIri, never from agent registrations
  const request = route.query.request
  const needs = route.query.needs
  appStore.getAuthoriaztion(
    granteeId.value,
    selectedLang,
    needs && !Array.isArray(needs) ? needs : undefined,
    request && !Array.isArray(request) ? request : undefined
  )
})

type PropagatingScope = 'none' | 'all'
type Scope = PropagatingScope | 'some'
type TopLevelScope = PropagatingScope | 'agent'

interface Agent {
  id: string
  scope: Scope
}

// TODO: add proper type from sai-api-messages
function buildAgentsIndex(data: typeof props.authorizationData.dataOwners): Record<string, Agent> {
  const index: Record<string, Agent> = {}
  for (const agent of data) {
    index[agent.id] = {
      id: agent.id,
      scope: 'all',
    }
  }
  return index
}

const agentsIndex = reactive<Record<string, Agent>>(
  buildAgentsIndex(props.authorizationData.dataOwners)
)

interface Registration {
  id: string
  agent: string
  scope: Scope
  count: number
  shapeTree: string
}

// TODO: add proper type from sai-api-messages
function buildRegistrationsIndex(
  data: typeof props.authorizationData.dataOwners
): Record<string, Registration> {
  const index: Record<string, Registration> = {}
  for (const agent of data) {
    for (const registration of agent.dataRegistrations) {
      index[registration.id] = {
        id: registration.id,
        agent: agent.id,
        scope: 'all',
        count: registration.count!,
        shapeTree: registration.shapeTree,
      }
    }
  }
  return index
}

const registrationsIndex = reactive<Record<string, Registration>>(
  buildRegistrationsIndex(props.authorizationData.dataOwners)
)

interface SelectableDataInstance {
  id: string
  registration: string
  agent: string
  selected: boolean
}

const dataInstancesIndex = reactive<Record<string, SelectableDataInstance>>({})

// TODO: add proper type from sai-api-messages
function addDataInstancesToIndex(
  agentId: string,
  registrationId: string,
  dataInstances: Schema.Type<typeof DataInstanceList>,
  selected: boolean
): void {
  for (const dataInstance of dataInstances) {
    dataInstancesIndex[dataInstance.id] = {
      id: dataInstance.id,
      registration: registrationId,
      agent: agentId,
      selected,
    }
  }
}

function findAgentRegistrations(agentId: string): Array<Registration> {
  return Object.values(registrationsIndex).filter((registration) => registration.agent === agentId)
}
function findRegistrationDataInstances(registrationId: string): Array<SelectableDataInstance> {
  return Object.values(dataInstancesIndex).filter(
    (dataInstance) => dataInstance.registration === registrationId
  )
}

const activeTab = ref<'peers' | 'roles'>('peers')

const panelsOpened = ref<Array<string>>([])
const topLevelScope = ref<TopLevelScope>('all')

function setScopeForAgents(scope: PropagatingScope): void {
  for (const agent of Object.values(agentsIndex)) {
    agent.scope = scope
  }
}

/**
 * Apply the requested scope of a pending access request: preselect the
 * specific instances (or the registration) the requester asked for, instead
 * of defaulting the owner's whole data set to `all`. The owner can still
 * widen or narrow the selection before authorizing.
 */
async function applyRequestedSelections(): Promise<void> {
  const requested = props.authorizationData.accessNeedGroup.needs.filter(
    (need) => need.dataInstances?.length || need.dataRegistration
  )
  if (requested.length === 0) {
    return
  }

  // a specific request is not an implicit "all of my data" grant
  topLevelScope.value = 'agent'
  setScopeForAgents('none')
  panelsOpened.value = ['top']

  const wantedByRegistration = new Map<string, Set<string>>()
  const wholeRegistration = new Set<string>()
  for (const need of requested) {
    const candidates = Object.values(registrationsIndex).filter(
      (registration) =>
        registration.shapeTree === need.shapeTree.id &&
        (!need.dataRegistration || registration.id === need.dataRegistration)
    )
    for (const registration of candidates) {
      if (need.dataInstances?.length) {
        const wanted = wantedByRegistration.get(registration.id) ?? new Set<string>()
        for (const instance of need.dataInstances) {
          wanted.add(instance)
        }
        wantedByRegistration.set(registration.id, wanted)
      } else {
        wholeRegistration.add(registration.id)
      }
    }
  }

  for (const registration of Object.values(registrationsIndex)) {
    const agent = agentsIndex[registration.agent]
    if (!agent) {
      continue
    }
    if (wholeRegistration.has(registration.id)) {
      agent.scope = 'some'
      registration.scope = 'all'
      continue
    }
    const wanted = wantedByRegistration.get(registration.id)
    if (!wanted) {
      continue
    }
    agent.scope = 'some'
    registration.scope = 'some'
    try {
      await loadDataInstances(registration.agent, registration.id, false)
    } catch {
      // the requested target is not readable in this context; leave the
      // registration unselected for the owner to choose
      continue
    }
    for (const instance of findRegistrationDataInstances(registration.id)) {
      if (wanted.has(instance.id)) {
        instance.selected = true
      }
    }
  }
}

// TODO: make propagation independent of DOM
onMounted(async () => {
  initRolesIndex()
  // set default to current user (they may not own data in this authorization,
  // e.g. approving an access request in an org context)
  if (props.agent || props.role) {
    topLevelScope.value = 'agent'
    setScopeForAgents('none')
    const user = agentsIndex[coreStore.userId!]
    if (user) {
      user.scope = 'all'
    }
    panelsOpened.value = ['top']
  }
  await applyRequestedSelections()
})

watch(topLevelScope, (newScope) => {
  if (newScope !== 'agent') {
    setScopeForAgents(newScope)
  }
})

function setScopeForAgentRegistrations(agentId: string, scope: PropagatingScope): void {
  const registrations = findAgentRegistrations(agentId)
  for (const registration of registrations) {
    registration.scope = scope
  }
}

function agentScopeChanged(agentId: string, scope: Scope) {
  if (scope !== 'some') {
    setScopeForAgentRegistrations(agentId, scope)
  }
  agentsIndex[agentId].scope = scope
}

async function loadDataInstances(
  agentId: string,
  registrationId: string,
  selected: boolean
): Promise<void> {
  await appStore.listDataInstances(IRI.make(agentId), IRI.make(registrationId))
  addDataInstancesToIndex(
    agentId,
    registrationId,
    appStore.loadedDataInstances[registrationId],
    selected
  )
}

function setSelectedForRegistrationInstances(registrationId: string, selected: boolean): void {
  const dataInstances = findRegistrationDataInstances(registrationId)
  for (const dataInstance of dataInstances) {
    if (dataInstance.registration === registrationId) {
      dataInstance.selected = selected
    }
  }
}

function registrationScopeChanged(agentId: string, registrationId: string, scope: Scope) {
  if (scope !== 'some') {
    setSelectedForRegistrationInstances(registrationId, scope === 'all')
  } else if (!appStore.loadedDataInstances[registrationId]) {
    const previousScope = registrationsIndex[registrationId].scope
    loadDataInstances(agentId, registrationId, previousScope === 'all')
  }
  registrationsIndex[registrationId].scope = scope
}

function toggleOneInstance(instanceId: string) {
  const instance = dataInstancesIndex[instanceId]
  const registration = registrationsIndex[instance.registration]
  if (registration.scope === 'some') {
    // UI is also disabling the element
    dataInstancesIndex[instanceId].selected = !dataInstancesIndex[instanceId].selected
  }
}

function statsForRegistration(registrationId: string): number {
  const registration = registrationsIndex[registrationId]
  if (registration.scope === 'none') {
    return 0
  }
  if (registration.scope === 'all') {
    return registration.count
  }
  const dataInstances = findRegistrationDataInstances(registration.id)
  return dataInstances.filter((dataInstance) => dataInstance.selected).length
}

function statsForAgent(agentId: string): number {
  const agent = agentsIndex[agentId]
  if (agent.scope === 'none') {
    return 0
  }
  const registrations = findAgentRegistrations(agentId)
  if (agent.scope === 'all') {
    return registrations.length
  }
  return registrations.filter((registration) => statsForRegistration(registration.id)).length
}

function statsForTopLevel(): number {
  if (topLevelScope.value === 'none') {
    return 0
  }
  const agents = Object.values(agentsIndex)
  if (topLevelScope.value === 'all') {
    return agents.length
  }
  return agents.filter((agent) => statsForAgent(agent.id)).length
}

interface SelectableRole {
  id: string
  selected: boolean
}

const rolesIndex = reactive<Record<string, SelectableRole>>({})

function initRolesIndex(): void {
  for (const role of appStore.roleList) {
    rolesIndex[role.id] = { id: role.id, selected: false }
  }
}

function toggleRole(roleId: string): void {
  rolesIndex[roleId].selected = !rolesIndex[roleId].selected
}

function statsForRoles(): number {
  return Object.values(rolesIndex).filter((r) => r.selected).length
}

const loadingAuthorize = ref(false)
const loadingDeny = ref(false)
const selection = reactive({
  needs: props.authorizationData.accessNeedGroup.needs.map((n) => ({
    id: n.id,
    required: n.required,
    selected: true,
    children: n.children?.map((c) => ({
      id: c.id,
      required: c.required,
      selected: true,
    })),
  })),
})

function toggleSelect(needId: string, childId?: string): void {
  const need = selection.needs.find((n) => n.id === needId)!
  if (childId) {
    const child = need.children!.find((n) => n.id === childId)!
    if (child.required) {
      return
    }
    child.selected = !child.selected
  } else {
    if (need.required) {
      return
    }
    need.selected = !need.selected
  }
}

function isSelected(needId: string, childId?: string): boolean {
  const need = selection.needs.find((n) => n.id === needId)!
  if (childId) {
    const child = need.children!.find((n) => n.id === childId)!
    return child.selected
  }
  return need.selected
}

function chooseIcon(access: ReadonlyArray<Schema.Type<typeof IRI>>): string {
  if (access.includes(IRI.make(AccessModes.Modify))) {
    return 'mdi-square-edit-outline'
  }
  return 'mdi-euey-outline'
}

// TODO throw error if required need is not satisfied
function createDataAuthorizations(
  need: Schema.Type<typeof AccessNeed>,
  parent?: Schema.Type<typeof AccessNeed>
): Array<Schema.Type<typeof DataAuthorization>> {
  if (!parent && !isSelected(need.id)) {
    return []
  }
  if (parent && !isSelected(parent.id, need.id)) {
    return []
  }
  const dataAuthorizations: Array<Schema.Type<typeof DataAuthorization>> = []
  const accessNeedAuthorization = {
    accessNeed: need.id,
  } as Partial<Schema.Type<typeof DataAuthorization>>
  if (need.parent) {
    dataAuthorizations.push({
      ...accessNeedAuthorization,
      scope: Scopes.Inherited,
    } as Schema.Type<typeof DataAuthorization>)
  } else if (topLevelScope.value === 'all') {
    dataAuthorizations.push({
      ...accessNeedAuthorization,
      scope: Scopes.All,
    } as Schema.Type<typeof DataAuthorization>)
  } else if (activeTab.value === 'roles') {
    for (const role of Object.values(rolesIndex)) {
      if (role.selected) {
        dataAuthorizations.push({
          ...accessNeedAuthorization,
          scope: Scopes.AllFromRole,
          dataOwner: role.id,
        } as Schema.Type<typeof DataAuthorization>)
      }
    }
  } else if (topLevelScope.value === 'agent') {
    for (const agent of Object.values(agentsIndex)) {
      const agentAuthorization = {
        ...accessNeedAuthorization,
        dataOwner: agent.id,
      }
      if (agent.scope === 'all') {
        dataAuthorizations.push({
          ...agentAuthorization,
          scope: Scopes.AllFromAgent,
        } as Schema.Type<typeof DataAuthorization>)
      } else if (agent.scope === 'some') {
        for (const registration of findAgentRegistrations(agent.id)) {
          const registrationAuthorization = {
            ...agentAuthorization,
            dataRegistration: registration.id,
          } as Partial<Schema.Type<typeof DataAuthorization>>
          if (registration.scope === 'all') {
            dataAuthorizations.push({
              ...registrationAuthorization,
              scope: Scopes.AllFromRegistry,
            } as Schema.Type<typeof DataAuthorization>)
          } else if (registration.scope === 'some') {
            dataAuthorizations.push({
              ...registrationAuthorization,
              scope: Scopes.SelectedFromRegistry,
              dataInstances: findRegistrationDataInstances(registration.id)
                .filter((i) => i.selected)
                .map((i) => i.id),
            } as unknown as Schema.Type<typeof DataAuthorization>)
          }
        }
      }
    }
  }
  let children: Array<Schema.Type<typeof DataAuthorization>> = []
  if (need.children) {
    children = need.children.flatMap((childAccessNeed) =>
      createDataAuthorizations(childAccessNeed, need)
    )
  }
  return [...dataAuthorizations, ...children]
}

function authorize(granted = true) {
  // UI also disables the authorize button
  if (granted && activeTab.value === 'roles' && statsForRoles() === 0) {
    throw new Error('Use granted = false if no data is being shared')
  }
  if (granted && activeTab.value === 'peers' && topLevelScope.value === 'none') {
    throw new Error('Use granted = false if no data is being shared')
  }
  loadingAuthorize.value = granted
  loadingDeny.value = !granted
  if (props.authorizationData) {
    let authorization: Schema.Type<typeof Authorization>
    const baseAuthorization = {
      grantee: props.authorizationData.id,
      accessNeedGroup: props.authorizationData.accessNeedGroup.id,
    } as Schema.Type<typeof BaseAuthorization>
    if (granted) {
      authorization = {
        ...baseAuthorization,
        dataAuthorizations: props.authorizationData.accessNeedGroup.needs.flatMap((need) =>
          createDataAuthorizations(need)
        ),
        granted: true,
      }
    } else {
      authorization = {
        ...baseAuthorization,
        granted: false,
      }
    }
    // @ts-expect-error `dataAuthorizations` is absent from the generated type
    if (granted && !authorization.dataAuthorizations?.length) {
      throw new Error('Use granted = false if no data is being shared')
    }
    appStore.authorizeApp(authorization)
  }
}

// activity-first: the store claims the AuthorizationGranted activity the
// moment the RPC ack resolves (the app-shell snackbar then tracks pending →
// done) — navigate away from the authorization screen at that point; the
// store's eager post-RPC list refetch plus the done-event fullRefresh keep
// the target list fresh
watch(
  () => appStore.activitySnackbar.claim,
  async (claim) => {
    if (claim?.type !== 'AuthorizationGranted') {
      return
    }
    if (props.redirect) {
      window.location.href = await coreStore.consent()
    } else if (props.agent) {
      router.push({ name: 'social-agent-list' })
    } else if (props.role) {
      router.push({ name: 'role-list' })
    } else {
      router.push({ name: 'application-list' })
    }
  }
)
</script>

<style>
#panel-hell .v-expansion-panel-text__wrapper {
  padding: 8px 0px 16px;
}

#panel-hell .v-expansion-panel-title {
  padding: 16px 16px;
}

span.label {
  padding-left: 6px;
}
</style>
