import { FluentBundle } from '@fluent/bundle'
import { createFluentVue } from 'fluent-vue'

// @ts-expect-error Vite loads .ftl locale files as strings
import enMessages from '../locales/en.ftl'

// Create bundles for locales that will be used
const enBundle = new FluentBundle('en')
enBundle.addResource(enMessages)

// Create plugin istance
// bundles - The current negotiated fallback chain of languages
export const fluent = createFluentVue({
  bundles: [enBundle],
})
