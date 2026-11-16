import fs = require('fs-extra')
import path = require('path')

export type CoreLibraryName =
  | 'FilterLibrary'
  | 'CuratedLibrary'
  | 'SetLibrary'
  | 'MixtapeLibrary'
  | 'RecordingLibrary'
  | 'RecycleBin'
  | 'NeteaseLibrary'

const CORE_EN_TO_CN: Record<CoreLibraryName, string> = {
  FilterLibrary: '筛选库',
  CuratedLibrary: '精选库',
  SetLibrary: 'SET库',
  MixtapeLibrary: '混音库',
  RecordingLibrary: '录音库',
  RecycleBin: '回收站',
  NeteaseLibrary: '网易云音乐'
}

export const CORE_KEYS = Object.keys(CORE_EN_TO_CN) as CoreLibraryName[]

// 运行期：英文名 -> 实际物理目录名（优先英文，若重命名失败则回退中文）
const coreEnToFsName: Record<CoreLibraryName, string> = {
  FilterLibrary: 'FilterLibrary',
  CuratedLibrary: 'CuratedLibrary',
  SetLibrary: 'SetLibrary',
  MixtapeLibrary: 'MixtapeLibrary',
  RecordingLibrary: 'RecordingLibrary',
  RecycleBin: 'RecycleBin',
  NeteaseLibrary: 'NeteaseLibrary'
}

export async function ensureEnglishCoreLibraries(dbRootDir: string): Promise<void> {
  const base = path.join(dbRootDir, 'library')
  await fs.ensureDir(base)
  for (const enName of CORE_KEYS) {
    const cnName = CORE_EN_TO_CN[enName]
    const enPath = path.join(base, enName)
    const cnPath = path.join(base, cnName)
    const enExists = await fs.pathExists(enPath)
    const cnExists = await fs.pathExists(cnPath)
    try {
      if (enExists) {
        coreEnToFsName[enName] = enName
      } else if (cnExists) {
        // 尝试将中文目录重命名为英文
        try {
          await fs.rename(cnPath, enPath)
          coreEnToFsName[enName] = enName
        } catch (_e) {
          // 重命名失败，回退使用中文目录名，后续重试
          coreEnToFsName[enName] = cnName
        }
      } else {
        // 两者都不存在，创建英文目录
        await fs.ensureDir(enPath)
        coreEnToFsName[enName] = enName
      }
    } catch (_err) {
      // 任一异常时，保守回退到中文
      coreEnToFsName[enName] = cnExists ? cnName : enName
    }
  }
}

export function getCoreFsDirName(enName: CoreLibraryName): string {
  return coreEnToFsName[enName] || enName
}
