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

- **Windows:** 10 or later (x64). The installer upgrades an existing installation in place.
- **macOS:** 12 or later, signed with a Developer ID certificate and notarized by Apple. Intel Mac support is planned through summer 2027.
- No official Linux release.

macOS installs from 1.2.8 onward update in place: check for updates, download, and the app installs the new build and restarts. Coming from 1.2.7 or earlier, replace the app once by hand (quit the old version, drag Track Studio into Applications, choose Replace); after that, updates stay inside the app. Large components such as the base Stem models and the rekordbox environment download on demand, so the installer stays small.

Already using FRKB? Track Studio keeps the same installation, settings, and music library.

## What You Can Do

- **Organize real files:** Build Filter, Curated, and SET playlists; move or merge libraries; restore deleted tracks from the recycle bin.
- **Find and understand tracks:** Deduplicate by audio content, analyze BPM, key, energy, and sections, and fill metadata and cover art.
- **Pull in NetEase Cloud Music:** Sign in inside the app and browse liked tracks, your own playlists, saved playlists, and saved albums. Download tracks at lossless or master quality, or copy them into Filter, Curated, SET, or Mixtape, with fingerprint matching to skip duplicates.
- **Choose compatible tracks:** Filter with a Camelot key wheel or match the current Master deck's key. Keep sorting, columns, and filters per playlist, and check the total duration of selected tracks.
- **Repair BPM drift:** Analyze selected local tracks and correct drifting audio to a chosen steady BPM. Save a new version or overwrite the original after verification.
- **Listen and edit:** Browse RGB waveforms, audition two decks side by side, record mixes, and edit a track’s audio without leaving the app.
- **Work with DJ libraries:** Browse Rekordbox desktop and USB libraries, Serato crates, and Traktor collections. Edit playlists, cues, and beat grids on supported Rekordbox USB drives.
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
