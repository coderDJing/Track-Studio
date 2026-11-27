import { describe, expect, it, vi } from 'vitest'
import { createIcloudFolderTree } from './icloudFolderTree'
import type { IcloudFolderListing } from '@shared/icloudLibrary'
const listing = (directory: string, paths: string[], rootToken = 'root'): IcloudFolderListing => ({
  directory,
  rootToken,
  missingRoot: false,
  entries: paths.map((relativePath) => ({
    name: relativePath.split('/').pop()!,
    relativePath,
    directory: true,
    residency: 'local'
  }))
})
describe('lazy iCloud directory tree controller', () => {
  it('keeps all directories and reads no descendants until expanded', async () => {
    const fetch = vi.fn(async (relative: string) =>
      relative === ''
        ? listing('', ['Empty', 'Documents', 'Album'])
        : listing(relative, relative === 'Album' ? ['Album/Nested'] : [])
    )
    const tree = createIcloudFolderTree({ token: () => 'root', fetch })
    await tree.load(tree.root)
    expect(fetch.mock.calls.map(([relative]) => relative)).toEqual([''])
    const album = tree.root.children[2]
    expect(album.status).toBe('idle')
    await tree.toggle(album)
    expect(album.children[0].relativePath).toBe('Album/Nested')
    expect(fetch.mock.calls.map(([relative]) => relative)).toEqual(['', 'Album'])
    await tree.toggle(tree.root.children[0])
    expect(tree.root.children[0]).toMatchObject({ name: 'Empty', status: 'ready', children: [] })
  })
  it('preserves equivalent node identity and expansion on refresh', async () => {
    const tree = createIcloudFolderTree({
      token: () => 'root',
      fetch: async (relative) => listing(relative, relative === '' ? ['Album'] : ['Album/Nested'])
    })
    await tree.load(tree.root)
    const album = tree.root.children[0]
    await tree.toggle(album)
    const children = tree.root.children,
      nested = album.children[0]
    await tree.refresh()
    expect(tree.root.children).toBe(children)
    expect(tree.root.children[0]).toBe(album)
    expect(album.expanded).toBe(true)
    expect(album.children[0]).toBe(nested)
  })
  it('never expands known initial leaves, updates hints after refresh and rejects a stale child load', async () => {
    let presence = false,
      finish: ((data: IcloudFolderListing) => void) | undefined
    const fetch = vi.fn(async (relative: string): Promise<IcloudFolderListing> => {
      if (relative)
        return new Promise((resolve) => {
          finish = resolve
        })
      const data = listing('', ['Folder'])
      data.entries[0].hasChildren = presence
      return data
    })
    const tree = createIcloudFolderTree({ token: () => 'root', fetch })
    await tree.load(tree.root)
    const folder = tree.root.children[0]
    expect(folder.hasChildren).toBe(false)
    await tree.toggle(folder)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(folder.expanded).toBe(false)
    presence = true
    await tree.refresh()
    expect(tree.root.children[0]).toBe(folder)
    expect(folder.hasChildren).toBe(true)
    const pending = tree.toggle(folder)
    presence = false
    await tree.refresh()
    expect(folder).toMatchObject({ hasChildren: false, expanded: false, children: [] })
    finish!(listing('Folder', ['Folder/Stale']))
    await pending
    expect(folder).toMatchObject({ hasChildren: false, expanded: false, children: [] })
  })
  it('does not call an unavailable directory empty and allows explicit retry', async () => {
    const fetch = vi
      .fn<(relative: string, token: string) => Promise<IcloudFolderListing>>()
      .mockRejectedValueOnce(new Error('download'))
      .mockResolvedValueOnce(listing('', ['Empty']))
    const tree = createIcloudFolderTree({ token: () => 'root', fetch })
    await tree.load(tree.root)
    expect(tree.root).toMatchObject({ status: 'unavailable', error: 'download' })
    await tree.load(tree.root, true)
    expect(tree.root).toMatchObject({ status: 'ready', error: '' })
  })
  it('ignores a response from an old root and a superseded refresh', async () => {
    let token = 'root'
    const resolves: ((data: IcloudFolderListing) => void)[] = []
    const tree = createIcloudFolderTree({
      token: () => token,
      fetch: () => new Promise((resolve) => resolves.push(resolve))
    })
    const old = tree.load(tree.root)
    token = 'new'
    tree.reset()
    const current = tree.load(tree.root)
    resolves[0](listing('', ['Old']))
    await old
    expect(tree.root.status).toBe('loading')
    resolves[1](listing('', ['New'], 'new'))
    await current
    const first = tree.load(tree.root, true),
      second = tree.load(tree.root, true)
    resolves[3](listing('', ['Newest'], 'new'))
    await second
    resolves[2](listing('', ['Stale'], 'new'))
    await first
    expect(tree.root.children.map((node) => node.name)).toEqual(['Newest'])
  })
  it('does not continue revealing a deep old selection after the user switches folders', async () => {
    let finish!: (value: IcloudFolderListing) => void
    const fetch = vi.fn(async (relative: string): Promise<IcloudFolderListing> => {
      if (relative === '') return listing('', ['A', 'B'])
      if (relative === 'A')
        return new Promise((resolve) => {
          finish = resolve
        })
      return listing(relative, relative === 'B' ? ['B/Nested'] : [])
    })
    const tree = createIcloudFolderTree({ token: () => 'root', fetch })
    await tree.load(tree.root)
    const old = tree.reveal('A/Nested/Deep')
    await Promise.resolve()
    await tree.reveal('B/Nested')
    finish(listing('A', ['A/Nested']))
    await old
    expect(fetch.mock.calls.map(([relative]) => relative)).toEqual(['', 'A', 'B'])
  })
  it('fails closed on mismatched root or directory identity and ignores disposed requests', async () => {
    const tree = createIcloudFolderTree({
      token: () => 'root',
      fetch: async () => listing('wrong', ['Bad'])
    })
    await tree.load(tree.root)
    expect(tree.root).toMatchObject({ status: 'error', error: 'boundary', children: [] })
    let resolve!: (data: IcloudFolderListing) => void
    const other = createIcloudFolderTree({
      token: () => 'root',
      fetch: () =>
        new Promise((done) => {
          resolve = done
        })
    })
    const request = other.load(other.root)
    other.dispose()
    resolve(listing('', ['Late']))
    await request
    expect(other.root.children).toEqual([])
  })
})
