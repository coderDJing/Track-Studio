import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DOMParser } from '@xmldom/xmldom'
import { readWindowsRekordboxRegistry, type WindowsRegistryEntries } from './presenceWindows'

const MAX_CONFIG_BYTES = 256 * 1024
const MAX_DIRECTORY_ENTRIES = 200
const MAX_CHILD_ENTRIES = 120
const MAX_APP_PATH_ENTRIES = 20
const MAX_UNINSTALL_ENTRIES = 60

type PresencePathApi = Pick<
  typeof path,
  'join' | 'resolve' | 'basename' | 'dirname' | 'isAbsolute' | 'normalize'
>

type DirectoryEntry = {
  name: string
  isDirectory: boolean
}

type XmlElementLike = {
  tagName: string
  getAttribute: (name: string) => string | null
}

export type RekordboxPresenceProbeOptions = {
  platform?: NodeJS.Platform
  arch?: string
  env?: NodeJS.ProcessEnv
  homeDir?: string
  appDataDir?: string
  macApplicationsRoots?: string[]
  readWindowsRegistry?: () => Promise<WindowsRegistryEntries>
  /** 测试注入：让 macOS 发现逻辑可在非 macOS 主机上用真实临时目录运行。 */
  pathApi?: PresencePathApi
}

const isUsableFile = async (filePath: string): Promise<boolean> => {
  try {
    const stat = await fs.promises.stat(filePath)
    return stat.isFile() && stat.size > 0
  } catch {
    return false
  }
}

const isRekordboxExe = async (filePath: string, pathApi: PresencePathApi): Promise<boolean> =>
  pathApi.basename(filePath).toLowerCase() === 'rekordbox.exe' && (await isUsableFile(filePath))

const isUsableMasterDb = async (filePath: string, pathApi: PresencePathApi): Promise<boolean> =>
  pathApi.basename(filePath).toLowerCase() === 'master.db' && (await isUsableFile(filePath))

const readSmallTextFile = async (filePath: string): Promise<string | null> => {
  try {
    const stat = await fs.promises.stat(filePath)
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_CONFIG_BYTES) return null
    return (await fs.promises.readFile(filePath, 'utf8')).replace(/^\uFEFF/, '')
  } catch {
    return null
  }
}

const listDirectoryEntries = async (
  directory: string,
  limit: number
): Promise<DirectoryEntry[]> => {
  try {
    const entries = await fs.promises.readdir(directory, { withFileTypes: true })
    return entries
      .filter((entry) => /^rekordbox/i.test(entry.name) || /^pioneer$/i.test(entry.name))
      .slice(0, limit)
      .map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory() }))
  } catch {
    return []
  }
}

const stripWrappingQuotes = (value: string): string => {
  const trimmed = value.trim()
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).trim()
  }
  return trimmed
}

const stripIconIndex = (value: string): string => value.replace(/,\s*-?\d+\s*$/, '').trim()

const cleanWindowsPath = (value: string): string =>
  stripWrappingQuotes(stripIconIndex(stripWrappingQuotes(value)))

const expandWindowsEnv = (value: string, env: NodeJS.ProcessEnv): string =>
  value.replace(/%([^%]+)%/g, (match, name: string) => {
    const direct = env[name]
    if (direct !== undefined) return direct
    const upper = name.toUpperCase()
    for (const [key, entry] of Object.entries(env)) {
      if (key.toUpperCase() === upper && entry !== undefined) return entry
    }
    return match
  })

const findXmlSettingValue = (xml: string, settingName: string): string => {
  try {
    const errors: string[] = []
    const document = new DOMParser({
      errorHandler: {
        warning: (message) => errors.push(String(message || 'xml-warning')),
        error: (message) => errors.push(String(message || 'xml-error')),
        fatalError: (message) => errors.push(String(message || 'xml-fatal-error'))
      }
    }).parseFromString(xml, 'text/xml')
    if (errors.length > 0) return ''
    const root = document.documentElement
    if (!root || String(root.tagName || '').toUpperCase() !== 'PROPERTIES') return ''
    for (let node = root.firstChild; node; node = node.nextSibling) {
      if (node.nodeType !== 1) continue
      const element = node as unknown as XmlElementLike
      if (String(element.tagName || '').toUpperCase() !== 'VALUE') continue
      if (element.getAttribute('name') !== settingName) continue
      return element.getAttribute('val') || ''
    }
    return ''
  } catch {
    return ''
  }
}

