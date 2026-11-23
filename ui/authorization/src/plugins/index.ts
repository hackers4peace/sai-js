/**
 * plugins/index.ts
 *
 * Automatically included in `./src/main.ts`
 */

// Types
import type { App } from 'vue'

import router from '../router'
import pinia from '../store'
import { fluent } from './fluent'
import vuetify from './vuetify'
// Plugins
import { loadFonts } from './webfontloader'

export function registerPlugins(app: App) {
  void loadFonts()
  app.use(vuetify).use(fluent).use(router).use(pinia)
}
