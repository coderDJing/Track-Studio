import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const projectDirectory = resolve(scriptDirectory, '..')
const windowsDirectory = process.env.WINDIR || 'C:\\Windows'
const compilerCandidates = [
  join(windowsDirectory, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
  join(windowsDirectory, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe')
]
const compiler = compilerCandidates.find((candidate) => existsSync(candidate))

if (process.platform !== 'win32') {
  throw new Error('The Track Studio installer frontend can only be built on Windows.')
}

if (!compiler) {
  throw new Error('The .NET Framework 4 C# compiler was not found on this Windows host.')
}

const source = join(projectDirectory, 'build', 'installer-ui', 'TrackStudioInstallerUi.cs')
const sessionSource = join(projectDirectory, 'build', 'installer-ui', 'InstallerSession.cs')
const optionsSource = join(projectDirectory, 'build', 'installer-ui', 'InstallerOptions.cs')
const textSource = join(projectDirectory, 'build', 'installer-ui', 'InstallerText.cs')
const linksSource = join(projectDirectory, 'build', 'installer-ui', 'InstallerLinks.cs')
const artworkSource = join(projectDirectory, 'build', 'installer-ui', 'WaveformArtwork.cs')
const uninstallViewSource = join(projectDirectory, 'build', 'installer-ui', 'InstallerUninstallView.cs')
const programSource = join(projectDirectory, 'build', 'installer-ui', 'InstallerProgram.cs')
const engineLifetimeSource = join(projectDirectory, 'build', 'installer-ui', 'InstallerEngineLifetime.cs')
const windowClosingSource = join(projectDirectory, 'build', 'installer-ui', 'InstallerWindowClosing.cs')
const nativeProgressSource = join(projectDirectory, 'build', 'installer-ui', 'InstallerNativeProgress.cs')
const progressWorkerSource = join(projectDirectory, 'build', 'installer-ui', 'InstallerProgressWorker.cs')
const icon = join(projectDirectory, 'build', 'icon.ico')
const projectLogo = join(projectDirectory, 'src', 'renderer', 'src', 'assets', 'logo.png')
const output = join(projectDirectory, 'dist', 'installer-ui', 'TrackStudioInstallerUi.exe')
const frameworkDirectory = dirname(compiler)
const wpfDirectory = join(frameworkDirectory, 'WPF')
mkdirSync(dirname(output), { recursive: true })

const result = spawnSync(
  compiler,
  [
    '/nologo',
    '/target:winexe',
    '/platform:anycpu',
    '/optimize+',
    '/utf8output',
    `/win32icon:${icon}`,
    `/resource:${projectLogo},TrackStudioInstallerUi.logo.png`,
    `/out:${output}`,
    '/reference:System.dll',
    '/reference:System.Core.dll',
    '/reference:System.Drawing.dll',
    '/reference:System.Windows.Forms.dll',
    `/reference:${join(wpfDirectory, 'WindowsBase.dll')}`,
    `/reference:${join(wpfDirectory, 'PresentationCore.dll')}`,
    `/reference:${join(wpfDirectory, 'PresentationFramework.dll')}`,
    `/reference:${join(frameworkDirectory, 'System.Xaml.dll')}`,
    source,
    sessionSource,
    optionsSource,
    textSource,
    linksSource,
    artworkSource,
    uninstallViewSource,
    programSource,
    engineLifetimeSource,
    windowClosingSource,
    nativeProgressSource,
    progressWorkerSource
  ],
  {
    cwd: projectDirectory,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  }
)

if (result.stdout) {
  process.stdout.write(result.stdout)
}
if (result.stderr) {
  process.stderr.write(result.stderr)
}
if (result.status !== 0 || !existsSync(output)) {
  throw new Error(`Failed to build the Track Studio installer frontend (exit ${result.status}).`)
}

console.log(`Built Windows installer frontend: ${output}`)
