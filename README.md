<div align="center">
  <img src="./docs/public/assets/icon.webp" alt="Track Studio icon" width="88">
  <h1>Track Studio</h1>
  <p>Organize real audio files. Preview, analyze, and prepare music in one desktop workspace.</p>
  <p><a href="./README.md">English</a> · <a href="./readme/README_CN.md">简体中文</a></p>
  <p><a href="https://github.com/coderDJing/Track-Studio/releases/latest">Download</a> · <a href="https://coderDJing.github.io/Track-Studio/">Website</a> · <a href="./docs/en/features.md">All features</a></p>
</div>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: light)" srcset="./docs/public/assets/softwareScreenshot_light.webp">
    <img src="./docs/public/assets/softwareScreenshot.webp" alt="Track Studio main window" width="960">
  </picture>
</p>

Track Studio helps DJs and music collectors organize large collections without losing track of the files on disk. Library and playlist changes follow the real audio files, so the result remains usable outside the app.

## Download

Get the latest [Windows and macOS installers](https://github.com/coderDJing/Track-Studio/releases/latest), or visit the [website](https://coderDJing.github.io/Track-Studio/).

- **Windows:** 10 or later (x64)
- **macOS:** 12 or later. Intel Mac support is planned through summer 2027.
- No official Linux release.

Already using FRKB? Track Studio updates the same installation and keeps your settings and music library. [Read the rename note](./docs/en/frkb.md).

## What You Can Do

- **Organize real files:** Build Filter, Curated, and SET playlists; move or merge libraries; restore deleted tracks from the recycle bin.
- **Find and understand tracks:** Deduplicate by audio content, analyze BPM, key, energy, and sections, and fill metadata and cover art.
- **Listen and edit:** Browse RGB waveforms, audition two decks side by side, record mixes, and edit a track’s audio without leaving the app.
- **Work with DJ libraries:** Browse Rekordbox desktop and USB libraries and Serato crates, with playlist and cue workflows for each supported source.
- **Sync your collection:** Keep the Curated library’s folders, playlists, and audio aligned across devices; sync fingerprints and curated artists.
- **Prepare mixes:** Arrange Mixtape timelines, adjust transitions, and prepare or export single-track Stems.

See the [complete feature guide](./docs/en/features.md) for workflows, supported formats, and the full capability list.

## Development

```bash
pnpm install
pnpm run dev
pnpm run build:win # Windows
pnpm run build:mac # macOS
```

To build the Rust native module separately:

```bash
pnpm add -g @napi-rs/cli
cd rust_package
napi build --platform --release
```

## Project and Contribution

Track Studio grew out of a DJ workflow: sort music quickly, hear it, move the real files, and keep the library useful outside the app. Issues, feature suggestions, and pull requests are welcome.

- [Planned work](./backlog.md)
- [Cloud sync backend (FRKB-API)](https://github.com/coderDJing/FRKB-API)
- **License:** Project code by CoderDJing uses the [PolyForm Noncommercial License 1.0.0](./LICENSE). Packaged builds include GPL/LGPL components; see [third-party notices](./THIRD_PARTY_NOTICES.md).
