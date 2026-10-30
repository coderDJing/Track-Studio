import { resolve } from 'node:path'
import { configDefaults, defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'node',
          exclude: [
            ...configDefaults.exclude,
            '**/rust_package/**',
            '**/CoverThumbnailImage.spec.ts',
            '**/CuratedLibrarySyncSettings.spec.ts',
            '**/trackReanalysisDialog.spec.ts',
            '**/setPackageImportDialog.spec.ts',
            '**/rightClickMenu.spec.ts'
          ]
        }
      },
      {
        extends: true,
        test: {
          name: 'vue-client',
          include: [
            '**/CoverThumbnailImage.spec.ts',
            '**/CuratedLibrarySyncSettings.spec.ts',
            '**/trackReanalysisDialog.spec.ts',
            '**/setPackageImportDialog.spec.ts',
            '**/rightClickMenu.spec.ts'
          ],
          environment: './tests/vueClientEnvironment.ts'
        }
      }
    ]
  },
  resolve: {
    alias: {
      '@renderer': resolve(import.meta.dirname, 'src/renderer/src'),
      '@shared': resolve(import.meta.dirname, 'src/shared')
    }
  }
})