const resolveMasterDbFromSettings = async (
  settingsPath: string,
  pathApi: PresencePathApi
): Promise<string | null> => {
  const xml = await readSmallTextFile(settingsPath)
  if (!xml) return null
  const directory = findXmlSettingValue(xml, 'masterDbDirectory').trim()
  if (!directory) return null
  const candidate =
    pathApi.basename(directory).toLowerCase() === 'master.db'
      ? directory
      : pathApi.join(directory, 'master.db')
  return (await isUsableMasterDb(candidate, pathApi)) ? candidate : null
}

const resolveDbPathFromOptions = async (
  optionsPath: string,
  pathApi: PresencePathApi
): Promise<string | null> => {
  const raw = await readSmallTextFile(optionsPath)
  if (!raw) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  const options = (parsed as { options?: unknown } | null)?.options
  let dbPath = ''
  if (Array.isArray(options)) {
    for (const entry of options) {
      if (!Array.isArray(entry) || entry.length < 2) continue
      if (String(entry[0] || '').trim() !== 'db-path') continue
      dbPath = String(entry[1] || '').trim()
      if (dbPath) break
    }
  } else if (options && typeof options === 'object') {
    dbPath = String((options as Record<string, unknown>)['db-path'] || '').trim()
  }
  if (!dbPath) return null
  const candidate = pathApi.isAbsolute(dbPath)
    ? pathApi.normalize(dbPath)
    : pathApi.resolve(pathApi.dirname(optionsPath), dbPath)
  return (await isUsableMasterDb(candidate, pathApi)) ? candidate : null
}

const hasLocalRekordboxDatabase = async (params: {
  appDataDir: string
  pathApi: PresencePathApi
}): Promise<boolean> => {
  const { appDataDir, pathApi } = params
  if (!appDataDir) return false
  const pioneerRoot = pathApi.join(appDataDir, 'Pioneer')
  const optionsPath = pathApi.join(pioneerRoot, 'rekordboxAgent', 'storage', 'options.json')
  if (await resolveDbPathFromOptions(optionsPath, pathApi)) return true

  for (const settingsDir of ['rekordbox6', 'rekordbox7']) {
    const settingsPath = pathApi.join(pioneerRoot, settingsDir, 'rekordbox3.settings')
    if (await resolveMasterDbFromSettings(settingsPath, pathApi)) return true
  }

  for (const dbDir of ['rekordbox', 'rekordbox6', 'rekordbox7']) {
    if (await isUsableMasterDb(pathApi.join(pioneerRoot, dbDir, 'master.db'), pathApi)) {
      return true
    }
  }
  return false
}

const collectWindowsExeCandidates = (params: {
  env: NodeJS.ProcessEnv
  pathApi: PresencePathApi
}): string[] => {
  const { env, pathApi } = params
  const programRoots = Array.from(
    new Set(
      [env.ProgramFiles, env.ProgramW6432, env['ProgramFiles(x86)']]
        .map((value) => String(value || '').trim())
        .filter(Boolean)
    )
  )
  const relativeCandidates = [
    ['Pioneer', 'rekordbox', 'rekordbox.exe'],
    ['Pioneer', 'rekordbox 6', 'rekordbox.exe'],
    ['Pioneer', 'rekordbox 7', 'rekordbox.exe'],
    ['rekordbox', 'rekordbox.exe']
  ]
  const candidates: string[] = []
  for (const root of programRoots) {
    for (const relative of relativeCandidates) {
      candidates.push(pathApi.join(root, ...relative))
    }
  }
  return candidates
}

const findWindowsRegisteredExe = async (params: {
  entries: WindowsRegistryEntries
  env: NodeJS.ProcessEnv
  pathApi: PresencePathApi
}): Promise<string | null> => {
  for (const entry of params.entries.appPaths.slice(0, MAX_APP_PATH_ENTRIES)) {
    const candidate = cleanWindowsPath(expandWindowsEnv(entry.path, params.env))
    if (await isRekordboxExe(candidate, params.pathApi)) return candidate
  }
  for (const entry of params.entries.uninstall.slice(0, MAX_UNINSTALL_ENTRIES)) {
    if (entry.displayIcon) {
      const candidate = cleanWindowsPath(expandWindowsEnv(entry.displayIcon, params.env))
      if (await isRekordboxExe(candidate, params.pathApi)) return candidate
    }
    if (!entry.installLocation) continue
    const location = cleanWindowsPath(expandWindowsEnv(entry.installLocation, params.env))
    if (!location) continue
    if (await isRekordboxExe(location, params.pathApi)) return location
    for (const candidate of [
      params.pathApi.join(location, 'rekordbox.exe'),
      params.pathApi.join(location, 'rekordbox', 'rekordbox.exe')
    ]) {
      if (await isRekordboxExe(candidate, params.pathApi)) return candidate
    }
  }
  return null
}

