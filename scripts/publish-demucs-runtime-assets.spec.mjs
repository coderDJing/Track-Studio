import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { publishRuntimeAssets } from './publish-demucs-runtime-assets.mjs'
import { createGithubClient, loadRuntimeWorld } from './lib/demucs-runtime-release-github.mjs'
import {
  CHANNEL_TAGS,
  MANIFEST_NAME,
  RETENTION_NAME,
  GRACE_MS,
  manifestReferences,
  nextState,
  planCleanup,
  recoverState
} from './lib/demucs-runtime-retention.mjs'

const [stable, rc] = CHANNEL_TAGS
const repo = 'coderDJing/Track-Studio'
const now = Date.parse('2026-10-28T00:00:00Z')
const clone = (value) => JSON.parse(JSON.stringify(value))
const sha = (value) => createHash('sha256').update(value).digest('hex')
const platforms = [
  ['win32-x64', 'cpu'],
  ['win32-x64', 'cuda'],
  ['win32-x64', 'directml'],
  ['win32-x64', 'xpu'],
  ['darwin-arm64', 'cpu'],
  ['darwin-arm64', 'mps'],
  ['darwin-x64', 'cpu']
]
const bytes = (name) => Buffer.from(name)

function manifest(version, tag = stable) {
  return {
    schemaVersion: 1,
    releaseTag: tag,
    generatedAt: new Date(now).toISOString(),
    assets: platforms.map(([platform, profile]) => {
      const archiveName = `frkb-demucs-runtime-${platform}-${profile}-${version}.zip`
      const file = (name) => ({
        archiveName: name,
        archiveUrl: `https://github.com/${repo}/releases/download/${tag}/${name}`,
        archiveSize: bytes(name).length,
        archiveSha256: sha(bytes(name))
      })
      const archiveParts =
        profile === 'cuda'
          ? [1, 2].map((index) => ({
              index,
              ...file(`${archiveName}.part${String(index).padStart(3, '0')}`)
            }))
          : []
      return {
        platform,
        profile,
        runtimeKey: `runtime-${profile}`,
        version,
        ...file(archiveName),
        ...(archiveParts.length
          ? { archiveUrl: '', archiveSize: archiveParts.reduce((sum, p) => sum + p.archiveSize, 0) }
          : {}),
        archiveParts
      }
    })
  }
}

function fakeGithub(manifests = [manifest('a'), manifest('a', rc)]) {
  let id = 0
  const releases = {}
  const metadata = {}
  const events = []
  const add = (tag, ref) => {
    const asset = {
      id: ++id,
      name: ref.name,
      state: 'uploaded',
      size: ref.size,
      digest: `sha256:${ref.sha256}`
    }
    releases[tag].assets.push(asset)
    return asset
  }
  const api = {
    repo,
    releases,
    metadata,
    events,
    failAt: '',
    readRelease: (tag) => clone(releases[tag] ?? null),
    readJson: (release, name) => clone(metadata[release?.tag_name]?.[name] ?? null),
    createRelease(tag) {
      events.push('create')
      releases[tag] = { id: ++id, tag_name: tag, draft: true, assets: [] }
      metadata[tag] = {}
    },
    uploadArchive(tag, file) {
      events.push('archive')
      if (api.failAt === 'archive') throw new Error('injected archive failure')
      const name = path.basename(file)
      assert.ok(!releases[tag].assets.some((a) => a.name === name), 'no archive clobber')
      const content = fs.readFileSync(file)
      add(tag, { name, size: content.length, sha256: sha(content) })
    },
    writeJson(tag, name, value) {
      events.push(name)
      if (api.failAt === name) throw new Error('injected metadata failure')
      metadata[tag][name] = clone(value)
    },
    finishRelease(tag) {
      events.push('finish')
      if (api.failAt === 'finish') throw new Error('injected finish failure')
      releases[tag].draft = false
    },
    deleteAsset(asset) {
      events.push(`delete:${asset.name}`)
      for (const r of Object.values(releases)) r.assets = r.assets.filter((a) => a.id !== asset.id)
    },
    addManifest(m) {
      for (const ref of manifestReferences(m, repo)) add(ref.tag, ref)
    }
  }
  for (const m of manifests) {
    releases[m.releaseTag] = { id: ++id, tag_name: m.releaseTag, draft: false, assets: [] }
    metadata[m.releaseTag] = { [MANIFEST_NAME]: clone(m) }
    api.addManifest(m)
  }
  return api
}

