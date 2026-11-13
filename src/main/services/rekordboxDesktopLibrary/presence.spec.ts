import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createRekordboxDesktopPresenceProbe } from './presence'
import type { WindowsRegistryEntries } from './presenceWindows'

const temporaryRoots: string[] = []

const createRoot = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'frkb-rekordbox-presence-'))
  temporaryRoots.push(root)
  return root
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

const writeFile = (filePath: string, content = 'fixture') => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, content)
}

const writeJson = (filePath: string, value: unknown) => {
  writeFile(filePath, JSON.stringify(value))
}

const emptyRegistry = (): WindowsRegistryEntries => ({ appPaths: [], uninstall: [] })

const windowsEnv = (root: string): NodeJS.ProcessEnv => ({
  APPDATA: path.join(root, 'appdata'),
  ProgramFiles: path.join(root, 'program-files'),
  ProgramW6432: path.join(root, 'program-files')
})

const windowsProbe = (params: {
  root: string
  env?: NodeJS.ProcessEnv
  registry?: WindowsRegistryEntries
  arch?: string
}) =>
  createRekordboxDesktopPresenceProbe({
    platform: 'win32',
    arch: params.arch ?? 'x64',
    env: params.env ?? windowsEnv(params.root),
    homeDir: params.root,
    appDataDir: (params.env ?? windowsEnv(params.root)).APPDATA,
    pathApi: path,
    readWindowsRegistry: async () => params.registry ?? emptyRegistry()
  })

const macProbe = (params: {
  root: string
  arch?: string
  applicationsRoots?: string[]
  appDataDir?: string
}) =>
  createRekordboxDesktopPresenceProbe({
    platform: 'darwin',
    arch: params.arch ?? 'arm64',
    env: {},
    homeDir: params.root,
    appDataDir: params.appDataDir,
    pathApi: path,
    macApplicationsRoots: params.applicationsRoots ?? [path.join(params.root, 'Applications')],
    readWindowsRegistry: async () => emptyRegistry()
  })

const pio = (root: string) => path.join(root, 'appdata', 'Pioneer')

const encodeXmlNonAscii = (value: string): string =>
  value.replace(/[^\x00-\x7F]/g, (character) => `&#${character.codePointAt(0)};`)

