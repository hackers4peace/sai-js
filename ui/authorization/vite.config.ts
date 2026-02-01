// Plugins
import fs from 'node:fs'
import vue from '@vitejs/plugin-vue'
import { ExternalFluentPlugin, SFCFluentPlugin } from 'unplugin-fluent-vue/vite'
import { VitePWA } from 'vite-plugin-pwa'
import vuetify, { transformAssetUrls } from 'vite-plugin-vuetify'

import path from 'node:path'
import { URL, fileURLToPath } from 'node:url'
// Utilities
import { defineConfig } from 'vite'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    vue({
      template: { transformAssetUrls },
    }),
    // https://github.com/vuetifyjs/vuetify-loader/tree/next/packages/vite-plugin
    vuetify({
      autoImport: true,
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
      manifest: {
        name: 'SAI Authorization',
        short_name: 'SAI',
        start_url: '/',
        display: 'standalone',
        icons: [
          {
            src: 'solid.png',
            sizes: '192x192',
            type: 'image/png',
          },
          {
            src: 'solid.png',
            sizes: '512x512',
            type: 'image/png',
          },
        ],
        share_target: {
          action: '/invitation',
          method: 'GET',
          params: {
            title: 'title',
            text: 'text',
            url: 'url',
          },
        },
      },
    }),
    SFCFluentPlugin({
      blockType: 'fluent', // default 'fluent' - name of the block in SFCs
      checkSyntax: true, // default true - whether to check syntax of the messages
    }),
    // define messages in external ftl files
    ExternalFluentPlugin({
      locales: ['en', 'pl'], // required - list of locales
      checkSyntax: true, // default true - whether to check syntax of the messages
      baseDir: path.resolve('src'), // base directory for Vue files
      ftlDir: path.resolve('src/locales'), // directory with ftl files
    }),
    {
      name: 'exclude-config',
      apply: 'build',
      closeBundle() {
        const configPath = path.resolve(__dirname, 'dist/config.json')
        if (fs.existsSync(configPath)) {
          fs.unlinkSync(configPath)
          console.log('✓ Removed config.json from dist')
        }
      },
    },
  ],
  define: { 'process.env': {} },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
    extensions: ['.js', '.json', '.jsx', '.mjs', '.ts', '.tsx', '.vue'],
  },
  server: {
    port: 4200,
    host: '0.0.0.0',
    allowedHosts: ['ui.auth.docker'],
  },
})
