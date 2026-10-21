# Changelog

## v0.2.1

- Explain a decode failure instead of showing a dead frame. Chromium refuses some
  claimed containers (`.mkv`, Theora); the overlay names the limit and points at the
  full player or VLC.

## v0.2.0

- Media files open in the Sidebar: a document-preview renderer claims the video and
  audio suffixes at the `extension` band, replacing the "preview is not available"
  fallback.
- Content loading stays with the renderer, so a multi-gigabyte master is never read
  into memory; `/api/resolve` maps a resource address, absolute path, or
  workspace-relative path to a stream URL.
- The host half publishes its address as `globalThis.dshMediaPlayer`, so the browser
  half never guesses a port.
- JSON endpoints answer loopback origins only.
- `test/smoke.mjs` covers the registration and render trees.

## v0.1.1

- The idle panel no longer renders underneath the player.
- Video arrivals show a press-to-play gate when the browser refuses autoplay; audio
  keeps its native controls.
- The video frame reserves a 16:9 box instead of popping in at 300×150.
- The playing file stays listed under any filter, so a shared link shows its row.

## v0.1.0

- First release: range-streaming media server, playlist page, per-file playhead
  memory, speed control, deep links, and a harness-owned listener.
