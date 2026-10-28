import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  CHANNEL_TAGS,
  MANIFEST_NAME,
  RETENTION_NAME,
  manifestReferences,
  recoverState
} from './demucs-runtime-retention.mjs'

export function createGithubClient(repo, execute = execFileSync) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('Invalid GitHub repository')
  const gh = (args) =>
    execute('gh', args, {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env
    })
  const json = (args) => JSON.parse(gh(args))
  return {
    repo,
    readRelease(tag) {
      let release
      try {
        release = json(['api', `repos/${repo}/releases/tags/${tag}`])
      } catch (error) {
        if (/\(HTTP 404\)/.test(String(error.stderr))) return null
        throw error
      }
      release.assets = json([
        'api',
        `repos/${repo}/releases/${release.id}/assets?per_page=100`,
        '--paginate',
        '--slurp'
      ]).flat()
      return release
    },
    readJson(release, name) {
      const asset = release?.assets.find((a) => a.name === name)
      if (!asset) return null
      if (asset.state !== 'uploaded' || asset.size > 4 * 1024 * 1024) {
        throw new Error(`Invalid metadata asset: ${name}`)
      }
      return json([
        'api',
        `repos/${repo}/releases/assets/${asset.id}`,
        '-H',
        'Accept: application/octet-stream'
      ])
    },
    createRelease(tag) {
      gh([
        'release',
        'create',
        tag,
        '--repo',
        repo,
        '--title',
        tag,
        '--draft',
        '--latest=false',
        '--verify-tag'
      ])
    },
    uploadArchive(tag, file) {
      // Archive names are immutable. Never --clobber a file used by older clients.
      gh(['release', 'upload', tag, file, '--repo', repo])
    },
    writeJson(tag, name, value) {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'frkb-runtime-metadata-'))
      const file = path.join(directory, name)
      try {
        fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
        gh(['release', 'upload', tag, file, '--repo', repo, '--clobber'])
      } finally {
        fs.rmSync(file, { force: true })
        fs.rmdirSync(directory)
      }
    },
    finishRelease(tag) {
      gh([
        'release',
        'edit',
        tag,
        '--repo',
        repo,
        '--title',
        tag,
        '--draft=false',
        `--prerelease=${tag.endsWith('-rc')}`,
        '--latest=false'
      ])
      const latest = json(['api', `repos/${repo}/releases/latest`])
      if (latest.tag_name === tag) throw new Error('Runtime assets became Latest release')
    },
    deleteAsset(asset) {
      gh(['api', '--method', 'DELETE', `repos/${repo}/releases/assets/${asset.id}`])
    },
    download(tag, name, output) {
      gh(['release', 'download', tag, '--repo', repo, '--pattern', name, '--dir', output])
    }
  }
}

export function loadRuntimeWorld(api) {
  const releases = {}
  const manifests = {}
  const states = {}
  for (const tag of CHANNEL_TAGS) {
    const release = api.readRelease(tag)
    releases[tag] = release
    const manifest = api.readJson(release, MANIFEST_NAME)
    if (release && !release.draft && !manifest) {
      throw new Error(`Published runtime manifest missing: ${tag}`)
    }
    if (manifest) {
      manifestReferences(manifest, api.repo)
      if (manifest.releaseTag !== tag) throw new Error('Manifest channel mismatch')
    }
    manifests[tag] = manifest
    const stored = api.readJson(release, RETENTION_NAME)
    states[tag] = recoverState(manifest, stored, api.repo)
    for (const snapshot of [states[tag].current, states[tag].previous]) {
      if (snapshot && snapshot.releaseTag !== tag) throw new Error('Retention channel mismatch')
    }
  }
  return { releases, manifests, states, repo: api.repo }
}
