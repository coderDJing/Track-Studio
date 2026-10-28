import { createHash } from 'node:crypto'

export const CHANNEL_TAGS = ['demucs-runtime-assets', 'demucs-runtime-assets-rc']
export const MANIFEST_NAME = 'demucs-runtime-manifest.json'
export const RETENTION_NAME = 'demucs-runtime-retention.json'
export const GRACE_MS = 7 * 24 * 60 * 60 * 1000
const ARCHIVE_PATTERN =
  /^frkb-demucs-runtime-(?:win32-x64-(?:cpu|cuda|directml|xpu)|darwin-arm64-(?:cpu|mps)|darwin-x64-cpu)-[A-Za-z0-9][A-Za-z0-9._-]*\.zip(?:\.part\d{3})?$/
const IDENTITIES = [
  'win32-x64/cpu',
  'win32-x64/cuda',
  'win32-x64/directml',
  'win32-x64/xpu',
  'darwin-arm64/cpu',
  'darwin-arm64/mps',
  'darwin-x64/cpu'
].sort()

export function assertChannel(tag) {
  if (!CHANNEL_TAGS.includes(tag)) throw new Error(`Unsupported runtime channel: ${tag}`)
}

function assertDigest(value) {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error('Invalid runtime SHA256')
}

// Historical repository names are redirects to the same repository, not other owners.
function reference(file, repo) {
  if (!ARCHIVE_PATTERN.test(file.archiveName)) throw new Error('Invalid runtime archive name')
  assertDigest(file.archiveSha256)
  if (!Number.isSafeInteger(file.archiveSize) || file.archiveSize <= 0) {
    throw new Error('Invalid runtime archive size')
  }
  const url = new URL(file.archiveUrl)
  const segments = url.pathname.split('/').slice(1).map(decodeURIComponent)
  const [owner, repository, releases, download, tag, name] = segments
  const aliases = new Set([repo.toLowerCase()])
  if (repo.toLowerCase() === 'coderdjing/track-studio') {
    aliases.add('coderdjing/frkb_rapid-audio-organization-tool')
  }
  if (
    url.origin !== 'https://github.com' ||
    url.search ||
    url.hash ||
    segments.length !== 6 ||
    releases !== 'releases' ||
    download !== 'download' ||
    !aliases.has(`${owner}/${repository}`.toLowerCase()) ||
    name !== file.archiveName
  ) {
    throw new Error(`Unrecognized runtime URL: ${file.archiveUrl}`)
  }
  assertChannel(tag)
  return { tag, name, size: file.archiveSize, sha256: file.archiveSha256 }
}

export function manifestReferences(manifest, repo) {
  if (manifest?.schemaVersion !== 1 || !Array.isArray(manifest.assets)) {
    throw new Error('Invalid runtime manifest')
  }
  assertChannel(manifest.releaseTag)
  const identities = manifest.assets.map((a) => `${a.platform}/${a.profile}`).sort()
  if (JSON.stringify(identities) !== JSON.stringify(IDENTITIES)) {
    throw new Error('Runtime manifest must contain all seven platform/profile entries')
  }
  const refs = []
  for (const entry of manifest.assets) {
    if (
      entry.runtimeKey !== `runtime-${entry.profile}` ||
      !ARCHIVE_PATTERN.test(entry.archiveName) ||
      entry.archiveName !==
        `frkb-demucs-runtime-${entry.platform}-${entry.profile}-${entry.version}.zip` ||
      !entry.version
    ) {
      throw new Error('Invalid runtime identity')
    }
    assertDigest(entry.archiveSha256)
    const parts = entry.archiveParts ?? []
    if (!Array.isArray(parts)) throw new Error('Invalid archiveParts')
    if (parts.length) {
      if (parts.reduce((sum, part) => sum + part.archiveSize, 0) !== entry.archiveSize) {
        throw new Error('Runtime part sizes do not match archive size')
      }
      parts.forEach((part, i) => {
        if (
          part.index !== i + 1 ||
          part.archiveName !== `${entry.archiveName}.part${String(i + 1).padStart(3, '0')}`
        ) {
          throw new Error('Runtime archive parts are incomplete or out of order')
        }
        refs.push(reference(part, repo))
      })
    } else {
      refs.push(reference(entry, repo))
    }
  }
  if (new Set(refs.map((r) => `${r.tag}/${r.name}`)).size !== refs.length) {
    throw new Error('Duplicate runtime archive reference')
  }
  return refs
}