function directory(t, m, archives = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frkb-retention-test-'))
  fs.writeFileSync(path.join(dir, MANIFEST_NAME), JSON.stringify(m))
  if (archives)
    for (const ref of manifestReferences(m, repo)) {
      fs.writeFileSync(path.join(dir, ref.name), bytes(ref.name))
    }
  t.after(() => {
    for (const name of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, name))
    fs.rmdirSync(dir)
  })
  return dir
}

test('first adoption and metadata-only publication never invent or erase rollback', async (t) => {
  const api = fakeGithub()
  api.addManifest(manifest('ancient'))
  const m = { ...manifest('a'), appVersion: '1.2.6' }
  const dir = directory(t, m)
  const result = await publishRuntimeAssets({ api, tag: stable, directory: dir, apply: true, now })
  assert.equal(result.hasRollback, false)
  assert.equal(result.waiting, 8)
  const second = await publishRuntimeAssets({
    api,
    tag: stable,
    directory: dir,
    apply: true,
    now: now + GRACE_MS * 2
  })
  assert.equal(second.deleted.length, 0)
})

test('publish archives first, retain both channels and one rollback, wait seven days', async (t) => {
  const api = fakeGithub()
  api.addManifest(manifest('ancient'))
  const incoming = manifest('b')
  const dir = directory(t, incoming)
  const first = await publishRuntimeAssets({ api, tag: stable, directory: dir, apply: true, now })
  assert.equal(first.deleted.length, 0)
  assert.equal(first.protected, 16)
  assert.equal(api.events.indexOf(MANIFEST_NAME), 9)
  assert.deepEqual(api.events.slice(0, 8), Array(8).fill('archive'))
  const second = await publishRuntimeAssets({
    api,
    tag: stable,
    directory: dir,
    apply: true,
    now: now + GRACE_MS
  })
  assert.equal(second.deleted.length, 8)
  assert.ok(second.deleted.every((name) => name.includes('-ancient.zip')))
  assert.equal(api.releases[stable].assets.length, 16)
  assert.equal(api.releases[rc].assets.length, 8)
  assert.equal(api.metadata[stable][RETENTION_NAME].previous.assets[0].version, 'a')
})

test('partial platform update retains a complete previous manifest', () => {
  const old = manifest('a')
  const incoming = manifest('b')
  incoming.assets = incoming.assets.map((entry, i) => (i === 0 ? entry : old.assets[i]))
  const state = nextState(old, null, incoming, repo)
  assert.deepEqual(state.previous, old)
  const api = fakeGithub([old, manifest('a', rc)])
  const ref = manifestReferences(incoming, repo)[0]
  api.releases[stable].assets.push({
    id: 100,
    name: ref.name,
    state: 'uploaded',
    size: ref.size,
    digest: `sha256:${ref.sha256}`
  })
  const world = loadRuntimeWorld(api)
  world.states[stable] = state
  world.manifests[stable] = incoming
  assert.equal(planCleanup({ ...world, tag: stable, now }).protectedNames.length, 9)
})

test('RC may reference a stable file, including through the old repository name', () => {
  const api = fakeGithub()
  const shared = manifest('shared')
  api.addManifest(shared)
  const remote = api.metadata[rc][MANIFEST_NAME]
  remote.assets[0] = shared.assets[0]
  remote.assets[0].archiveUrl = remote.assets[0].archiveUrl.replace(
    'Track-Studio',
    'FRKB_Rapid-Audio-Organization-Tool'
  )
  const world = loadRuntimeWorld(api)
  const plan = planCleanup({ ...world, tag: stable, now })
  assert.ok(plan.protectedNames.includes(shared.assets[0].archiveName))
})

