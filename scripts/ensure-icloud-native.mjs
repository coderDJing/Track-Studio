import { spawnSync } from 'node:child_process'
import { mkdirSync, statSync, existsSync } from 'node:fs'
import path from 'node:path'
if (process.platform === 'darwin') {
  const source = path.resolve('native/icloud-localize.m')
  const output = path.resolve('resources/icloud-native/icloud-localize')
  if (!existsSync(output) || statSync(source).mtimeMs > statSync(output).mtimeMs) {
    mkdirSync(path.dirname(output), { recursive: true })
    const result = spawnSync(
      '/usr/bin/xcrun',
      [
        'clang',
        '-fobjc-arc',
        '-O2',
        '-arch',
        'arm64',
        '-arch',
        'x86_64',
        '-mmacosx-version-min=11.0',
        '-framework',
        'Foundation',
        source,
        '-o',
        output
      ],
      { stdio: 'inherit' }
    )
    if (result.status !== 0) process.exit(result.status || 1)
    const sign = spawnSync('/usr/bin/codesign', ['--force', '--sign', '-', output], {
      stdio: 'inherit'
    })
    if (sign.status !== 0) process.exit(sign.status || 1)
  }
}
