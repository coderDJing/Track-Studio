import { resolve } from 'path'
import { readFile } from 'node:fs/promises'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'

const inlineWasmPlugin = () => ({
  name: 'frkb-inline-wasm',
  enforce: 'pre' as const,
  async load(id: string) {
    const [filePath, query = ''] = id.split('?')
    if (!filePath.endsWith('.wasm') || !query.split('&').includes('inline')) return null
    const bytes = await readFile(filePath)
    const dataUrl = `data:application/wasm;base64,${bytes.toString('base64')}`
    return `export default ${JSON.stringify(dataUrl)}`
  }
})

const rendererDevPort = Number.parseInt(process.env.FRKB_DEV_SERVER_PORT || '', 10)
const rendererServer =
  Number.isInteger(rendererDevPort) && rendererDevPort > 0 && rendererDevPort <= 65535
    ? {
        port: rendererDevPort,
        strictPort: true
      }
    : undefined
const defaultLastFmApiKey = process.env.FRKB_LASTFM_API_KEY || process.env.LASTFM_API_KEY || ''

export default defineConfig({
  main: {
    resolve: {
      alias: {
        '@shared': resolve('src/shared')
      }
    },
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          audioDecodeWorker: resolve(__dirname, 'src/main/workers/audioDecodeWorker.ts'),
          keyAnalysisWorker: resolve(__dirname, 'src/main/workers/keyAnalysisWorker.ts'),
          audioTimeBasisOffsetWorker: resolve(
            __dirname,
            'src/main/workers/audioTimeBasisOffsetWorker.ts'
          ),
          songListScanWorker: resolve(__dirname, 'src/main/workers/songListScanWorker.ts'),
          coverExtractionWorker: resolve(__dirname, 'src/main/workers/coverExtractionWorker.ts'),
          recycleBinDeleteWorker: resolve(__dirname, 'src/main/workers/recycleBinDeleteWorker.ts'),
          songListTrackCountWorker: resolve(
            __dirname,
            'src/main/workers/songListTrackCountWorker.ts'
          ),
          pioneerDeviceLibraryWorker: resolve(
            __dirname,
            'src/main/workers/pioneerDeviceLibraryWorker.ts'
          ),
          mixtapeRawWaveformWorker: resolve(
            __dirname,
            'src/main/workers/mixtapeRawWaveformWorker.ts'
          ),
          libraryMergeInspectWorker: resolve(
            __dirname,
            'src/main/workers/libraryMergeInspectWorker.ts'
          )
        },
        output: {
          format: 'cjs',
          entryFileNames: (chunk) => {
            if (chunk.name === 'audioDecodeWorker') {
              return 'workers/audioDecodeWorker.js'
            }
            if (chunk.name === 'keyAnalysisWorker') {
              return 'workers/keyAnalysisWorker.js'
            }
            if (chunk.name === 'audioTimeBasisOffsetWorker') {
              return 'workers/audioTimeBasisOffsetWorker.js'
            }
            if (chunk.name === 'songListScanWorker') {
              return 'workers/songListScanWorker.js'
            }
            if (chunk.name === 'coverExtractionWorker') {
              return 'workers/coverExtractionWorker.js'
            }
            if (chunk.name === 'recycleBinDeleteWorker') {
              return 'workers/recycleBinDeleteWorker.js'
            }
            if (chunk.name === 'songListTrackCountWorker') {
              return 'workers/songListTrackCountWorker.js'
            }
            if (chunk.name === 'pioneerDeviceLibraryWorker') {
              return 'workers/pioneerDeviceLibraryWorker.js'
            }
            if (chunk.name === 'mixtapeRawWaveformWorker') {
              return 'workers/mixtapeRawWaveformWorker.js'
            }
            if (chunk.name === 'libraryMergeInspectWorker') {
              return 'workers/libraryMergeInspectWorker.js'
            }
            return '[name].js'
          }
        }
      }
    },
    define: {
      'process.env.CLOUD_SYNC_BASE_URL_DEV': JSON.stringify(
        process.env.CLOUD_SYNC_BASE_URL_DEV || ''
      ),
      'process.env.CLOUD_SYNC_BASE_URL_PROD': JSON.stringify(
        process.env.CLOUD_SYNC_BASE_URL_PROD || ''
      ),
      'process.env.CLOUD_SYNC_DISCOVERY_URL': JSON.stringify(
        process.env.CLOUD_SYNC_DISCOVERY_URL ||
          'https://raw.githubusercontent.com/coderDJing/Track-Studio/main/server.json'
      ),
      'process.env.CLOUD_SYNC_API_SECRET_KEY': JSON.stringify(
        process.env.CLOUD_SYNC_API_SECRET_KEY || ''
      ),
      'process.env.FRKB_LASTFM_API_KEY': JSON.stringify(defaultLastFmApiKey)
    }
  },
  preload: {
    resolve: {
      alias: {
        '@shared': resolve('src/shared')
      }
    },
    plugins: [externalizeDepsPlugin()],
    define: {
      'process.env.CLOUD_SYNC_BASE_URL_DEV': JSON.stringify(
        process.env.CLOUD_SYNC_BASE_URL_DEV || ''
      ),
      'process.env.CLOUD_SYNC_BASE_URL_PROD': JSON.stringify(
        process.env.CLOUD_SYNC_BASE_URL_PROD || ''
      ),
      'process.env.CLOUD_SYNC_DISCOVERY_URL': JSON.stringify(
        process.env.CLOUD_SYNC_DISCOVERY_URL ||
          'https://raw.githubusercontent.com/coderDJing/Track-Studio/main/server.json'
      ),
      'process.env.CLOUD_SYNC_API_SECRET_KEY': JSON.stringify(
        process.env.CLOUD_SYNC_API_SECRET_KEY || ''
      )
    }
  },
  renderer: {
    server: rendererServer,
    css: {
      preprocessorOptions: {
        scss: {}
      }
    },
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@shared': resolve('src/shared')
      }
    },
    plugins: [inlineWasmPlugin(), vue()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/', 'index.html'),
          databaseInit: resolve(__dirname, 'src/renderer/', 'databaseInit.html'),
          update: resolve(__dirname, 'src/renderer/', 'update.html'),
          foundNewVersion: resolve(__dirname, 'src/renderer/', 'foundNewVersion.html'),
          whatsNew: resolve(__dirname, 'src/renderer/', 'whatsNew.html'),
          startup: resolve(__dirname, 'src/renderer/', 'startup.html'),
          mixtape: resolve(__dirname, 'src/renderer/', 'mixtape.html'),
          libraryRelocate: resolve(__dirname, 'src/renderer/', 'libraryRelocate.html'),
          miniPlayer: resolve(__dirname, 'src/renderer/', 'miniPlayer.html'),
          miniPlayerCover: resolve(__dirname, 'src/renderer/', 'miniPlayerCover.html'),
          miniPlayerOverlay: resolve(__dirname, 'src/renderer/', 'miniPlayerOverlay.html'),
          miniPlayerTooltip: resolve(__dirname, 'src/renderer/', 'miniPlayerTooltip.html')
        }
      }
    }
  }
})
