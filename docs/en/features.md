# Track Studio Features

A detailed reference for Track Studio’s library, playback, analysis, and preparation tools. [简体中文](../features.md)

## Library Organization

- **Real file management**: Track Studio manages the audio files themselves, so playlists and library folders stay reflected on disk.
- **Filter and Curated libraries**: A two-stage DJ workflow for fast triage and long-term selection.
- **SET playlists**: Prepare performance sets as mapping-based playlists that support duplicate entries, stable track indices, drag reordering, and deletion protection for referenced source tracks.
- **SET duration**: Estimate SET length in playlist order, using Hot Cues as start and end points when available.
- **Merge Track Studio libraries**: Merge another Track Studio library into the current one, including playlists, tracks, analysis, SET, and Mixtape data, without modifying the source library. Integrity and disk space are checked first, and same-name playlists are kept on both sides. Curated libraries can also be merged separately.
- **Move Track Studio library**: Relocate the current Track Studio library to a new folder, including same-disk and cross-disk transfers with resume. Settings can also open the library folder in Explorer or Finder.
- **Playlist tree sorting**: Sort the playlist tree by name or track count, or switch back to manual order.
- **Drag-and-drop import and movement**: Import files or folders, move tracks between playlists, and drag copies out to Explorer/Finder with Ctrl/Option.
- **Safe recycle bin**: Deleted tracks and deduplicated items go to Track Studio's recycle bin and can be restored to their original playlists.
- **Playlist cleanup tools**: Clear playlists with visible progress, batch rename playlist tracks, clean missing external-library records, and keep selection counts visible before bulk operations.
- **Portable library state**: Library data can be moved with the music collection for use across devices.

## Deduplication, Analysis, And Metadata

- **Song deduplication**: Detect duplicate tracks by content hash or whole-file hash. Content hash mode ignores metadata differences such as cover art, title, and artist.
- **Playlist fingerprint deduplication**: Analyze a playlist and move duplicates to the recycle bin in one workflow.
- **BPM and beat-grid analysis**: Analyze tempo and grid placement, tap BPM manually, restore system-analyzed BPM, and work with stricter grid candidate rules for difficult tracks.
- **Key analysis**: Display musical key in Classic notation such as `C#m` or Camelot notation such as `1A/1B`.
- **Energy and section analysis**: View and filter tracks by overall energy, dancefloor energy, danceability, and other measures; use analyzed sections for range playback.
- **Locate unanalyzed tracks**: Jump from the bottom status bar to the first track that still needs analysis.
- **Visible analysis progress**: Track-level analysis status is surfaced in the song list instead of leaving background work invisible.
- **Manual analysis control**: Playlist analysis can be confirmed, skipped, or started manually, so imported crates do not unexpectedly consume foreground playback resources.
- **Fingerprint library scanning**: Build a reusable fingerprint library from selected libraries to make future deduplication and similar-track workflows faster and more consistent.
- **External-source analysis cache**: Rekordbox desktop and USB libraries, Serato, and ordinary external tracks can reuse cached analysis data instead of repeatedly reprocessing the same files.
- **Metadata editing and online fill**: Edit tags and cover art, search MusicBrainz, use AcoustID/Chromaprint matching, and batch-fill metadata.
- **Native Chromaprint fingerprinting**: AcoustID fingerprint generation runs through the native module for lower overhead during metadata matching.

## Playback And Waveforms

- **Wide format playback**: Built-in media tooling supports common and professional audio formats without sending files through another app first.
- **Selectable playback range**: Start and stop playback within a chosen section when only part of a track needs to be checked.
- **Browser-mode mini player**: Open a compact player window from browser mode, with range playback, waveform seeking, cover actions, and deleting tracks above the current song.
- **Output device selection**: Play through a selected audio device or follow the system default.
- **RGB waveform visualization**: The player, list previews, and single-track editing all use RGB three-band energy waveforms, with a half/full height option.
- **Large waveform browsing**: Dual-track and edit-mode waveforms support precise seeking, cue placement, grid inspection, and smooth redraw during playback.
- **Single-track audio editing**: Cut, copy, paste, and repeat audio, with undo and redo; save over the original track or create a new version.
- **Lightweight waveform caches**: RGB display data and surface-specific caches keep large waveforms, list previews, and Mixtape timelines responsive across repeat visits.
- **Title-bar audio visualization**: Monitor playback energy from the title bar without giving up screen space.
- **File association and external playback**: Open supported audio files from the system and audition them temporarily without importing them into the library.
- **Global shortcuts**: Control playback while the window is minimized, with configurable show/hide behavior.

## Dual-Deck Browse Mode

- **Side-by-side auditioning**: Browse two tracks at once in a DJ mixer-style interface.
- **Deck controls**: Each deck has transport controls, waveform display, Hot Cue, Memory Cue, Loop, Quantize, and beat-grid tools.
- **Mixer controls**: Use independent deck volume faders, channel controls, and a crossfader to judge transitions quickly.
- **Beat Sync and Master behavior**: Sync tempo and grid behavior between decks while keeping visible waveform scale stable.
- **Tempo nudge**: Temporarily push a deck faster or slower with hold controls, then return cleanly to the base tempo.
- **Temporary tempo**: Temporarily change a deck's tempo during dual-deck auditioning without writing back to the source file.
- **Auto Gain**: Match deck loudness against the current master so A/B comparisons are not distorted by level differences.
- **Cue monitoring**: Monitor cue output per deck while preparing comparisons.
- **Recording**: Record the dual-deck output to high-quality WAV and save it directly into the Recording Library.
- **Monitor-only metronome**: Use the beat-grid metronome while listening without printing the metronome into recorded audio.

