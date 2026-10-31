import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  collectRuntimeRequirements,
  resolveRuntimePipProxy,
  selectDevRuntimeProfiles,
  tryReuseDemucsDevRuntime
} from './lib/demucs-dev-runtime.mjs'

const ready = {
  torch: true,
  torchaudio: true,
  demucs: true,
  onnxruntime: true,
  beat_this: true,
  librosa: true,
  soxr: true,
  rotary_embedding_torch: true,
  torch_version: '2.3.1+cu121',
  beat_this_version: '1.1.0'
}

const harness = (t, { payload = ready, missing = [] } = {}) => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'frkb-dev-runtime-test-'))
  const pythonPath = path.join(runtimeDir, 'python.exe')
  fs.writeFileSync(pythonPath, 'existing CUDA interpreter')
  const calls = []
  let currentPayload = { ...payload }
  t.after(() => {
    for (const entry of fs.readdirSync(runtimeDir)) fs.unlinkSync(path.join(runtimeDir, entry))
    fs.rmdirSync(runtimeDir)
  })
  const options = {
    profileName: 'cuda',
    runtimeDir,
    pythonPath,
    platform: 'win32-x64',
    basePipInstallArgs: ['--index-url', 'https://download.pytorch.org/whl/cpu', 'torch==2.3.1'],
    pipInstallArgs: [
      '--index-url',
      'https://download.pytorch.org/whl/cu121',
      'torch==2.3.1',
      'beat-this==1.1.0',
      'librosa==0.11.0'
    ],
    install: true,
    pipTimeoutSec: 120,
    validateRuntimePortability: () => {},
    probeModules: () => ({ ok: true, payload: currentPayload }),
    buildRuntimeEnv: () => ({ PATH: 'runtime' }),
    runQuiet: () => ({
      status: 0,
      stdout: JSON.stringify({
        missing,
        constraints: ['torch==2.3.1+cu121', 'torchaudio==2.3.1+cu121', 'librosa==0.10.0']
      })
    }),
    resolvePipProxy: () => 'http://system-proxy:1234',
    run: (command, args, { env }) => {
      const constraints = fs.readFileSync(args[args.indexOf('--constraint') + 1], 'utf8')
      calls.push({ command, args, env, constraints })
      currentPayload = { ...ready }
    },
    prepareCheckpoint: async () => {}
  }
  return { options, calls, runtimeDir }
}

test('development selects one GPU profile without CPU; CPU-only remains supported', () => {
  assert.deepEqual(selectDevRuntimeProfiles(['cpu', 'cuda', 'xpu']), ['cuda'])
  assert.deepEqual(selectDevRuntimeProfiles(['cpu', 'xpu']), ['xpu'])
  assert.deepEqual(selectDevRuntimeProfiles(['cpu', 'directml']), ['directml'])
  assert.deepEqual(selectDevRuntimeProfiles(['cpu', 'mps']), ['mps'])
  assert.deepEqual(selectDevRuntimeProfiles(['cpu']), ['cpu'])
})

test('profile versions override base requirements without treating index URLs as packages', () => {
  assert.deepEqual(
    collectRuntimeRequirements(
      ['--index-url', 'https://cpu.example', 'torch==2.3.1', 'numpy<2'],
      ['--extra-index-url=https://gpu.example', 'torch==2.4.1', 'librosa==0.11.0']
    ),
    ['torch==2.4.1', 'numpy<2', 'librosa==0.11.0']
  )
})

test('a complete CUDA runtime with missing metadata is validated and reused without pip', async (t) => {
  const h = harness(t)
  assert.equal(await tryReuseDemucsDevRuntime(h.options), true)
  assert.equal(h.calls.length, 0)
  assert.equal(fs.readFileSync(h.options.pythonPath, 'utf8'), 'existing CUDA interpreter')
  const meta = JSON.parse(fs.readFileSync(path.join(h.runtimeDir, '.frkb-runtime-meta.json')))
  assert.equal(meta.torchVersion, '2.3.1+cu121')
  assert.equal(meta.librosaInstalled, true)
})

