/**
 * main.ts
 *
 * Bootstraps Vuetify and other plugins then mounts the App`
 */

import { createApp } from 'vue'
import App from './App.vue'
import { loadRuntimeConfig } from './runtime-config'

// Plugins
import { registerPlugins } from '@/plugins'

// Load runtime config before mounting the app
// This ensures config is available to all components from the start
loadRuntimeConfig()
  .then(() => {
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
