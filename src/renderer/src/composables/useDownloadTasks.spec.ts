// Run: pnpm exec vitest run src/renderer/src/composables/useDownloadTasks.spec.ts
import { describe, expect, it } from 'vitest'
import { EMPTY_APP_UPDATE_STATE, type AppUpdateState } from '@shared/appUpdate'
import type { OptionalComponentDownloadState } from '@shared/optionalComponentDownloads'
import {
  composeDownloadTasks,
  type ModelDownloadState,
  type RuntimeDownloadStateLike
} from './useDownloadTasks'

const idleRuntime: RuntimeDownloadStateLike = {
  status: 'ready',
  percent: 0,
  downloadedBytes: 0,
  totalBytes: 0,
  archiveSize: 0,
  title: ''
}

const idleModel: ModelDownloadState = {
  status: 'idle',
  percent: 0,
  downloadedBytes: 0,
  totalBytes: 0,
  archiveSize: 0,
  error: '',
  startedInSession: false
}

const compose = (params: {
  appUpdate?: Partial<AppUpdateState>
  runtimeState?: RuntimeDownloadStateLike
  model?: Partial<ModelDownloadState>
  componentStates?: OptionalComponentDownloadState[]
  dismissed?: string[]
}) =>
  composeDownloadTasks({
    appUpdate: { ...EMPTY_APP_UPDATE_STATE, ...params.appUpdate },
    runtimeState: params.runtimeState || idleRuntime,
    model: { ...idleModel, ...params.model },
    components: params.componentStates || [],
    dismissed: new Set(params.dismissed || [])
  })

const buildComponent = (
  overrides: Partial<OptionalComponentDownloadState>
): OptionalComponentDownloadState => ({
  id: 'rekordbox-desktop-runtime',
  status: 'downloading',
  percent: 0,
  downloadedBytes: 0,
  totalBytes: 0,
  error: '',
  updatedAt: 0,
  ...overrides
})

describe('下载任务卡片聚合', () => {
  it('空闲状态不产生任何行', () => {
    expect(compose({})).toEqual([])
  })

  it('发现新版本时给出下载、更新说明与稍后三个操作', () => {
    const [task] = compose({ appUpdate: { status: 'available', version: '1.2.9' } })
    expect(task.kind).toBe('update')
    expect(task.status).toBe('available')
    expect(task.actions.map((action) => action.id)).toEqual([
      'download-update',
      'release-notes',
      'dismiss'
    ])
  })

  it('手动检查更新时给出检查中反馈', () => {
    const [task] = compose({ appUpdate: { status: 'checking' } })
    expect(task.status).toBe('checking')
    expect(task.actions).toEqual([])
    expect(task.percent).toBeNull()
  })

  it('启动静默检查不打扰：检查中与已最新都不出行', () => {
    expect(compose({ appUpdate: { status: 'checking', silent: true } })).toEqual([])
    expect(compose({ appUpdate: { status: 'latest', version: '1.2.8', silent: true } })).toEqual([])
  })

  it('手动检查确认已最新时给出可关闭的提示', () => {
    const [task] = compose({ appUpdate: { status: 'latest', version: '1.2.8' } })
    expect(task.status).toBe('latest')
    expect(task.actions.map((action) => action.id)).toEqual(['dismiss'])
  })

  it('更新说明还在读取时禁用该按钮', () => {
    const [task] = compose({
      appUpdate: { status: 'available', version: '1.2.9', releaseNotesLoading: true }
    })
    const action = task.actions.find((item) => item.id === 'release-notes')
    expect(action?.disabled).toBe(true)
  })

  it('用户选择稍后时不展示该行', () => {
    const tasks = compose({
      appUpdate: { status: 'available', version: '1.2.9' },
      dismissed: ['update']
    })
    expect(tasks).toEqual([])
  })

  it('下载完成后主操作是重启安装', () => {
    const [task] = compose({ appUpdate: { status: 'downloaded', version: '1.2.9', percent: 100 } })
    expect(task.status).toBe('downloaded')
    expect(task.percent).toBe(100)
    expect(task.actions[0]).toMatchObject({ id: 'install-update', primary: true })
  })

  it('下载失败时提供重试与手动下载', () => {
    const [task] = compose({ appUpdate: { status: 'error', error: 'network unreachable' } })
    expect(task.status).toBe('failed')
    expect(task.error).toBe('network unreachable')
    expect(task.actions.map((action) => action.id)).toEqual(['retry', 'manual-download', 'dismiss'])
  })

  it('分析运行时下载中带百分比与字节进度', () => {
    const [task] = compose({
      runtimeState: {
        ...idleRuntime,
        status: 'downloading',
        percent: 42,
        downloadedBytes: 1024 * 1024,
        totalBytes: 4 * 1024 * 1024
      }
    })
    expect(task.kind).toBe('runtime')
    expect(task.percent).toBe(42)
    expect(task.detail).toContain(' / ')
    expect(task.actions).toEqual([])
  })

  it('运行中解压阶段不展示虚假百分比', () => {
    const [task] = compose({ runtimeState: { ...idleRuntime, status: 'extracting' } })
    expect(task.status).toBe('installing')
    expect(task.percent).toBeNull()
  })

  it('模型下载失败只在本次会话内提示', () => {
    expect(compose({ model: { status: 'failed', error: 'x' } })).toEqual([])
    const [task] = compose({ model: { status: 'failed', error: 'x', startedInSession: true } })
    expect(task.kind).toBe('model')
    expect(task.actions.map((action) => action.id)).toEqual(['retry', 'dismiss'])
  })

  it('组件失败行提供重试，进行中行只显示百分比', () => {
    const [failed] = compose({
      componentStates: [buildComponent({ status: 'failed', error: 'disk full' })]
    })
    expect(failed.error).toBe('disk full')
    expect(failed.actions.map((action) => action.id)).toEqual(['retry'])

    const [running] = compose({ componentStates: [buildComponent({ percent: 12.34 })] })
    expect(running.percent).toBe(12.3)
    expect(running.actions).toEqual([])
  })

  it('多来源并存时按 更新 -> 运行时 -> 模型 -> 组件 的顺序排列', () => {
    const tasks = compose({
      appUpdate: { status: 'available', version: '1.2.9' },
      runtimeState: { ...idleRuntime, status: 'downloading', percent: 5 },
      model: { status: 'downloading', percent: 7 },
      componentStates: [buildComponent({ percent: 9 })]
    })
    expect(tasks.map((task) => task.kind)).toEqual(['update', 'runtime', 'model', 'component'])
  })
})
