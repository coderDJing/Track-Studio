import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { createGithubClient, loadRuntimeWorld } from './lib/demucs-runtime-release-github.mjs'
import {
  CHANNEL_TAGS,
  MANIFEST_NAME,
  RETENTION_NAME,
  assertChannel,
  manifestReferences,
  nextState,
  planCleanup,
  verifyReference
} from './lib/demucs-runtime-retention.mjs'

const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))

async function verifyLocal(file, ref) {
  if (!fs.statSync(file).isFile() || fs.statSync(file).size !== ref.size) {
    throw new Error(`Local archive size mismatch: ${ref.name}`)
  }
  const hash = createHash('sha256')
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk)
  if (hash.digest('hex') !== ref.sha256) throw new Error(`Local SHA256 mismatch: ${ref.name}`)
}

function writeVerifiedJson(api, tag, name, value) {
  api.writeJson(tag, name, value)
  const remote = api.readJson(api.readRelease(tag), name)
  if (!sameJson(remote, JSON.parse(JSON.stringify(value)))) {
    throw new Error(`Published metadata verification failed: ${name}`)
  }
}

export async function publishRuntimeAssets({
  api,
  tag,
  directory,
  base,
  apply = false,
  now = Date.now()
}) {
  assertChannel(tag)
  const world = loadRuntimeWorld(api)
  const incoming = readJson(path.join(directory, MANIFEST_NAME))
  if (incoming.releaseTag !== tag) throw new Error('Incoming manifest channel mismatch')
  const refs = manifestReferences(incoming, api.repo)
  if (base !== undefined) {
    const expected = fs.existsSync(base) ? readJson(base) : null
    if (!sameJson(expected, world.manifests[tag])) {
      throw new Error('Base manifest changed since merge; rebuild the merged manifest')
    }
  }
  // Also validate the other channel and both rollback snapshots before publication.
  planCleanup({ ...world, tag, now })
  const uploads = []
  for (const ref of refs) {
    const remote = world.releases[ref.tag]?.assets.find((a) => a.name === ref.name)
    const file = path.join(directory, ref.name)
    if (fs.existsSync(file)) await verifyLocal(file, ref)
    if (remote) {
      verifyReference(ref, world.releases)
    } else if (ref.tag === tag && fs.existsSync(file)) {
      uploads.push(file)
    } else {
      throw new Error(`Required runtime archive unavailable: ${ref.tag}/${ref.name}`)
    }
  }
  const next = nextState(world.manifests[tag], world.states[tag], incoming, api.repo)
  if (!apply)
    return {
      dryRun: true,
      tag,
      uploads: uploads.map((f) => path.basename(f)),
      hasRollback: !!next.previous
    }

  if (!world.releases[tag]) api.createRelease(tag)
  for (const file of uploads) api.uploadArchive(tag, file)
  const uploaded = loadRuntimeWorld(api)
  if (
    !sameJson(uploaded.manifests[tag], world.manifests[tag]) ||
    !sameJson(uploaded.states[tag], world.states[tag])
  ) {
    throw new Error('Runtime release changed during upload; refusing manifest switch')
  }
  for (const ref of refs) verifyReference(ref, uploaded.releases)

  writeVerifiedJson(api, tag, RETENTION_NAME, {
    ...world.states[tag],
    pending: { current: incoming, previous: next.previous }
  })
  writeVerifiedJson(api, tag, MANIFEST_NAME, incoming)
  api.finishRelease(tag)
  writeVerifiedJson(api, tag, RETENTION_NAME, next)

  const published = loadRuntimeWorld(api)
  if (!sameJson(published.manifests[tag], incoming)) throw new Error('Public manifest changed')
  const plan = planCleanup({ ...published, tag, now })
  const savedState = { ...published.states[tag], retired: plan.retired }
  writeVerifiedJson(api, tag, RETENTION_NAME, savedState)
  // Observe cross-channel reuse on every publication, not just the next publication
  // of the file's owner. Otherwise a retired file reused briefly by RC could retain
  // an old retirement timestamp and lose its grace period after RC stops using it.
  for (const channel of CHANNEL_TAGS.filter((value) => value !== tag)) {
    if (!published.releases[channel]) continue
    const peerPlan = planCleanup({ ...published, tag: channel, now })
    const peerState = { ...published.states[channel], retired: peerPlan.retired }
    if (!sameJson(peerState, published.states[channel])) {
      writeVerifiedJson(api, channel, RETENTION_NAME, peerState)
    }
  }

  // A second read immediately before deletion protects references added by the other
  // channel. Both workflows additionally share one non-cancelling publication lock.
  const latest = loadRuntimeWorld(api)
  if (!sameJson(latest.manifests[tag], incoming) || !sameJson(latest.states[tag], savedState)) {
    throw new Error('Retention metadata changed before cleanup')
  }
  const finalPlan = planCleanup({ ...latest, tag, now })
  for (const asset of finalPlan.deletions) api.deleteAsset(asset)
  return {
    tag,
    uploaded: uploads.length,
    deleted: finalPlan.deletions.map((a) => a.name),
    protected: finalPlan.protectedNames.length,
    waiting: Object.keys(finalPlan.retired).length - finalPlan.deletions.length,
    hasRollback: finalPlan.hasRollback
  }
}

async function main() {
  const [command, ...args] = process.argv.slice(2)
  const option = (flag, defaultValue = '') => {
    const index = args.indexOf(flag)
    return index < 0 ? defaultValue : args[index + 1]
  }
  const api = createGithubClient(
    option('--repo', process.env.GH_REPO || process.env.GITHUB_REPOSITORY || '')
  )
  const tag = option('--tag')
  if (command === 'audit') {
    const world = loadRuntimeWorld(api)
    for (const channel of CHANNEL_TAGS) {
      const plan = planCleanup({ ...world, tag: channel })
      console.log(
        JSON.stringify(
          {
            tag: channel,
            total: world.releases[channel]?.assets.length ?? 0,
            protected: plan.protectedNames,
            hasRollback: plan.hasRollback,
            waiting: Object.keys(plan.retired).length - plan.deletions.length,
            deletions: plan.deletions.map((a) => a.name)
          },
          null,
          2
        )
      )
    }
    return
  }
  assertChannel(tag)
  const directory = option('--dir')
  if (!directory) throw new Error('--dir is required')
  if (command === 'publish') {
    console.log(
      JSON.stringify(
        await publishRuntimeAssets({
          api,
          tag,
          directory,
          base: args.includes('--base') ? option('--base') : undefined,
          apply: args.includes('--apply')
        }),
        null,
        2
      )
    )
    return
  }
  if (command !== 'snapshot' && command !== 'download') throw new Error('Unknown command')
  const world = loadRuntimeWorld(api)
  const manifest = args.includes('--previous') ? world.states[tag].previous : world.manifests[tag]
  const output = path.join(directory, MANIFEST_NAME)
  if (fs.existsSync(output)) throw new Error('Snapshot output already exists')
  if (!manifest) {
    if (command === 'download' || args.includes('--previous')) {
      throw new Error('Source runtime manifest missing')
    }
    return
  }
  const refs = manifestReferences(manifest, api.repo)
  for (const ref of refs) verifyReference(ref, world.releases)
  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`)
  if (command === 'download') {
    for (const ref of refs) {
      api.download(ref.tag, ref.name, directory)
      await verifyLocal(path.join(directory, ref.name), ref)
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