test('corrupt parts, incomplete platforms, foreign URLs and missing peer files fail closed', () => {
  const bad = manifest('a')
  bad.assets[1].archiveParts.pop()
  assert.throws(() => manifestReferences(bad, repo), /part sizes/)
  const incomplete = manifest('a')
  incomplete.assets.pop()
  assert.throws(() => manifestReferences(incomplete, repo), /seven/)
  const foreign = manifest('a')
  foreign.assets[0].archiveUrl = foreign.assets[0].archiveUrl.replace('coderDJing', 'someone')
  assert.throws(() => manifestReferences(foreign, repo), /Unrecognized/)
  const api = fakeGithub()
  api.releases[rc].assets.pop()
  assert.throws(() => planCleanup({ ...loadRuntimeWorld(api), tag: stable, now }), /unverified/)
})

test('read-only default performs no uploads or deletion', async (t) => {
  const api = fakeGithub()
  await publishRuntimeAssets({ api, tag: rc, directory: directory(t, manifest('b', rc)), now })
  assert.deepEqual(api.events, [])
})

test('same name with different bytes fails before all mutations', async (t) => {
  const api = fakeGithub()
  const m = manifest('a')
  api.releases[stable].assets[0].digest = `sha256:${'0'.repeat(64)}`
  await assert.rejects(
    publishRuntimeAssets({ api, tag: stable, directory: directory(t, m), apply: true, now }),
    /unverified/
  )
  assert.deepEqual(api.events, [])
})

for (const failAt of ['archive', MANIFEST_NAME, 'finish']) {
  test(`failure at ${failAt} does not delete; retry preserves rollback`, async (t) => {
    const api = fakeGithub()
    api.addManifest(manifest('ancient'))
    const dir = directory(t, manifest('b'))
    api.failAt = failAt
    await assert.rejects(
      publishRuntimeAssets({ api, tag: stable, directory: dir, apply: true, now })
    )
    assert.ok(!api.events.some((e) => e.startsWith('delete:')))
    api.failAt = ''
    await publishRuntimeAssets({ api, tag: stable, directory: dir, apply: true, now })
    assert.equal(api.metadata[stable][RETENTION_NAME].previous.assets[0].version, 'a')
  })
}

test('interrupted journal preserves the old rollback before a manifest switch', () => {
  const a = manifest('a'),
    b = manifest('b'),
    c = manifest('c')
  const state = {
    schemaVersion: 1,
    current: b,
    previous: a,
    retired: {},
    pending: { current: c, previous: b }
  }
  assert.deepEqual(recoverState(b, state, repo).previous, a)
  assert.deepEqual(recoverState(c, state, repo).previous, b)
  assert.throws(() => recoverState(manifest('unknown'), state, repo), /outside/)
})

test('a publication containing no existing release starts with no cleanup', async (t) => {
  const api = fakeGithub([manifest('a', rc)])
  const result = await publishRuntimeAssets({
    api,
    tag: stable,
    directory: directory(t, manifest('a')),
    apply: true,
    now
  })
  assert.equal(result.hasRollback, false)
  assert.equal(api.releases[stable].draft, false)
})

test('unknown assets and models are never candidates; retirement starts on observation', () => {
  const api = fakeGithub()
  api.releases[stable].assets.push({ id: 99, name: 'model.th' }, { id: 100, name: 'notes.json' })
  const old = manifest('old')
  api.addManifest(old)
  const world = loadRuntimeWorld(api)
  const plan = planCleanup({ ...world, tag: stable, now })
  assert.equal(Object.keys(plan.retired).length, 8)
  assert.ok(Object.values(plan.retired).every((r) => r.since === new Date(now).toISOString()))
  assert.deepEqual(plan.deletions, [])
})

test('changed merge base and local checksum mismatch fail before uploads', async (t) => {
  const api = fakeGithub()
  const dir = directory(t, manifest('b'))
  await assert.rejects(
    publishRuntimeAssets({
      api,
      tag: stable,
      directory: dir,
      base: path.join(dir, MANIFEST_NAME),
      apply: true,
      now
    }),
    /Base manifest changed/
  )
  const ref = manifestReferences(manifest('b'), repo)[0]
  fs.writeFileSync(path.join(dir, ref.name), Buffer.alloc(ref.size))
  await assert.rejects(
    publishRuntimeAssets({ api, tag: stable, directory: dir, apply: true, now }),
    /SHA256 mismatch/
  )
  assert.deepEqual(api.events, [])
})