describe('rekordbox desktop presence', () => {
  it('returns false when only an empty Pioneer directory exists', async () => {
    const root = createRoot()
    fs.mkdirSync(pio(root), { recursive: true })
    expect(await windowsProbe({ root })()).toBe(false)
  })

  it('returns false for stale options/settings and a stale uninstall entry', async () => {
    const root = createRoot()
    writeJson(path.join(pio(root), 'rekordboxAgent', 'storage', 'options.json'), {
      options: [['db-path', path.join(root, 'missing', 'master.db')]]
    })
    writeFile(
      path.join(pio(root), 'rekordbox6', 'rekordbox3.settings'),
      '<PROPERTIES><VALUE name="masterDbDirectory" val="' +
        path.join(root, 'missing-settings') +
        '"/></PROPERTIES>'
    )
    const registry: WindowsRegistryEntries = {
      appPaths: [],
      uninstall: [
        {
          displayName: 'rekordbox',
          installLocation: path.join(root, 'missing'),
          displayIcon: `${path.join(root, 'missing', 'rekordbox.exe')},0`
        }
      ]
    }

    expect(await windowsProbe({ root, registry })()).toBe(false)
  })

  it('returns true for an installed exe before the library is initialized', async () => {
    const root = createRoot()
    writeFile(path.join(root, 'program-files', 'Pioneer', 'rekordbox', 'rekordbox.exe'))
    fs.mkdirSync(pio(root), { recursive: true })
    expect(await windowsProbe({ root })()).toBe(true)
  })

  it('returns true for a custom options.json db-path', async () => {
    const root = createRoot()
    const dbPath = path.join(root, 'custom-library', 'master.db')
    writeFile(dbPath, 'encrypted-db-placeholder')
    writeJson(path.join(pio(root), 'rekordboxAgent', 'storage', 'options.json'), {
      options: [
        ['some-other-option', 'x'],
        ['db-path', dbPath]
      ]
    })
    expect(await windowsProbe({ root })()).toBe(true)
  })

  it('parses numeric XML entities and ignores VALUE inside comments', async () => {
    const root = createRoot()
    const dbDirectory = path.join(root, '中文库')
    writeFile(path.join(dbDirectory, 'master.db'), 'encrypted-db-placeholder')
    writeFile(
      path.join(pio(root), 'rekordbox6', 'rekordbox3.settings'),
      [
        '<PROPERTIES>',
        '  <!-- <VALUE name="masterDbDirectory" val="' +
          path.join(root, 'commented-missing') +
          '"/> -->',
        `  <VALUE name="masterDbDirectory" val="${encodeXmlNonAscii(dbDirectory)}"/>`,
        '</PROPERTIES>'
      ].join('\n')
    )
    expect(await windowsProbe({ root })()).toBe(true)
  })

  it('returns false for invalid XML even if the configured path exists', async () => {
    const root = createRoot()
    const dbDirectory = path.join(root, 'invalid-xml-library')
    writeFile(path.join(dbDirectory, 'master.db'), 'encrypted-db-placeholder')
    writeFile(
      path.join(pio(root), 'rekordbox6', 'rekordbox3.settings'),
      `<PROPERTIES><VALUE name="masterDbDirectory" val="${dbDirectory}"></WRONG></PROPERTIES>`
    )
    expect(await windowsProbe({ root })()).toBe(false)
  })

  it('returns true for a migrated XML masterDbDirectory', async () => {
    const root = createRoot()
    const dbDirectory = path.join(root, 'migrated-library')
    writeFile(path.join(dbDirectory, 'master.db'), 'encrypted-db-placeholder')
    writeFile(
      path.join(pio(root), 'rekordbox6', 'rekordbox3.settings'),
      `<PROPERTIES><VALUE name="masterDbDirectory" val="${dbDirectory}"/></PROPERTIES>`
    )
    expect(await windowsProbe({ root })()).toBe(true)
  })

  it('rejects XML that the parser would need to repair', async () => {
    const root = createRoot()
    const dbDirectory = path.join(root, 'incomplete-settings-library')
    writeFile(path.join(dbDirectory, 'master.db'), 'encrypted-db-placeholder')
    writeFile(
      path.join(pio(root), 'rekordbox6', 'rekordbox3.settings'),
      `<PROPERTIES><VALUE name="masterDbDirectory" val="${dbDirectory}"></PROPERTIES>`
    )
    expect(await windowsProbe({ root })()).toBe(false)
  })

  it('finds a Windows install through App Paths without assuming C drive', async () => {
    const root = createRoot()
    const exePath = path.join(root, '自定义 安装', 'rekordbox.exe')
    writeFile(exePath)
    expect(
      await windowsProbe({
        root,
        registry: { appPaths: [{ path: exePath }], uninstall: [] }
      })()
    ).toBe(true)
  })

  it('validates a Chinese install path and a DisplayIcon with spaces/comma', async () => {
    const root = createRoot()
    const installDir = path.join(root, '中文 安装,目录')
    const exePath = path.join(installDir, 'rekordbox.exe')
    writeFile(exePath)
    expect(
      await windowsProbe({
        root,
        registry: {
          appPaths: [],
          uninstall: [
            {
              displayName: 'rekordbox 中文',
              installLocation: installDir,
              displayIcon: `"${exePath}",0`
            }
          ]
        }
      })()
    ).toBe(true)
  })

  it('requires a real exe for uninstall entries, not just a DisplayName', async () => {
    const root = createRoot()
    expect(
      await windowsProbe({
        root,
        registry: {
          appPaths: [],
          uninstall: [
            {
              displayName: 'rekordbox 7',
              installLocation: path.join(root, 'not-installed'),
              displayIcon: ''
            }
          ]
        }
      })()
    ).toBe(false)
  })

  it('does not permanently cache a false result', async () => {
    const root = createRoot()
    const probe = windowsProbe({ root })
    expect(await probe()).toBe(false)
    writeFile(path.join(root, 'program-files', 'Pioneer', 'rekordbox', 'rekordbox.exe'))
    expect(await probe()).toBe(true)
  })

  it('detects a macOS app bundle, including version subdirectories', async () => {
    const root = createRoot()
    writeFile(
      path.join(
        root,
        'Applications',
        'rekordbox 6.8.5',
        'Rekordbox.app',
        'Contents',
        'MacOS',
        'rekordbox'
      )
    )
    expect(await macProbe({ root })()).toBe(true)
    expect(await macProbe({ root, arch: 'x64' })()).toBe(true)
  })

  it('detects a macOS local library without the app bundle', async () => {
    const root = createRoot()
    const appDataDir = path.join(root, 'Library', 'Application Support')
    const dbPath = path.join(root, 'external-drive', 'master.db')
    writeFile(dbPath)
    writeJson(path.join(appDataDir, 'Pioneer', 'rekordboxAgent', 'storage', 'options.json'), {
      options: [['db-path', dbPath]]
    })
    expect(await macProbe({ root, appDataDir })()).toBe(true)
  })

  it('does not let unrelated macOS applications exhaust the discovery limit', async () => {
    const root = createRoot()
    const applications = path.join(root, 'Applications')
    for (let index = 0; index < 210; index += 1) {
      fs.mkdirSync(path.join(applications, `A-unrelated-${index}.app`), { recursive: true })
    }
    writeFile(path.join(applications, 'rekordbox.app', 'Contents', 'MacOS', 'rekordbox'))
    expect(await macProbe({ root })()).toBe(true)
  })

  it('returns false on unsupported platforms or architectures', async () => {
    const root = createRoot()
    writeFile(path.join(root, 'program-files', 'Pioneer', 'rekordbox', 'rekordbox.exe'))
    expect(await windowsProbe({ root, arch: 'ia32' })()).toBe(false)
    const linuxProbe = createRekordboxDesktopPresenceProbe({
      platform: 'linux',
      arch: 'x64',
      env: {},
      pathApi: path,
      readWindowsRegistry: async () => emptyRegistry()
    })
    expect(await linuxProbe()).toBe(false)
  })

  it('returns false quietly when options.json is malformed', async () => {
    const root = createRoot()
    writeFile(path.join(pio(root), 'rekordboxAgent', 'storage', 'options.json'), '{not-json')
    expect(await windowsProbe({ root })()).toBe(false)
  })

  it('returns false quietly when a config path cannot be read as a file', async () => {
    const root = createRoot()
    fs.mkdirSync(path.join(pio(root), 'rekordboxAgent', 'storage', 'options.json'), {
      recursive: true
    })
    expect(await windowsProbe({ root })()).toBe(false)
  })
})