## Recording Library

- **Dedicated recording area**: Recordings are stored in a separate Recording Library instead of being mixed into the normal organization flow.
- **High-quality WAV output**: Recordings are saved as uncompressed WAV with the current output device sample rate.
- **Live duration display**: The recording control shows millisecond-level duration while recording.
- **Post-recording summary**: After stopping, Track Studio shows the saved file name, format, duration, and path.
- **Analysis isolation**: Recording-library files are excluded from normal background analysis candidates so fresh recordings do not steal resources from library work.

## Rekordbox Desktop And USB Library Integration

- **Local Rekordbox database browsing**: Read Rekordbox playlists directly without manually exporting XML first.
- **Cue and Loop support**: Read Hot Cues, Memory Cues, and Loop data from Rekordbox desktop and USB libraries and preserve them when copying into local Track Studio libraries.
- **Rekordbox playlist operations**: Browse playlists, reorder tracks, create or move playlist nodes where supported, and export Rekordbox XML.
- **USB library support**: Read Device Library and OneLibrary structures, including playlist trees, waveform previews, multiple drives, and track playback.
- **External-library context menus**: Use familiar right-click actions on Rekordbox desktop and USB tracks, including copying to Filter or Curated libraries.
- **Keyboard multi-selection**: Select multiple songs in Rekordbox desktop and USB libraries with keyboard-style range selection.
- **Curated artist import**: Import curated artist data from Rekordbox desktop and USB libraries to keep selection tags useful across sources.
- **Read-only analysis for external tracks**: Analyze BPM, beat grid, energy, and sections for Rekordbox desktop and USB libraries, Serato, and ordinary external tracks. Results stay inside Track Studio and are not written back to the source library.
- **Missing-file handling**: Missing source files are clearly marked, blocked from playback, and can be cleaned from Rekordbox playlist records when appropriate.

## Serato Library Integration

- **Serato library browsing**: Detect a local Serato library and browse its folders, crates, playlists, and tracks inside Track Studio.
- **Serato playlist editing**: Create, rename, delete, reorder, and move folders and playlists, and remove entries from playlists while keeping the audio files.
- **Serato track writing**: Write selected Track Studio tracks to a Serato playlist. Track Studio can keep dedicated Serato copies so the Serato library remains usable when the original files move.
- **Serato playback data**: Read Serato metadata, waveform previews, Hot Cues, Memory Cues, and Loops for browsing and auditioning.

## Mixtape And Stem Workflow

- **Mixtape timeline workspace**: Arrange tracks on a timeline, preview transitions, edit beat alignment, and export a timeline-accurate result.
- **Cross-window track drag-in**: Drag songs from the main library directly into the Mixtape workspace.
- **Add to Mixtape from playlists**: Add tracks to Mixtape auto-recording from ordinary playlist context menus.
- **Beat alignment tools**: Adjust grids, preview alignment on unified waveform controls, use metronome tools, and keep timeline playback aligned with edited grid data.
- **Gain, BPM, mute, and loop controls**: Shape the mix with timeline controls, envelopes, mute sections, loop overlays, and undo support.
- **Stem preparation**: Managed Stem runtime, separation cache management, ONNX fast separation, and DirectML/XPU acceleration support auto-recording and mix preparation workflows.
- **Single-track Stem workspace**: Separate a single track into high-quality 4 stems (vocals / drums / bass / other), preview and export WAV files, and download the ultra-quality model when needed.

## Export, Conversion, And Formats

- **Track export**: Export selected tracks to a folder and optionally delete the source entries after export.
- **Persistent export destination**: Export dialogs remember the last destination and validate that it still exists.
- **Standalone conversion**: Convert audio files without first importing them into the main library.
- **Batch conversion with cancel**: Long conversion jobs show progress, can be canceled, and summarize completed, skipped, failed, and canceled items.
- **One-click MP3 conversion**: Convert non-MP3 tracks from the context menu while skipping existing converted copies.

**Scan, playback, and conversion formats:** `MP3`, `WAV`, `FLAC`, `AIF`, `AIFF`, `OGG`, `OPUS`, `AAC`, `M4A`, `MP4`, `WMA`, `AC3`, `DTS`, `MKA`, `WEBM`, `APE`, `TAK`, `TTA`, `WV`.

## Search, Discovery, And Sync

- **Global track search**: Search across the app and jump back to the matching location.
- **Song filtering**: Filter by title, artist, album, duration, format, BPM, date added, and more, with optional persistence after restart. Date-added supports a between-date range.
- **NetEase Cloud search**: Search the selected track on NetEase Cloud Music from the context menu.
- **Spotify search**: Search by track title, artist, or album, opening the Spotify desktop app when available or the web search otherwise.
- **Similar tracks query**: Query multiple sources for tracks with a similar vibe, launch recommendations from library menus, and hide tracks you no longer want suggested.
- **Cloud fingerprint sync**: Sync local SHA256 fingerprints with the Track Studio cloud backend, including diff analysis, paginated pulls, batched uploads, quotas, rate limiting, clear summaries, and a minimizable progress window.
- **Curated library cloud sync**: Sync the Curated library's folder tree, playlists, and audio. Choose how to align both sides when connecting for the first time; later changes sync automatically in both directions.
- **Curated artist sync**: Split and link multi-artist tracks and sync curated artist data across devices.

## Interface And Personalization

- **Custom accent color**: Choose a preset in Settings or use the color picker to set your own theme accent.
- **Internationalization**: Built-in Simplified Chinese and English language packs.