test('RC publication retires only RC files; stable current and rollback survive', async (t) => {
  const api = fakeGithub()
  api.addManifest(manifest('old', rc))
  const dir = directory(t, manifest('b', rc))
  await publishRuntimeAssets({ api, tag: rc, directory: dir, apply: true, now })
  const result = await publishRuntimeAssets({
    api,
    tag: rc,
    directory: dir,
    apply: true,
    now: now + GRACE_MS
  })
  assert.equal(result.deleted.length, 8)
  assert.equal(api.releases[stable].assets.length, 8)
  assert.equal(api.releases[rc].assets.length, 16)
})

test('cross-channel reuse cancels an old retirement timestamp on the owner', async (t) => {
  const api = fakeGithub()
  const shared = manifest('shared')
  api.addManifest(shared)
  await publishRuntimeAssets({
    api,
    tag: stable,
    directory: directory(t, manifest('b')),
    apply: true,
    now
  })
  const ref = manifestReferences(shared, repo)[0]
  const asset = api.releases[stable].assets.find((a) => a.name === ref.name)
  assert.ok(api.metadata[stable][RETENTION_NAME].retired[asset.id])
  const next = manifest('b', rc)
  next.assets[0] = shared.assets[0]
  await publishRuntimeAssets({
    api,
    tag: rc,
    directory: directory(t, next),
    apply: true,
    now: now + GRACE_MS * 2
  })
  assert.equal(api.metadata[stable][RETENTION_NAME].retired[asset.id], undefined)
  assert.ok(api.releases[stable].assets.some((a) => a.id === asset.id))
})

test('missing public manifest blocks cleanup even when a journal survives', () => {
  const api = fakeGithub()
  api.metadata[stable][RETENTION_NAME] = {
    schemaVersion: 1,
    current: manifest('a'),
    previous: null,
    retired: {},
    pending: { current: manifest('b'), previous: manifest('a') }
  }
  delete api.metadata[stable][MANIFEST_NAME]
  assert.throws(() => loadRuntimeWorld(api), /Published runtime manifest missing/)
  assert.deepEqual(api.events, [])
})

test('GitHub adapter paginates inventory and only replaces named JSON metadata', () => {
  const calls = []
  let writtenFile
  const api = createGithubClient(repo, (command, args) => {
    assert.equal(command, 'gh')
    calls.push(args)
    if (args[0] === 'api' && args[1].includes('/tags/')) return JSON.stringify({ id: 1 })
    if (args.includes('--paginate')) {
      return JSON.stringify([
        Array.from({ length: 100 }, (_, i) => ({ id: i })),
        Array.from({ length: 37 }, (_, i) => ({ id: i + 100 }))
      ])
    }
    if (args[0] === 'release' && args[1] === 'upload' && args.includes('--clobber')) {
      writtenFile = args[3]
      assert.equal(path.basename(writtenFile), RETENTION_NAME)
      assert.deepEqual(JSON.parse(fs.readFileSync(writtenFile)), { schemaVersion: 1 })
    }
    return ''
  })
  assert.equal(api.readRelease(stable).assets.length, 137)
  api.writeJson(stable, RETENTION_NAME, { schemaVersion: 1 })
  assert.equal(fs.existsSync(writtenFile), false)
  api.uploadArchive(stable, '/tmp/archive.zip')
  assert.equal(calls.at(-1).includes('--clobber'), false)
  api.deleteAsset({ id: 123 })
  assert.deepEqual(calls.at(-1), ['api', '--method', 'DELETE', `repos/${repo}/releases/assets/123`])
})

test('GitHub network failures are not interpreted as an empty release', () => {
  const api = createGithubClient(repo, () => {
    const error = new Error('network unavailable')
    error.stderr = 'connection timeout'
    throw error
  })
  assert.throws(() => api.readRelease(stable), /network unavailable/)
})
