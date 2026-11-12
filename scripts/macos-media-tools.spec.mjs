// Run with: node --test scripts/macos-media-tools.spec.mjs
import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import {
  inspectMacosLoadCommands,
  validateMacosMediaTool,
  verifyMacosMediaHash
} from './lib/macos-media-tools.mjs'

const commands = ({
  version = '11.0',
  dependency = '/usr/lib/libSystem.B.dylib',
  legacy = false
} = {}) => `
Load command 0
          cmd ${legacy ? 'LC_VERSION_MIN_MACOSX' : 'LC_BUILD_VERSION'}
      cmdsize 32
     platform 1
        ${legacy ? 'version' : 'minos'} ${version}
          sdk 26.0
Load command 1
          cmd LC_LOAD_DYLIB
      cmdsize 56
         name ${dependency} (offset 24)
   time stamp 2 Thu Jan  1 08:00:02 1970
`

test('accepts system-only linkage and deployment targets at or below macOS 12', () => {
  assert.deepEqual(inspectMacosLoadCommands(commands()), [])
  assert.deepEqual(inspectMacosLoadCommands(commands({ version: '12.0' })), [])
  assert.deepEqual(inspectMacosLoadCommands(commands({ legacy: true, version: '10.13' })), [])
})

test('rejects the RC Homebrew dependency and macOS 26 deployment target together', () => {
  const failures = inspectMacosLoadCommands(
    commands({
      version: '26.0',
      dependency: '/opt/homebrew/Cellar/ffmpeg/9.0.2_1/lib/libavdevice.63.dylib'
    })
  )
  assert.equal(failures.length, 2)
  assert.match(failures[0], /external dynamic library.*homebrew/)
  assert.match(failures[1], /requires macOS 26.0/)
})

test('rejects non-system dependencies including relative and weak/reexported dylibs', () => {
  for (const dependency of [
    '/usr/local/lib/libavcodec.dylib',
    '@rpath/libavcodec.dylib',
    '@loader_path/libavcodec.dylib'
  ]) {
    for (const kind of ['LC_LOAD_DYLIB', 'LC_LOAD_WEAK_DYLIB', 'LC_REEXPORT_DYLIB']) {
      assert.match(
        inspectMacosLoadCommands(commands({ dependency }).replace('LC_LOAD_DYLIB', kind))[0],
        /external dynamic library/
      )
    }
  }
})

test('checks minor deployment versions, platform, and unreadable load commands', () => {
  assert.match(inspectMacosLoadCommands(commands({ version: '12.1' }))[0], /requires macOS 12.1/)
  assert.match(
    inspectMacosLoadCommands(commands().replace('platform 1', 'platform 2'))[0],
    /not a macOS binary/
  )
  assert.match(inspectMacosLoadCommands('unreadable')[0], /missing macOS deployment target/)
})

test('inspects both universal slices and refuses to launch an invalid binary', () => {
  const calls = []
  const run = (command, args) => {
    calls.push({ command, args })
    if (command === 'lipo') return 'x86_64 arm64\n'
    if (command === 'otool')
      return commands(args[1] === 'arm64' ? { dependency: '/opt/homebrew/lib/broken.dylib' } : {})
    throw Error('invalid binaries must not execute')
  }
  const failures = validateMacosMediaTool('/fixture/ffprobe', ['x64', 'arm64'], run)
  assert.equal(failures.length, 1)
  assert.match(failures[0], /\(arm64\).*homebrew/)
  assert.equal(calls.filter((c) => c.command === 'otool').length, 2)
  assert.equal(
    calls.some((c) => c.command === '/usr/bin/arch'),
    false
  )
})

test('rejects missing architectures and propagates tool/startup errors', () => {
  const missing = validateMacosMediaTool('/fixture/ffmpeg', ['arm64', 'x64'], (command) =>
    command === 'lipo' ? 'arm64' : commands()
  )
  assert.match(missing[0], /missing x86_64 slice/)
  const broken = validateMacosMediaTool('/fixture/ffmpeg', ['arm64'], () => {
    throw Error('bad Mach-O')
  })
  assert.match(broken[0], /bad Mach-O/)
  const failedStart = validateMacosMediaTool('/fixture/ffmpeg', ['arm64', 'x64'], (command) => {
    if (command === 'lipo') return 'arm64 x86_64'
    if (command === 'otool') return commands()
    throw Error('cannot launch')
  })
  if (process.arch === 'arm64' || process.arch === 'x64')
    assert.match(failedStart[0], /cannot launch/)
})

test('executes only the native slice after both slices pass inspection', () => {
  const calls = []
  const failures = validateMacosMediaTool('/fixture/ffmpeg', ['arm64', 'x64'], (command, args) => {
    calls.push({ command, args })
    return command === 'lipo'
      ? 'arm64 x86_64'
      : command === 'otool'
        ? commands()
        : 'ffmpeg version 6.1.1'
  })
  assert.deepEqual(failures, [])
  const launches = calls.filter((c) => c.command === '/usr/bin/arch')
  if (process.arch === 'arm64' || process.arch === 'x64') {
    assert.deepEqual(launches, [
      {
        command: '/usr/bin/arch',
        args: [process.arch === 'x64' ? '-x86_64' : '-arm64', '/fixture/ffmpeg', '-version']
      }
    ])
  }
})

test('verifies cached archive/binary contents rather than trusting file existence', () => {
  const bytes = Buffer.from('verified artifact')
  const expected = createHash('sha256').update(bytes).digest('hex')
  assert.doesNotThrow(() => verifyMacosMediaHash(bytes, expected, 'archive'))
  assert.throws(
    () => verifyMacosMediaHash(Buffer.from('corrupt cache'), expected, 'archive'),
    /SHA-256 mismatch: archive/
  )
})
