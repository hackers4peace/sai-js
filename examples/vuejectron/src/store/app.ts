import {
  createBrowserCredential,
  createBrowserLwsFetch,
  createIdJagFetch,
} from '@elfpavlik/lws-auth'
import { Application, NotificationManager } from '@janeirodigital/interop-application'
import { WebIdProfile } from '@janeirodigital/interop-data-model'
import { AS, RequestError, loader, pickLanguage } from '@janeirodigital/interop-utils'
import type { WhatwgFetch } from '@janeirodigital/interop-utils'
import { commitData, changeData as ldoChangeData } from '@ldo/connected'
import type { ConnectedLdoDataset } from '@ldo/connected'
import { createSolidLdoDataset } from '@ldo/connected-solid'
import type { SolidConnectedPlugin } from '@ldo/connected-solid'
import type { LdoBase } from '@ldo/ldo'
import { useStorage } from '@vueuse/core'
import { defineStore } from 'pinia'
import { ref, shallowRef, triggerRef } from 'vue'

import type { Agent, ResourceServer } from '@/models'
import { getRuntimeConfig } from '@/runtime-config'
import { browserSession } from '@/session'

import { FileShapeType } from '../../ldo/File.shapeTypes'
import type { File as FileObject } from '../../ldo/File.typings'
import { ProjectShapeType } from '../../ldo/Project.shapeTypes'
import type { Project } from '../../ldo/Project.typings'
import { TaskShapeType } from '../../ldo/Task.shapeTypes'
import type { Task } from '../../ldo/Task.typings'
import { useCoreStore } from './core'

const loadWebIdProfile = loader(WebIdProfile.fromJsonLd)

type AgentId = string