test('missing librosa is repaired in place with CUDA constraints and system proxy', async (t) => {
  const h = harness(t, {
    payload: { ...ready, librosa: false },
    missing: [{ name: 'librosa', requirement: 'librosa==0.11.0' }]
  })
  assert.equal(await tryReuseDemucsDevRuntime(h.options), true)
  assert.equal(h.calls.length, 1)
  const call = h.calls[0]
  assert.equal(call.command, h.options.pythonPath)
  assert.deepEqual(call.args.slice(-1), ['librosa==0.11.0'])
  assert.equal(
    call.args.some((arg) => /torch|cpu|cu121/.test(arg)),
    false
  )
  assert.match(call.constraints, /torch==2.3.1\+cu121/)
  assert.doesNotMatch(call.constraints, /librosa/)
  assert.equal(call.env.PIP_PROXY, 'http://system-proxy:1234')
  assert.equal(fs.existsSync(call.args[call.args.indexOf('--constraint') + 1]), false)
  assert.equal(fs.readFileSync(h.options.pythonPath, 'utf8'), 'existing CUDA interpreter')
})

test('core version incompatibility requires full preparation without in-place pip changes', async (t) => {
  const h = harness(t, { missing: [{ name: 'torch', requirement: 'torch==2.4.1' }] })
  assert.equal(await tryReuseDemucsDevRuntime(h.options), false)
  assert.equal(h.calls.length, 0)
})

test('CPU torch inside a CUDA directory cannot pass reuse validation', async (t) => {
  const h = harness(t, { payload: { ...ready, torch_version: '2.3.1+cpu' } })
  assert.equal(await tryReuseDemucsDevRuntime(h.options), false)
  assert.equal(h.calls.length, 0)
})

test('a probe timeout is reported instead of triggering a full runtime download', async (t) => {
  const h = harness(t)
  h.options.probeModules = () => ({ ok: false, error: 'timeout' })
  await assert.rejects(tryReuseDemucsDevRuntime(h.options), /inspection failed: timeout/)
  assert.equal(h.calls.length, 0)
})

test('failed dependency repair is surfaced and never marks the runtime ready', async (t) => {
  const h = harness(t, { payload: { ...ready, librosa: false } })
  h.options.run = () => {}
  await assert.rejects(tryReuseDemucsDevRuntime(h.options), /still unavailable/)
  assert.equal(fs.existsSync(path.join(h.runtimeDir, '.frkb-runtime-meta.json')), false)
})

test('no-install reports missing dependencies without changing the runtime', async (t) => {
  const h = harness(t, { payload: { ...ready, librosa: false } })
  h.options.install = false
  await assert.rejects(tryReuseDemucsDevRuntime(h.options), /Missing runtime dependencies/)
  assert.equal(h.calls.length, 0)
})

test('portability inspection failure does not cause automatic destructive reinstall', async (t) => {
  const h = harness(t)
  h.options.validateRuntimePortability = () => {
    throw new Error('inspection failed')
  }
  await assert.rejects(tryReuseDemucsDevRuntime(h.options), /inspection failed/)
  assert.equal(h.calls.length, 0)
})

test('pip proxy respects environment, system PAC route, and direct routing', () => {
  assert.equal(
    resolveRuntimePipProxy(() => assert.fail(), { HTTPS_PROXY: 'http://env' }, 'win32'),
    'http://env'
  )
  assert.equal(
    resolveRuntimePipProxy(() => ({ status: 0, stdout: 'http://pac-proxy:1234\r\n' }), {}, 'win32'),
    'http://pac-proxy:1234'
  )
  assert.equal(
    resolveRuntimePipProxy(() => ({ status: 0, stdout: '' }), {}, 'win32'),
    ''
  )
  assert.throws(() => resolveRuntimePipProxy(() => ({ status: 1 }), {}, 'win32'), /system proxy/)
})
