import { existsSync, unlinkSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'
import { URL, fileURLToPath } from 'node:url'

// Plugins
import vue from '@vitejs/plugin-vue'
// Utilities
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'
import vuetify, { transformAssetUrls } from 'vite-plugin-vuetify'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    vue({
      template: { transformAssetUrls },
    }),
    // https://github.com/vuetifyjs/vuetify-loader/tree/next/packages/vite-plugin
    vuetify({
      autoImport: true,
      styles: {
        configFile: 'src/styles/settings.scss',
      },
    }),
    // https://vite-pwa-org.netlify.app/
    VitePWA({
      registerType: 'autoUpdate',
      strategies: 'injectManifest',
      injectManifest: {
        injectionPoint: undefined,
      },
      srcDir: 'src',
      filename: 'sw.js',
      devOptions: {
        enabled: true,
      },
    }),
    {
      name: 'exclude-config',
      apply: 'build',
      closeBundle() {
        const configPath = resolve(__dirname, 'dist/config.json')
        if (existsSync(configPath)) {
          unlinkSync(configPath)
          console.log('✓ Removed config.json from dist')
        }
        const idPath = resolve(__dirname, 'dist/id.jsonld')
        if (existsSync(idPath)) {
          unlinkSync(idPath)
          console.log('✓ Removed id.jsonld from dist')
        }
      },
    },
    {
      name: 'clean-urls',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url && !extname(req.url)) {
            const extensions = ['.jsonld', '.ttl']
            for (const ext of extensions) {
              const filePath = join(__dirname, 'public', req.url + ext)
              if (existsSync(filePath)) {
                req.url += ext
                break
              }
            }
          }
          next()
        })
      },
    },
  ],
  define: { 'process.env': {} },
  resolve: {
    // The workspace and npm copies of the LWS packages must share one
    // `@opentelemetry/api` instance, otherwise the web provider registered here
    // is invisible to `withSpan`/`context.with` in `packages/lws-auth`.
    dedupe: ['@opentelemetry/api'],
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
    extensions: ['.js', '.json', '.jsx', '.mjs', '.ts', '.tsx', '.vue'],
  },
  server: {
    port: 4500,
    host: '0.0.0.0',
    allowedHosts: ['vuejectron.docker'],
    fs: {
      strict: false,
    },
  },
})
