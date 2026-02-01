import * as effect from '@/effect'
import { fluent } from '@/plugins/fluent'
import { getRuntimeConfig } from '@/runtime-config'
import { FluentBundle } from '@fluent/bundle'
import { defineStore } from 'pinia'
import { ref, watch } from 'vue'
import type { PushSubscription } from 'web-push'

let endpoint: string

function defaultLang(availableLanguages: string[]): string {
  const lang = navigator.language.split('-')[0]
  return availableLanguages.includes(lang) ? lang : 'en'
}

export const useCoreStore = defineStore('core', () => {
  endpoint = `${getRuntimeConfig().backendBaseUrl}/.account/`
  const userId = ref<string | null>(null)
  const availableLanguages = ref<string[]>(getRuntimeConfig().languages)
  const lang = ref(localStorage.getItem('lang') ?? defaultLang(availableLanguages.value))
  const pushSubscription = ref<PushSubscription | null>(null)

  watch(
    lang,
    async (newLang) => {
      localStorage.setItem('lang', newLang)
      const newMessages = await import(`@/locales/${newLang}.ftl`)
      const newBundle = new FluentBundle(newLang)
      newBundle.addResource(newMessages.default)
      fluent.bundles = [newBundle]
    },
    { immediate: true }
  )

  function navigateHome() {
    window.location.href = import.meta.env.BASE_URL
  }

  async function signIn(email: string, password: string): Promise<boolean> {
    const controlsResponse = await fetch(endpoint)
    const { controls } = await controlsResponse.json()
    const loginResponse = await fetch(controls.password.login, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ email, password, remember: true }),
    })
    return loginResponse.ok
  }

  async function signUp(email: string, password: string): Promise<boolean> {
    let controlsResponse = await fetch(endpoint)
    let { controls } = await controlsResponse.json()
    await fetch(controls.account.create, {
      method: 'POST',
      credentials: 'include',
    })
    controlsResponse = await fetch(endpoint, { credentials: 'include' })
    controls = (await controlsResponse.json()).controls
    const passwordResponse = await fetch(controls.password.create, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ email, password }),
    })
    return passwordResponse.ok
  }

  async function signOut(): Promise<boolean> {
    const controlsResponse = await fetch(endpoint, { credentials: 'include' })
    const { controls } = await controlsResponse.json()
    const logoutResponse = await fetch(controls.account.logout, {
      method: 'POST',
      credentials: 'include',
    })
    return logoutResponse.ok
  }

  async function getClientInfo(): Promise<string> {
    const controlsResponse = await fetch(endpoint, { credentials: 'include' })
    const { controls } = await controlsResponse.json()
    const clientInfoResponse = await fetch(controls.oidc.consent, { credentials: 'include' })
    const info = await clientInfoResponse.json()
    return info.client.client_id
  }

  async function setWebId(): Promise<boolean> {
    const controlsResponse = await fetch(endpoint, { credentials: 'include' })
    const { controls } = await controlsResponse.json()
    const webIdResponse = await fetch(controls.oidc.webId, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ webId: userId.value }),
    })
    const data = await webIdResponse.json()
    // this is required to update the OIDC interaction
    const confirmResponse = await fetch(data.location, {
      credentials: 'include',
      redirect: 'manual',
    })
    return confirmResponse.ok
  }

  async function linkWebId(webId: string): Promise<boolean> {
    const controlsResponse = await fetch(endpoint, { credentials: 'include' })
    const { controls } = await controlsResponse.json()
    const loginResponse = await fetch(controls.account.webId, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ webId }),
    })
    return loginResponse.ok
  }

  async function getPushSubscription(): Promise<void> {
    const registration = await navigator.serviceWorker.ready
    const subscription = await registration.pushManager.getSubscription()
    if (subscription) {
      pushSubscription.value = subscription.toJSON() as PushSubscription
      effect.registerPushSubscription(pushSubscription.value)
    }
  }

  async function consent(): Promise<string> {
    const controlsResponse = await fetch(endpoint, { credentials: 'include' })
    const { controls } = await controlsResponse.json()
    const webIdResponse = await fetch(controls.oidc.consent, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ remember: true }),
    })
    const data = await webIdResponse.json()
    console.log(data)
    return data.location
  }

  async function enableNotifications() {
    const result = await Notification.requestPermission()
    if (result === 'granted') {
      const registration = await navigator.serviceWorker.ready
      let subscription = await registration.pushManager.getSubscription()
      if (!subscription) {
        subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: getRuntimeConfig().vapidPublicKey,
        })
      }
      pushSubscription.value = subscription.toJSON() as PushSubscription
      await effect.registerPushSubscription(pushSubscription.value)
    }
    return result
  }

  return {
    userId,
    lang,
    availableLanguages,
    pushSubscription,
    signIn,
    signUp,
    signOut,
    getClientInfo,
    setWebId,
    consent,
    linkWebId,
    navigateHome,
    enableNotifications,
    getPushSubscription,
  }
})
