import { getRuntimeConfig } from '@/runtime-config'
import {
  type ISessionInfo,
  getDefaultSession,
  handleIncomingRedirect,
  login as oidcLogin,
} from '@inrupt/solid-client-authn-browser'
import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { RouteLocationNormalized } from 'vue-router'

class OidcError extends Error {
  constructor(private oidcInfo?: ISessionInfo) {
    super('oidcInfo')
  }
}

export const useCoreStore = defineStore('core', () => {
  const config = getRuntimeConfig()
  const userId = ref<string | null>(null)

  async function login(oidcIssuer: string) {
    const options = {
      clientId: config.clientId,
      oidcIssuer,
      redirectUrl: `${config.baseUrl}/redirect`,
    }
    await oidcLogin(options)
  }

  async function handleRedirect(url: string) {
    const oidcInfo = await handleIncomingRedirect(url)
    if (!oidcInfo?.webId) {
      throw new OidcError(oidcInfo)
    }
    userId.value = oidcInfo.webId
  }

  async function restoreOidcSession(to: RouteLocationNormalized): Promise<void> {
    const oidcSession = getDefaultSession()

    if (!oidcSession.info.isLoggedIn) {
      const restoreUrl = localStorage.getItem('restorePath')
      if (to.name !== 'login' && !restoreUrl) {
        localStorage.setItem('restorePath', to.fullPath)
      }
      const oidcInfo = await oidcSession.handleIncomingRedirect({ restorePreviousSession: true })
      if (oidcInfo?.webId) {
        userId.value = oidcInfo.webId
      }
    }
  }

  return {
    userId,
    login,
    handleRedirect,
    restoreOidcSession,
  }
})
