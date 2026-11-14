/**
 * main.ts
 *
 * Bootstraps Vuetify and other plugins then mounts the App`
 */

import { createApp } from 'vue'

// Plugins
import { registerPlugins } from '@/plugins'

import App from './App.vue'
import { getRuntimeConfig, loadRuntimeConfig } from './runtime-config'

// Load runtime config before mounting the app
// This ensures config is available to all components from the start
loadRuntimeConfig()
  .then(async () => {
    // Before any store/mount: the LWS client spans and fetch propagation need
    // the provider registered before their first request. The import is dynamic
    // so a deployment with tracing disabled never loads the OTel SDK at all.
    if (getRuntimeConfig().tracing?.enabled) {
      const { initTracing } = await import('./tracing')
      initTracing(getRuntimeConfig())
    }
    const app = createApp(App)
    registerPlugins(app)
    // Config loaded successfully, now it's safe to mount the app
    // All components can now use getRuntimeConfig() in their setup/created hooks
    app.mount('#app')
  })
  .catch((error) => {
    // Handle config loading failure gracefully
    // Log the error for debugging purposes
    console.error('Failed to initialize app:', error)

    // Show an error message to the user
    // The non-null assertion is safe because #app exists in index.html
    document.getElementById('app')!.innerHTML = `
      <div style="padding: 20px; text-align: center;">
        <h1>Configuration Error</h1>
        <p>Failed to load configuration. Please refresh the page.</p>
      </div>
    `
  })
