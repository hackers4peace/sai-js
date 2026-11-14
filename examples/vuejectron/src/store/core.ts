import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { RouteLocationNormalized } from 'vue-router'

import { browserSession } from '@/session'

export const useCoreStore = defineStore('core', () => {
  const userId = ref<string | null>(null)

  async function login(issuer: string) {
    // Starts the authorization code flow (PKCE + DPoP, one client key pair)
    // and navigates to the provider; the provider returns to /redirect.
    const authorizationUrl = await browserSession().login(issuer)
    window.location.assign(authorizationUrl)
  }

  async function handleRedirect(url: string) {
    const info = await browserSession().handleRedirect(url)
    userId.value = info.webId
  }

  async function restoreOidcSession(to: RouteLocationNormalized): Promise<void> {
    const session = browserSession()

    if (!session.isLoggedIn) {
      const restoreUrl = localStorage.getItem('restorePath')
      if (to.name !== 'login' && !restoreUrl) {
        localStorage.setItem('restorePath', to.fullPath)
      }
      const info = await session.restore()
      if (info) {
        userId.value = info.webId
      }
    }
  }

  function logout() {
    userId.value = null
    return browserSession().logout()
  }

  return {
    userId,
    login,
    handleRedirect,
    restoreOidcSession,
    logout,
  }
})
