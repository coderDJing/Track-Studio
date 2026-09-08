import { app } from 'electron'

const RC_VERSION_PATTERN = /-rc(?:\.|$)/i

export const isRcVersion = (version: string): boolean => RC_VERSION_PATTERN.test(version.trim())

export const shouldEnableRcDiagnostics = (packaged: boolean, version: string): boolean =>
  packaged && isRcVersion(version)

/** 性能诊断只在打包后的 RC 中启用，避免开发环境和正式版持续采样或落盘。 */
export const isPackagedRcBuild = (): boolean =>
  shouldEnableRcDiagnostics(app.isPackaged, app.getVersion())
