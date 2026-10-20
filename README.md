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
and the new one binds — about 2.2 s here. No harness restart needed.

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

Endpoints: `/` player page, `/api/media` playlist JSON, `/api/health` liveness,
`/m/<path>` and `/<path>` media with `Range` support.

## Playlist

Scans `root` (depth ≤ 8, skipping `node_modules`, `.git`, `dist`, `.cache`, max 5000
files) for `mp4 m4v mov webm mkv ogv mp3 m4a aac wav flac ogg opus`, grouped by
directory, newest first, cached for 2.5 s. Scratch folders (`_*`, `raw`, `wav`) are
hidden until **include scratch folders** is ticked; a filter query searches
everything.

Keys: `space` · `←/→` 5 s · `J/L` 10 s · `↑/↓` volume · `M` mute · `F` fullscreen
(blocked inside the sandboxed Sidebar frame — use `open tab ↗`) · `N/P` next/previous
· `0–9` tenths. Speed 0.5×–2×, and the playhead per file is kept in `localStorage`.

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