const isMacAppBundle = async (appPath: string, pathApi: PresencePathApi): Promise<boolean> => {
  for (const executableName of ['rekordbox', 'Rekordbox']) {
    if (await isUsableFile(pathApi.join(appPath, 'Contents', 'MacOS', executableName))) {
      return true
    }
  }
  return false
}

const findMacBundleInDirectory = async (params: {
  directory: string
  pathApi: PresencePathApi
}): Promise<boolean> => {
  const entries = await listDirectoryEntries(params.directory, MAX_DIRECTORY_ENTRIES)
  for (const entry of entries) {
    const entryPath = params.pathApi.join(params.directory, entry.name)
    if (/^rekordbox.*\.app$/i.test(entry.name)) {
      if (await isMacAppBundle(entryPath, params.pathApi)) return true
      continue
    }
    if (!/^rekordbox/i.test(entry.name) && !/^pioneer$/i.test(entry.name)) continue
    if (!entry.isDirectory) continue
    const children = await listDirectoryEntries(entryPath, MAX_CHILD_ENTRIES)
    for (const child of children) {
      if (!/^rekordbox.*\.app$/i.test(child.name)) continue
      if (await isMacAppBundle(params.pathApi.join(entryPath, child.name), params.pathApi)) {
        return true
      }
    }
  }
  return false
}

const hasMacRekordboxBundle = async (params: {
  applicationsRoots: string[]
  pathApi: PresencePathApi
}): Promise<boolean> => {
  for (const root of params.applicationsRoots) {
    if (await findMacBundleInDirectory({ directory: root, pathApi: params.pathApi })) {
      return true
    }
  }
  return false
}

const resolveDefaultAppDataDir = (
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  homeDir: string,
  pathApi: PresencePathApi
): string => {
  if (platform === 'win32') {
    return String(env.APPDATA || '').trim() || pathApi.join(homeDir, 'AppData', 'Roaming')
  }
  if (platform === 'darwin') {
    return pathApi.join(homeDir, 'Library', 'Application Support')
  }
  return ''
}

export const createRekordboxDesktopPresenceProbe = (
  options: RekordboxPresenceProbeOptions = {}
): (() => Promise<boolean>) => {
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  const env = options.env ?? process.env
  const pathApi = options.pathApi ?? (platform === 'win32' ? path.win32 : path.posix)
  const homeDir = String(options.homeDir || os.homedir()).trim()
  const appDataDir = String(
    options.appDataDir || resolveDefaultAppDataDir(platform, env, homeDir, pathApi)
  ).trim()
  const readWindowsRegistry = options.readWindowsRegistry ?? readWindowsRekordboxRegistry
  const macApplicationsRoots =
    options.macApplicationsRoots ??
    (platform === 'darwin' ? ['/Applications', pathApi.join(homeDir, 'Applications')] : [])

  return async () => {
    try {
      if (platform === 'win32') {
        if (arch !== 'x64') return false
        for (const candidate of collectWindowsExeCandidates({ env, pathApi })) {
          if (await isRekordboxExe(candidate, pathApi)) return true
        }
        if (await hasLocalRekordboxDatabase({ appDataDir, pathApi })) return true
        const entries = await readWindowsRegistry().catch((): WindowsRegistryEntries => ({
          appPaths: [],
          uninstall: []
        }))
        return Boolean(await findWindowsRegisteredExe({ entries, env, pathApi }))
      }
      if (platform === 'darwin') {
        if (arch !== 'arm64' && arch !== 'x64') return false
        if (
          await hasMacRekordboxBundle({
            applicationsRoots: macApplicationsRoots,
            pathApi
          })
        ) {
          return true
        }
        return await hasLocalRekordboxDatabase({ appDataDir, pathApi })
      }
      return false
    } catch {
      return false
    }
  }
}

export async function hasRekordboxDesktopPresence(): Promise<boolean> {
  return await createRekordboxDesktopPresenceProbe()()
}
