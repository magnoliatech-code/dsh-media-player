# dsh-media-player

A loopback video/audio player for reviewing renders from the DSH Web panel, owned by
the harness process. It starts with `dsh web`, stops when the harness exits, and
cannot outlive it as an orphan because the HTTP listener lives in the harness's own
process — no child process, no PID to manage.

Runs as **your** user (uid 1000 here), never root: the harness is your process.

## Where it is wired in

`~/.dsh/profiles/web/cordis.patch.yml`:

```yaml
- insert:
    - id: media-player
      name: /home/chen/.local/share/dsh-media-player/index.js
      config:
        root: /home/chen/Projects/deepseek
        port: 8099
```

Two constraints worth remembering:

- A new entry needs an **`insert:` list**. A bare `- id: …` only overrides an entry
  that already exists; on its own it warns `patch: entry "…" not found` and loads
  nothing.
- `name` may be an absolute path. The loader turns it into a `file://` URL, so no
  `pnpm add`, no profile dependency, and no build step is involved.

Editing that file is picked up by HMR: the entry restarts, the old listener closes,
and the new one binds — about 2.2 s here. No harness restart needed for config; the
plugin's own code is a different story (see [Two halves](#two-halves)).

## Two halves

**Host** (`index.js`, `server.js`) owns the loopback HTTP listener and publishes its
address into the page as `globalThis.dshMediaPlayer`, through the webserver's
`index-inject` event, so the browser half never guesses a port.

**Client** (`lib/client.js`) is a document-preview renderer. It claims
`mp4 m4v mov webm mkv ogv mp3 m4a aac wav flac ogg opus weba` at the `extension`
priority band, so clicking a media file in Files — or a chat link to one — opens a
player tab instead of the "preview not available" fallback. It registers with
`loading: 'renderer'`, which means the shared preview never reads the file: the
renderer asks `/api/resolve` for a stream URL and hands it to the browser's own
`<video>`/`<audio>`. Tab header, reload, and open-in-app keep working.

Changes to either half need a **harness restart** (`dsh web`): a patch edit reloads
the plugin entry, but Node caches the imported ES module, so the host code only
changes on a new process. The client bundle is fetched on page load, so a page
reload is enough for it.

## Config

| Field | Default | Meaning |
| --- | --- | --- |
| `root` | `process.cwd()` of the harness | Directory scanned and served |
| `port` | `8099` | Loopback TCP port |
| `host` | `127.0.0.1` | Bind address |

`root` is pinned above on purpose: the harness here was launched from
`/home/chen/Projects/deepseek`, and pinning keeps the playlist stable regardless of
where you start it next.

## Use it

- In the harness: right Sidebar → **Browser** → `http://127.0.0.1:8099/`.
- Outside: open the same URL in any browser; it is not tied to the harness session.
- Standalone, with the harness stopped: `node bin/media-player.js --root DIR --port N`.

### Deep links

`#play=<path>` opens the player on one file. The path may be relative to the served
root or an absolute filesystem path, and selecting a file in the UI rewrites the
fragment, so the address bar is always shareable:

```
http://127.0.0.1:8099/#play=ai_documentary/output/voice_audition/M1_UncleFu.mp3
http://127.0.0.1:8099/#play=/home/chen/Projects/deepseek/ai_documentary/output/voice_audition/M1_UncleFu.mp3
```

Browsers refuse unmuted autoplay without a gesture, so an arrival through a link
shows a **press to play** gate over video. Audio keeps its native controls instead.
The linked file stays listed whatever filter is active, so its row is always visible.

Endpoints: `/` player page, `/api/media` playlist JSON, `/api/health` liveness,
`/api/resolve?address=…` (or `?path=…`) mapping a resource address or path to a
stream URL, then `/m/<path>` and `/<path>` media with `Range` support. JSON
endpoints answer loopback `Origin`s only, so the harness page on another local port
can read them while a public site cannot.

## Playlist

Scans `root` (depth ≤ 8, skipping `node_modules`, `.git`, `dist`, `.cache`, max 5000
files) for `mp4 m4v mov webm mkv ogv mp3 m4a aac wav flac ogg opus`, grouped by
directory, newest first, cached for 2.5 s. Scratch folders (`_*`, `raw`, `wav`) are
hidden until **include scratch folders** is ticked; a filter query searches
everything.

Keys: `space` · `←/→` 5 s · `J/L` 10 s · `↑/↓` volume · `M` mute · `F` fullscreen
(blocked inside the sandboxed Sidebar frame — use `open tab ↗`) · `N/P` next/previous
· `0–9` tenths. Speed 0.5×–2×, and the playhead per file is kept in `localStorage`.

## Tests

```
node test/smoke.mjs
```

Loads the bundle the way the harness does and checks the renderer registration,
the video/audio render trees, the stream URLs, and the failure state.

## Exposure

Loopback only. Only media and subtitle suffixes are served, so source files and
secrets under `root` answer 404. Requests whose `Host` header is not the loopback
name plus the bound port are rejected, which defeats DNS rebinding. A second
`dsh web` instance logs `media-player: 127.0.0.1:8099 is already in use` and keeps
everything else working.

## Keeping it up without the harness

A harness-owned listener is down whenever the harness is. If you want the player
always available instead, run `bin/media-player.js` as a user service:

```ini
# ~/.config/systemd/user/dsh-media.service
[Unit]
Description=DSH media player (loopback)

[Service]
ExecStart=/usr/bin/node %h/.local/share/dsh-media-player/bin/media-player.js --root %h/Projects/deepseek --port 8099
Restart=on-failure

[Install]
WantedBy=default.target
```

```sh
systemctl --user daemon-reload && systemctl --user enable --now dsh-media.service
```

Pick one owner for the port — the plugin and the service cannot both bind 8099.