export const useAppStore = defineStore('app', () => {
  // runtime-configurable: the Dagger stack seeds its own copy of the shape trees
  const shapeTreesOrigin = (
    getRuntimeConfig().shapeTreesOrigin ?? 'https://shapetrees.hackers4peace.net'
  ).replace(/\/$/, '')
  const scopes = {
    project: `${shapeTreesOrigin}/trees/Project`,
    task: `${shapeTreesOrigin}/trees/Task`,
    image: `${shapeTreesOrigin}/trees/Image`,
    file: `${shapeTreesOrigin}/trees/File`,
  }
  const subscriptions = useStorage<Map<string, string>>('subscriptions', new Map())
  const coreStore = useCoreStore()
  const agents = ref<Array<Agent>>([])
  const resourceServers = ref<Record<AgentId, Array<ResourceServer>>>({})
  const currentAgent = ref<Agent>()
  const currentProject = shallowRef<Project>()
  const saiError = ref<string | undefined>()
  const pushSubscription = ref<PushSubscription | null>(null)

  // TODO: find a better way to ensure it was created
  let session: Application
  let notificationsManager: NotificationManager
  let solidLdoDataset: ConnectedLdoDataset<Array<SolidConnectedPlugin>>
  const projects = ref<Array<Project>>([])

  const authSession = browserSession()

  /**
   * The data and registry storages accept only LWS access tokens and the `.sai`
   * API accepts only an identity-only ID-JAG. The app's Solid-OIDC session is
   * the first-hop credential for both; it is presented only to the UAS that
   * issued it, never to a storage or `.sai` route.
   *
   * The browser runs the LWS chain itself (`@elfpavlik/lws-auth`): its session
   * **access token** (`aud` = `auth`, `cnf.jkt` = the session key) is exchanged
   * for one ID-JAG per storage authorization server, and each grant is traded
   * for a storage access token. A separate identity-only ID-JAG (audience = the
   * `.sai` UAS, no `resource` claim) authenticates the `.sai` requests. The
   * token never leaves the browser and the grants are `aud`-restricted, so
   * nothing here can mint a token for another storage.
   *
   * Both legs use the session's **single** non-extractable DPoP key pair, which
   * also signs the token requests that mint the grants.
   */
  let sessionFetchCache: WhatwgFetch | undefined
  let fetchesCache: Promise<{ storage: WhatwgFetch; sai: WhatwgFetch }> | undefined
  /** `/.sai` requests never carry the DPoP session token — see `saiAudience`. */
  function isSaiUrl(url: string): boolean {
    return new URL(url, window.location.origin).pathname.startsWith('/.sai/')
  }
  /** The audience of a `.sai` ID-JAG: its own URL, or the UAS base for agent discovery. */
  function saiAudience(requestUrl: string): string {
    const parsed = new URL(requestUrl)
    return parsed.pathname.startsWith('/.sai/agents/') ? `${parsed.origin}/` : parsed.href
  }
  function sessionFetch(): WhatwgFetch {
    if (sessionFetchCache) {
      return sessionFetchCache
    }
    fetchesCache ??= (async () => {
      const credential = await createBrowserCredential(authSession)
      return {
        storage: await createBrowserLwsFetch({ session: authSession }),
        sai: createIdJagFetch({ credential, audience: saiAudience }),
      }
    })()
    const fetches = fetchesCache
    sessionFetchCache = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const { storage, sai } = await fetches
      return isSaiUrl(url) ? sai(input, init) : storage(input, init)
    }
    return sessionFetchCache
  }

  async function ensureSaiSession(): Promise<Application> {
    if (!coreStore.userId) {
      throw new Error('no user id')
    }
    if (session) {
      return session
    }
    const deps = { fetch: sessionFetch(), randomUUID: crypto.randomUUID.bind(crypto) }
    try {
      session = await Application.build(coreStore.userId, getRuntimeConfig().clientId, deps)
    } catch (error) {
      if (error instanceof RequestError) {
        saiError.value = error.message
        if (error.response) {
          console.error(error.response)
        }
      }
      throw error
    }
    notificationsManager = await NotificationManager.build(
      sessionFetch(),
      session.authorizationAgentIri
    )
    solidLdoDataset = createSolidLdoDataset()
    solidLdoDataset.setContext('solid', { fetch: sessionFetch() })
    // a freshly authorized app only gets the registration link once the
    // registration resource exists — see `pullAuthorization`
    await subscribeToRegistration()
    notificationsManager.addEventListener('notification', ((event: CustomEvent) => {
      // handle application registration
      if (event.detail.object === session.registrationIri && event.detail.type === AS.Update) {
        void handleRegistrationChange()
      }
      // handler regular resource updates
      if (event.detail.type === AS.Update) {
        void handleResourceChange(event.detail.object)
      }
    }) as EventListener)

    return session
  }

  /** Subscribe to the application registration once (it appears after the authorization). */
  let registrationSubscribed = false
  async function subscribeToRegistration(): Promise<void> {
    if (registrationSubscribed || !session?.registrationIri) {
      return
    }
    registrationSubscribed = true
    await notificationsManager.subscribeToResource(session.registrationIri)
  }

  function changeData<Type extends LdoBase>(input: Type): Type {
    const resource = solidLdoDataset.getResource(input['@id'])
    return ldoChangeData(input, resource)
  }

  async function loadAgents(force = false): Promise<void> {
    if (agents.value.length && !force) {
      return
    }
    await ensureSaiSession()
    const owners = await session.resourceOwners()
    const profiles = await Promise.all(
      [...owners].map((owner) => loadWebIdProfile(owner, session.fetch))
    )

    agents.value = profiles.map((profile) => ({
      id: profile.id,
      label: pickLanguage(profile.label) ?? 'unknown', // TODO think of a better fallback
    }))
  }

  function projectsFor(resourceServer: string): Array<Project> {
    return projects.value.filter(
      (project) => session.parentMap.get(project['@id']!)?.resourceServer === resourceServer
    )
  }

  async function loadProjects(ownerId: string): Promise<void> {
    if (resourceServers.value[ownerId]) {
      return
    }

    await ensureSaiSession()
    const servers: Array<ResourceServer> = []
    const scope = scopes.project
    for (const resourceServer of await session.resourceServers(ownerId, scope)) {
      servers.push({
        id: resourceServer,
        label: resourceServer, // TODO replace with human readabel label
        owner: ownerId,
        canCreate: await session.canCreate(resourceServer, scope),
      })
      const serverProjects: Array<Project> = []

      for (const projectId of await session.resources(resourceServer, scope)) {
        // @ldo-solid
        const ldoResource = solidLdoDataset.getResource(projectId)
        const readResult = await ldoResource.read()
        if (readResult.isError) {
          throw readResult
        }

        const ldoSolidProject = solidLdoDataset.usingType(ProjectShapeType).fromSubject(projectId)
        serverProjects.push(ldoSolidProject)
        // subscribe to changes
        //await notificationsManager.subscribeToResource(projectId)
      }
      projects.value = [...projects.value, ...serverProjects]
    }
    resourceServers.value[ownerId] = servers
  }

  async function reloadProject(projectId: string): Promise<void> {
    // @ldo-solid
    const ldoResource = solidLdoDataset.getResource(projectId)
    const readResult = await ldoResource.read()
    if (readResult.isError) {
      throw readResult
    }
    await loadChildren(projectId, scopes.task)
    await loadChildren(projectId, scopes.image)
    await loadChildren(projectId, scopes.file)
    triggerRef(currentProject)
  }

  async function reloadTask(taskId: string): Promise<void> {
    // @ldo-solid
    const ldoResource = solidLdoDataset.getResource(taskId)
    const readResult = await ldoResource.read()
    if (readResult.isError) {
      throw readResult
    }
    triggerRef(currentProject)
  }

  const propForScope = {
    [scopes.task]: 'hasTask',
    [scopes.image]: 'hasImage',
    [scopes.file]: 'hasFile',
  }

  function findProject(projectId: string): Project {
    const ldoProject = projects.value.find((project) => project['@id'] === projectId)
    if (!ldoProject) {
      throw new Error(`LDO Project not found for: ${projectId}`)
    }
    return ldoProject
  }

  async function loadChildren(projectId: string, scope: string, nonRdf = false): Promise<void> {
    await ensureSaiSession()
    const ldoProject = findProject(projectId)

    // @ts-expect-error LDO subjects are indexed by scope-specific property names
    for (const { '@id': childId } of ldoProject[propForScope[scope]]) {
      let description: string | undefined
      if (nonRdf) {
        description = await session.discoverDescription(childId)
        if (!description) {
          continue
        }
      }

      // @ldo-solid
      const ldoResource = solidLdoDataset.getResource(nonRdf ? description : childId)
      const readResult = await ldoResource.read()
      if (readResult.isError) {
        throw readResult
      }
      session.setChildInfo(childId, scope, ldoProject['@id']!)
      if (scope === scopes.task) {
        // subscribe to changes
        //await notificationsManager.subscribeToResource(childId)
      }
    }
  }

  async function loadTasks(projectId: string): Promise<void> {
    await loadChildren(projectId, scopes.task)
    triggerRef(currentProject)
  }

  async function loadImages(projectId: string): Promise<void> {
    await loadChildren(projectId, scopes.image, true)
    triggerRef(currentProject)
  }

  async function loadFiles(projectId: string): Promise<void> {
    await loadChildren(projectId, scopes.file, true)
    triggerRef(currentProject)
  }

  async function draftTask(projectId: string): Promise<Task> {
    await ensureSaiSession()
    const iri = await session.iriForChild(projectId, scopes.task)
    const ldoSolidTask = solidLdoDataset.usingType(TaskShapeType).fromSubject(iri)
    return ldoSolidTask
  }

  async function updateTask(task: Task) {
    await ensureSaiSession()
    if (!task['@id']) {
      throw new Error('task has no @id yet')
    }
    const projectId = session.findParent(task['@id'])
    const ldoProject = findProject(projectId)
    const isDraft = ![...ldoProject.hasTask!].some(
      (t: { '@id': string }) => t['@id'] === task['@id']
    )
    if (isDraft) {
      // add reference to new task
      const cProject = changeData(ldoProject)
      cProject.hasTask!.add({ '@id': task['@id'] })
      const result = await commitData(cProject)
      if (result.isError) {
        throw result
      }
    }
    const result = await commitData(task)
    if (result.isError) {
      throw result
    }
    triggerRef(currentProject)
  }

  async function deleteTask(task: Task) {
    await ensureSaiSession()
    if (!task['@id']) {
      throw new Error('task has no @id yet')
    }

    // @ldo-solid
    const ldoResource = solidLdoDataset.getResource(task['@id'])
    if (!('delete' in ldoResource)) {
      throw new Error(`cannot delete ${task['@id']}`)
    }
    const deleteResult = await ldoResource.delete()
    if (deleteResult.isError) {
      throw deleteResult
    }

    const projectId = session.findParent(task['@id'])
    const ldoProject = findProject(projectId)
    // remove reference from the project
    const cProject = changeData(ldoProject)
    cProject.hasTask!.delete(task as { '@id': string })
    const result = await commitData(cProject)
    if (result.isError) {
      throw result
    }
    triggerRef(currentProject)
  }

  async function upload(projectId: string, blob: File, scope: string) {
    await ensureSaiSession()
    const ldoProject = findProject(projectId)

    const fileId = await session.iriForChild(projectId, scope)

    // add reference from project to new file
    const cProject = changeData(ldoProject)
    // @ts-expect-error LDO subjects are indexed by scope-specific property names
    cProject[propForScope[scope]].add({ '@id': fileId })
    const projectResult = await commitData(cProject)
    if (projectResult.isError) {
      throw projectResult
    }

    // upload file
    const { ok } = await session.fetch(fileId, {
      method: 'PUT',
      headers: { 'Content-Type': blob.type },
      body: blob,
    })

    if (!ok) {
      throw new Error('failed to upload file')
    }

    // update description resource
    // must be done after the file was uploaded!
    const descriptionIri = await session.discoverDescription(fileId)
    if (!descriptionIri) {
      throw new Error(`no description resource for ${fileId}`)
    }
    const newFile = solidLdoDataset.usingType(FileShapeType).fromSubject(fileId)

    const resource = solidLdoDataset.getResource(descriptionIri)
    const cFile = ldoChangeData(newFile, resource)
    cFile.fileName = blob.name
    // CSS responds with 409 since it already stores it in metadata
    //cFile.format = blob.type

    const fileResult = await commitData(cFile)
    if (fileResult.isError) {
      throw fileResult
    }
    triggerRef(currentProject)
  }

  async function uploadFile(e: Event): Promise<void> {
    const target = e.target as HTMLInputElement
    const blob = target.files?.item(0)
    if (blob && currentProject.value) {
      void upload(currentProject.value['@id']!, blob, scopes.file)
    }
  }

  async function uploadImage(e: Event): Promise<void> {
    const target = e.target as HTMLInputElement
    const blob = target.files?.item(0)
    if (blob && currentProject.value) {
      void upload(currentProject.value['@id']!, blob, scopes.image)
    }
  }

  function getFileObject(id: string): FileObject {
    return solidLdoDataset.usingType(FileShapeType).fromSubject(id)
  }

  function setCurrentAgent(agentId: string) {
    currentAgent.value = agents.value.find((a) => a.id === agentId)
  }

  function setCurrentProject(resourceServer: string, projectId: string) {
    currentProject.value = projects.value.find((p) => p['@id'] === projectId)
  }

  async function canUpdate(id: string): Promise<boolean> {
    return session.canUpdate(id)
  }

  async function canDelete(id: string): Promise<boolean> {
    return session.canDelete(id)
  }

  async function canAddTasks(id: string): Promise<boolean> {
    return session.canCreateChild(id, scopes.task)
  }

  async function canAddImages(id: string): Promise<boolean> {
    return session.canCreateChild(id, scopes.image)
  }

  async function canAddFiles(id: string): Promise<boolean> {
    return session.canCreateChild(id, scopes.file)
  }

  async function checkAuthoriztion(): Promise<boolean> {
    await ensureSaiSession()
    const granted = !!session.applicationRegistration?.granted
    if (granted) {
      clearAwaitingAuthorization()
    }
    return granted
  }

  /**
   * The authorization flow ends on the app's own callback endpoint — BEFORE the
   * grant generation and the application-registration projection (Temporal
   * workflows) have created and linked them. This marker (and the pull below)
   * bridges that window, so a just-authorized agent is not asked to request the
   * authorization again.
   *
   * `request` — the agent went through the app's own authorization request: the
   * registration and its grants are guaranteed to arrive, so its return waits
   * for them.
   * `login` — the browser came back from the OIDC redirect. A login does NOT
   * have to carry a grant (a first-time user has not authorized the app yet),
   * so this one is only followed in the background: the request screen stays
   * usable and the app jumps in if the grant does show up (unified authN/authZ
   * deployments record it during the login interaction).
   */
  interface PendingAuthorization {
    kind: 'request' | 'login'
    since: number
  }
  const AWAITING_AUTHORIZATION_KEY = 'awaitingAuthorization'
  /** How long the app keeps pulling for the grants after the redirect. */
  const AUTHORIZATION_PULL_TIMEOUT = 45_000
  /** How long a `login` return watches for a registration link to appear. */
  const REGISTRATION_GRACE = 12_000
  const AUTHORIZATION_PULL_INTERVAL = 1000

  function pendingAuthorization(): PendingAuthorization | undefined {
    const raw = window.localStorage.getItem(AWAITING_AUTHORIZATION_KEY)
    if (!raw) {
      return undefined
    }
    try {
      const pending = JSON.parse(raw) as Partial<PendingAuthorization>
      if ((pending.kind === 'request' || pending.kind === 'login') && pending.since) {
        return { kind: pending.kind, since: pending.since }
      }
    } catch {
      // a marker from an older version of the app — ignore it
    }
    return undefined
  }

  const awaitingAuthorization = ref(pendingAuthorization() !== undefined)

  /** The kind of the recorded return, if any — `undefined` when nothing is pending. */
  function pendingAuthorizationKind(): PendingAuthorization['kind'] | undefined {
    return pendingAuthorization()?.kind
  }

  function clearAwaitingAuthorization(): void {
    window.localStorage.removeItem(AWAITING_AUTHORIZATION_KEY)
    awaitingAuthorization.value = false
  }

  /**
   * Remember that the browser is about to leave for — or has just returned
   * from — the authorization flow, so the login screen pulls for the
   * registration instead of offering to request the authorization again.
   * Called before leaving (`authorize`) and after the OIDC redirect (the
   * unified authN/authZ interaction may record the authorization on the way in).
   */
  function awaitAuthorization(kind: PendingAuthorization['kind']): void {
    const pending: PendingAuthorization = { kind, since: Date.now() }
    window.localStorage.setItem(AWAITING_AUTHORIZATION_KEY, JSON.stringify(pending))
    awaitingAuthorization.value = true
  }

  /**
   * Pull for updates: re-discover the application registration and reload it
   * until the grants are projected, so the app can start reading the data the
   * agent just authorized. Returns whether the registration is granted; a
   * timeout falls back to the un-authorized screen (and drops the marker).
   *
   * A `login` return gets the registration grace only, a `request` return waits
   * the whole window; and any pull stops once a NEWER flow records its own
   * marker (the caller navigated on, e.g. to request the authorization).
   */
  async function pullAuthorization(): Promise<boolean> {
    await ensureSaiSession()
    const started = pendingAuthorization()
    const requested = started?.kind === 'request'
    const registrationDeadline = requested ? undefined : Date.now() + REGISTRATION_GRACE
    const grantedDeadline = Date.now() + AUTHORIZATION_PULL_TIMEOUT
    for (;;) {
      if (pendingAuthorization()?.since !== started?.since) {
        // superseded (or cleared) — stop without touching the newer marker
        return false
      }
      try {
        await session.refreshRegistration()
      } catch (error) {
        // the registration can be minted BEFORE its grants (and so before the
        // app may read it) — a failed read is transient here, keep polling
        console.debug('refreshRegistration', error)
      }
      if (session.applicationRegistration?.granted) {
        clearAwaitingAuthorization()
        // the registration link only appeared now: start following it, so the
        // app keeps receiving the same live updates as a seeded session
        try {
          await subscribeToRegistration()
        } catch (error) {
          console.debug('subscribeToRegistration', error)
        }
        return true
      }
      const now = Date.now()
      const registrationLapsed =
        !session.registrationIri &&
        registrationDeadline !== undefined &&
        now >= registrationDeadline
      if (now >= grantedDeadline || registrationLapsed) {
        clearAwaitingAuthorization()
        return false
      }
      await new Promise((resolve) => {
        setTimeout(resolve, AUTHORIZATION_PULL_INTERVAL)
      })
    }
  }

  async function getAuthorizationRedirectUri(): Promise<string> {
    await ensureSaiSession()
    return session.authorizationRedirectUri
  }

  async function authorize() {
    if (!coreStore.userId) {
      throw new Error('no user id')
    }
    const redirectUri = await getAuthorizationRedirectUri()
    awaitAuthorization('request')
    window.location.href = redirectUri
  }

  async function share(resourceId: string) {
    await ensureSaiSession()
    const shareUri = session.getShareUri(resourceId)
    if (!shareUri) {
      throw new Error('shareUri is undefined')
    }
    window.localStorage.setItem(
      'restorePath',
      `${window.location.pathname}${window.location.search}`
    )
    window.location.href = shareUri
  }

  async function shareProject(projectId: string) {
    void share(projectId)
  }

  async function dataUrl(url: string): Promise<string> {
    return sessionFetch()(url)
      .then((response) => response.blob())
      .then((blb) => URL.createObjectURL(blb))
  }

  async function handleRegistrationChange(): Promise<void> {
    await session.buildRegistration()
    void loadAgents(true)
  }

  async function handleResourceChange(resourceId: string): Promise<void> {
    const project = projects.value.find((p) => p['@id'] === resourceId)
    if (project) {
      void reloadProject(resourceId)
    } else {
      void reloadTask(resourceId)
    }
  }

  async function getPushSubscription() {
    if (pushSubscription.value) {
      return
    }
    const resourceServer = await navigator.serviceWorker.ready
    const subscription = await resourceServer.pushManager.getSubscription()
    if (subscription) {
      pushSubscription.value = subscription
    }
  }

  async function enableNotifications() {
    await ensureSaiSession()
    if (!notificationsManager.webPushService) {
      return null
    }
    const result = await Notification.requestPermission()
    if (result === 'granted') {
      const resourceServer = await navigator.serviceWorker.ready
      let subscription = await resourceServer.pushManager.getSubscription()
      if (!subscription) {
        subscription = await resourceServer.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: notificationsManager.webPushService?.vapidPublicKey,
        })
      }
      pushSubscription.value = subscription
    }
    return result
  }

  async function subscribeViaPush(id: string): Promise<void> {
    await ensureSaiSession()
    await getPushSubscription()
    const channel = await notificationsManager.subscribeViaPush(pushSubscription.value!, id)
    const project = projects.value.find((p) => p['@id'] === id)
    // also all the tasks
    const taskChannels = await Promise.all(
      // @ts-expect-error `hasTask` is optional in the shape-tree types
      project.hasTask.map((task) =>
        notificationsManager.subscribeViaPush(pushSubscription.value!, task['@id'])
      )
    )
    subscriptions.value.set(id, channel.id)
    for (const taskChannel of taskChannels) {
      subscriptions.value.set(taskChannel.topic as string, taskChannel.id)
    }
  }

  async function unsubscribeViaPush(id: string): Promise<void> {
    await ensureSaiSession()
    const channelId = subscriptions.value.get(id)
    if (!channelId) {
      throw new Error('channel not found')
    }
    const response = await session.fetch(channelId, { method: 'DELETE' })
    if (!response.ok) {
      throw new Error('failed to unsubscribe')
    }
    const project = projects.value.find((p) => p['@id'] === id)
    const result = (await Promise.all(
      // @ts-expect-error `hasTask` is optional in the shape-tree types
      project?.hasTask.map((task) => {
        const cId = subscriptions.value.get(task['@id'])
        if (!cId) {
          return false
        }
        return notificationsManager.unsubscribeFromPush(task['@id'], cId)
      })
    )) as Array<boolean>
    if (result.includes(false)) {
      throw new Error('failed to unsubscribe some of the tasks')
    }
    subscriptions.value.delete(id)
    // @ts-expect-error `hasTask` is optional in the shape-tree types
    project?.hasTask.forEach((task) => subscriptions.value.delete(task['@id']))
  }

  return {
    pushSubscription,
    subscriptions,
    getPushSubscription,
    enableNotifications,
    subscribeViaPush,
    unsubscribeViaPush,
    agents,
    currentAgent,
    currentProject,
    resourceServers,
    setCurrentAgent,
    setCurrentProject,
    shareProject,
    loadAgents,
    projectsFor,
    loadProjects,
    loadTasks,
    updateTask,
    deleteTask,
    loadFiles,
    uploadFile,
    uploadImage,
    loadImages,
    changeData,
    authorize,
    awaitingAuthorization,
    awaitAuthorization,
    pendingAuthorizationKind,
    pullAuthorization,
    saiError,
    getAuthorizationRedirectUri,
    checkAuthoriztion,
    share,
    dataUrl,
    canUpdate,
    canDelete,
    canAddTasks,
    canAddImages,
    canAddFiles,
    draftTask,
    getFileObject,
  }
})