export function manifestIdentity(manifest, repo) {
  if (!manifest) return null
  const refs = manifestReferences(manifest, repo).sort((a, b) =>
    `${a.tag}/${a.name}`.localeCompare(`${b.tag}/${b.name}`)
  )
  return createHash('sha256').update(JSON.stringify(refs)).digest('hex')
}

export function verifyReference(ref, releases) {
  const asset = releases[ref.tag]?.assets.find((a) => a.name === ref.name)
  if (
    !asset ||
    asset.state !== 'uploaded' ||
    asset.size !== ref.size ||
    asset.digest !== `sha256:${ref.sha256}`
  ) {
    throw new Error(`Missing or unverified runtime asset: ${ref.tag}/${ref.name}`)
  }
  return asset
}

export function recoverState(actual, state, repo) {
  if (!state) return { schemaVersion: 1, current: actual, previous: null, retired: {} }
  if (
    state.schemaVersion !== 1 ||
    !Object.hasOwn(state, 'current') ||
    !Object.hasOwn(state, 'previous') ||
    !state.retired ||
    typeof state.retired !== 'object' ||
    Array.isArray(state.retired) ||
    (state.pending && (!state.pending.current || !Object.hasOwn(state.pending, 'previous')))
  ) {
    throw new Error('Invalid runtime retention state')
  }
  for (const m of [
    state.current,
    state.previous,
    state.pending?.current,
    state.pending?.previous
  ]) {
    if (m) manifestReferences(m, repo)
  }
  // The journal is uploaded before switching the public manifest. Recover either side
  // of an interrupted publication without losing the last successful rollback snapshot.
  if (
    state.pending &&
    manifestIdentity(actual, repo) === manifestIdentity(state.pending.current, repo)
  ) {
    return { ...state, ...state.pending, pending: undefined }
  }
  if (manifestIdentity(actual, repo) !== manifestIdentity(state.current, repo)) {
    throw new Error('Public manifest changed outside the runtime publisher; refusing cleanup')
  }
  return { ...state, current: actual, pending: undefined }
}

export function nextState(actual, state, incoming, repo) {
  const recovered = recoverState(actual, state, repo)
  return {
    ...recovered,
    current: incoming,
    previous:
      actual && manifestIdentity(actual, repo) !== manifestIdentity(incoming, repo)
        ? actual
        : recovered.previous
  }
}

export function planCleanup({ tag, releases, manifests, states, repo, now = Date.now() }) {
  assertChannel(tag)
  if (!Number.isFinite(now)) throw new Error('Invalid cleanup time')
  const protectedNames = new Set()
  for (const channel of CHANNEL_TAGS) {
    const state = states[channel]
    for (const manifest of [
      manifests[channel],
      state?.current,
      state?.previous,
      state?.pending?.current,
      state?.pending?.previous
    ]) {
      if (!manifest) continue
      for (const ref of manifestReferences(manifest, repo)) {
        verifyReference(ref, releases)
        if (ref.tag === tag) protectedNames.add(ref.name)
      }
    }
  }
  const retired = {}
  const deletions = []
  const state = states[tag]
  const hasRollback =
    !!state?.previous &&
    manifestIdentity(state.previous, repo) !== manifestIdentity(state.current, repo)
  for (const asset of releases[tag]?.assets ?? []) {
    if (!ARCHIVE_PATTERN.test(asset.name) || protectedNames.has(asset.name)) continue
    const old = state?.retired?.[asset.id]
    const since = old?.name === asset.name ? old.since : new Date(now).toISOString()
    const retiredAt = Date.parse(since)
    if (!Number.isFinite(retiredAt) || retiredAt > now)
      throw new Error('Invalid retirement timestamp')
    retired[asset.id] = { name: asset.name, since }
    if (hasRollback && now - retiredAt >= GRACE_MS) deletions.push(asset)
  }
  return { retired, deletions, protectedNames: [...protectedNames].sort(), hasRollback }
}
