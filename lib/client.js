/**
 * Browser half: a document-preview renderer for video and audio.
 *
 * It claims the media suffixes from the Sidebar's text preview, so clicking an
 * `.mp4` or `.mp3` in Files (or a chat link) opens a player tab instead of the
 * "unsupported preview" fallback. Content loading belongs to this renderer
 * (`loading: 'renderer'`), so the preview never reads a gigabyte into memory:
 * the file is resolved to a stream URL on the local media server and handed to
 * the browser's own media element, which fetches only what it plays.
 *
 * Hand-written bundle: the harness loads it through `window.__ModuleLoader__`,
 * and `react` is the only platform module it requests.
 */
window.__ModuleLoader__.load({
  id: 'dsh-media-player',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const React = require('react');
    const h = React.createElement;

    /** This renderer's identity, shared by its registry entry and its body slot key. */
    const RENDERER_ID = 'dsh-media-player/media';
    const VIDEO_EXTENSIONS = ['mp4', 'm4v', 'mov', 'webm', 'mkv', 'ogv'];
    const AUDIO_EXTENSIONS = ['mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'opus', 'weba'];
    const EXTENSIONS = [...VIDEO_EXTENSIONS, ...AUDIO_EXTENSIONS];
    const RATES = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

    /** Base URL of the media server, published by the host half into the boot payload. */
    function mediaBase() {
      const announced = globalThis.dshMediaPlayer;
      const raw = announced && typeof announced.url === 'string' ? announced.url : 'http://127.0.0.1:8099/';
      return raw.endsWith('/') ? raw : raw + '/';
    }

    /** Absolute stream URL for a resolved file. */
    function streamUrl(media) {
      return mediaBase() + String(media.url).replace(/^\//, '');
    }

    /**
     * Ask the media server which file a resource address names.
     * @param address - `dsh-resource://…` address of the open document.
     * @param signal - aborts with the tab or the next revision.
     * @returns `{ path, name, kind, size, mtime, url, absolute }`.
     */
    async function resolveMedia(address, signal) {
      const response = await fetch(mediaBase() + 'api/resolve?address=' + encodeURIComponent(address), {
        signal,
        cache: 'no-store',
      });
      if (!response.ok) {
        let detail = '';
        try {
          const body = await response.json();
          detail = body && body.error ? String(body.error) : '';
        } catch { /* not JSON */ }
        if (response.status === 404) throw new Error(detail || 'not under the player root');
        if (response.status === 409) throw new Error('two files share that name; open it from the player page');
        throw new Error(detail || 'media server answered ' + response.status);
      }
      return response.json();
    }

    /** Last path segment of an address, decoded when it is safe to decode. */
    function lastSegment(address) {
      const raw = String(address).split('/').filter(Boolean).pop() || 'file';
      try { return decodeURIComponent(raw); } catch { return raw; }
    }

    /** Human-readable byte count. */
    function formatBytes(bytes) {
      if (typeof bytes !== 'number') return '';
      if (bytes < 1024) return bytes + ' B';
      if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
      if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
      return (bytes / 1073741824).toFixed(2) + ' GB';
    }

    /** The player body for one open media document. */
    function MediaBody(props) {
      const { tab } = props.useTabInfo();
      const request = props.content && props.content.kind === 'renderer' ? props.content : undefined;
      const revision = request ? request.revision : -1;
      const address = props.resourceAddress;
      const [state, setState] = React.useState({ status: 'loading' });
      const [rate, setRate] = React.useState(1);
      const [gated, setGated] = React.useState(false);
      const [playing, setPlaying] = React.useState(false);
      const mediaRef = React.useRef(null);

      React.useEffect(() => {
        if (!request) return undefined;
        let live = true;
        const controller = new AbortController();
        const onAbort = () => controller.abort();
        setState({ status: 'loading' });
        setGated(false);
        tab.signal.addEventListener('abort', onAbort, { once: true });
        resolveMedia(address, controller.signal).then((media) => {
          if (!live) return;
          setState({ status: 'ready', media });
          try { request.loaded(String(media.mtime)); } catch { /* preview already moved on */ }
        }, (error) => {
          if (!live || controller.signal.aborted) return;
          setState({ status: 'failed', message: error && error.message ? error.message : String(error) });
          try { request.failed(); } catch { /* preview already moved on */ }
        });
        return () => {
          live = false;
          tab.signal.removeEventListener('abort', onAbort);
          controller.abort();
        };
      }, [address, revision, tab.id]);

      const ready = state.status === 'ready' ? state.media : undefined;
      const kind = ready ? ready.kind : 'video';

      // Start playback once the element exists. Browsers refuse unmuted autoplay
      // without a gesture, so video falls back to an explicit gate.
      React.useEffect(() => {
        const element = mediaRef.current;
        if (state.status !== 'ready' || !element) return;
        element.playbackRate = rate;
        element.play().then(() => setGated(false)).catch(() => {
          if (state.media.kind === 'video') setGated(true);
        });
      }, [state.status, ready && ready.path]);

      if (!request) {
        return h('div', { className: 'dmp-root dmp-center' },
          h('p', { className: 'dmp-hint' }, 'This file is not being loaded as media.'));
      }

      if (state.status === 'loading') {
        return h('div', { className: 'dmp-root dmp-center' },
          h('div', { className: 'dmp-pulse', 'aria-hidden': 'true' }),
          h('p', { className: 'dmp-hint' }, 'Resolving ' + lastSegment(address) + '…'));
      }

      if (state.status === 'failed') {
        return h('div', { className: 'dmp-root dmp-center' },
          h('p', { className: 'dmp-error' }, 'Cannot play this file: ' + state.message),
          h('p', { className: 'dmp-hint' }, 'The media player server may be stopped, or the file may sit outside its root.'),
          h('button', {
            className: 'dmp-button',
            type: 'button',
            onClick: (event) => { event.preventDefault(); request.reload(); },
          }, 'Retry'));
      }

      const src = streamUrl(ready);
      const playerLink = mediaBase() + '#play=' + encodeURIComponent(ready.path);

      return h('div', { className: 'dmp-root' },
        h('div', { className: 'dmp-stage' },
          kind === 'audio'
            ? h('div', { className: 'dmp-card' + (playing ? ' dmp-playing' : '') },
                h('div', { className: 'dmp-art', 'aria-hidden': 'true' },
                  h('div', { className: 'dmp-bars' }, [0, 1, 2, 3, 4].map((index) => h('i', { key: index })))),
                h('h2', { className: 'dmp-title', title: ready.path }, ready.name),
                h('p', { className: 'dmp-sub' }, ready.path),
                h('audio', {
                  ref: mediaRef,
                  className: 'dmp-audio',
                  src,
                  controls: true,
                  preload: 'metadata',
                  onPlay: () => setPlaying(true),
                  onPause: () => setPlaying(false),
                  onEnded: () => setPlaying(false),
                }))
            : h('div', { className: 'dmp-frame' },
                h('video', {
                  ref: mediaRef,
                  className: 'dmp-video',
                  src,
                  controls: true,
                  playsInline: true,
                  preload: 'metadata',
                  onPlay: () => setGated(false),
                }),
                gated ? h('button', {
                  className: 'dmp-gate',
                  type: 'button',
                  onClick: (event) => { event.preventDefault(); mediaRef.current?.play(); },
                }, '▶ press to play') : null)),
        h('div', { className: 'dmp-bar' },
          h('span', { className: 'dmp-name', title: ready.absolute || ready.path }, ready.path),
          ready.size ? h('span', { className: 'dmp-chip' }, formatBytes(ready.size)) : null,
          h('label', { className: 'dmp-speed' }, 'speed',
            h('select', {
              className: 'dmp-select',
              value: String(rate),
              onChange: (event) => {
                const next = Number(event.target.value);
                setRate(next);
                if (mediaRef.current) mediaRef.current.playbackRate = next;
              },
            }, RATES.map((value) => h('option', { key: value, value: String(value) }, String(value))))),
          h('a', {
            className: 'dmp-link',
            href: playerLink,
            target: '_blank',
            rel: 'noopener',
            title: 'Open this file in the full player page',
          }, 'open player ↗')));
    }

    const CSS = `
.dmp-root {
  display: flex; flex-direction: column;
  width: 100%; height: 100%; min-height: 320px;
  background: #0d0e10; color: #e7e8ea;
  font: 13px/1.5 ui-sans-serif, -apple-system, "Segoe UI", Inter, Roboto, sans-serif;
  overflow: hidden;
}
.dmp-center { align-items: center; justify-content: center; gap: 10px; text-align: center; padding: 24px; }
.dmp-stage { flex: 1; min-height: 0; display: grid; place-items: center; padding: 12px; position: relative; }
.dmp-frame { position: relative; width: 100%; max-height: 100%; display: grid; place-items: center; }
.dmp-video {
  width: 100%; max-height: 100%; aspect-ratio: 16 / 9; object-fit: contain;
  background: #000; border-radius: 8px;
}
.dmp-gate {
  position: absolute; inset: 0; margin: auto; width: max-content; height: max-content;
  display: flex; align-items: center; gap: 8px;
  background: #1b1e26cc; color: #e7e8ea; border: 1px solid #3a435a; border-radius: 999px;
  padding: 10px 18px; font-size: 13px; cursor: pointer; backdrop-filter: blur(6px);
}
.dmp-gate:hover { border-color: #4d5a7d; background: #232734e6; }
.dmp-card {
  width: min(520px, 100%); text-align: center;
  background: linear-gradient(180deg, #1b1e24, #15171b);
  border: 1px solid #2b2f37; border-radius: 12px; padding: 22px 20px 16px;
}
.dmp-art {
  width: 72px; height: 72px; margin: 0 auto 14px; border-radius: 50%;
  display: grid; place-items: center;
  background: radial-gradient(circle at 30% 25%, #3a4a75, #232a3d 65%, #1b1e26);
  border: 1px solid #39415a;
}
.dmp-bars { display: flex; align-items: flex-end; gap: 3px; height: 26px; }
.dmp-bars i { width: 4px; height: 20%; border-radius: 2px; background: #7aa2ff; opacity: .55; }
.dmp-playing .dmp-bars i { animation: dmp-eq .9s ease-in-out infinite alternate; }
.dmp-bars i:nth-child(2) { animation-delay: .1s; }
.dmp-bars i:nth-child(3) { animation-delay: .2s; }
.dmp-bars i:nth-child(4) { animation-delay: .3s; }
.dmp-bars i:nth-child(5) { animation-delay: .15s; }
@keyframes dmp-eq { from { height: 18%; } to { height: 100%; } }
.dmp-title { font-size: 14px; font-weight: 600; margin: 0 0 2px; word-break: break-all; }
.dmp-sub { color: #9498a0; font-size: 11.5px; margin: 0 0 14px; word-break: break-all; }
.dmp-audio { width: 100%; }
.dmp-bar {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  padding: 8px 12px; border-top: 1px solid #24262c; background: #141619;
}
.dmp-name {
  flex: 1 1 120px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font: 11.5px ui-monospace, SFMono-Regular, Menlo, monospace; color: #b9bec8;
}
.dmp-chip { color: #9498a0; font-size: 11px; border: 1px solid #2b2f37; border-radius: 999px; padding: 1px 7px; }
.dmp-speed { display: flex; align-items: center; gap: 5px; color: #9498a0; font-size: 11px; }
.dmp-select {
  background: #1b1e24; color: #e7e8ea; border: 1px solid #2b2f37;
  border-radius: 6px; padding: 2px 4px; font: inherit;
}
.dmp-link { color: #8fb0ff; font-size: 11px; text-decoration: none; white-space: nowrap; }
.dmp-link:hover { text-decoration: underline; }
.dmp-hint { color: #9498a0; font-size: 12px; margin: 0; max-width: 46ch; }
.dmp-error { color: #ffb4a8; font-size: 13px; margin: 0; max-width: 46ch; }
.dmp-pulse {
  width: 26px; height: 26px; border-radius: 50%;
  border: 2px solid #2b2f37; border-top-color: #7aa2ff;
  animation: dmp-spin .8s linear infinite;
}
@keyframes dmp-spin { to { transform: rotate(360deg); } }
.dmp-button {
  background: #1b1e24; color: #e7e8ea; border: 1px solid #2b2f37;
  border-radius: 7px; padding: 5px 12px; font: inherit; cursor: pointer;
}
.dmp-button:hover { border-color: #43507a; }
`;

    /**
     * Claim the media suffixes and register the player body.
     * @param ctx - client plugin context.
     */
    function apply(ctx) {
      const style = document.createElement('style');
      style.setAttribute('data-dsh-media-player', '');
      style.textContent = CSS;
      ctx.effect(() => {
        document.head.append(style);
        return () => style.remove();
      }, 'media player styles');

      ctx.effect(() => ctx.documentPreviews.register({
        id: RENDERER_ID,
        extensions: EXTENSIONS,
        binaryExtensions: EXTENSIONS,
        priority: 'extension',
        title: () => 'Player',
        loading: 'renderer',
        wrap: false,
      }), 'media player renderer');

      ctx.effect(() => ctx.slots.inject('sidebar.right.tab.document', () => ctx.slots.register({
        name: 'sidebar.right.tab.document',
        key: RENDERER_ID,
      }, MediaBody)), 'media player body');
    }

    exports.apply = apply;
    exports.inject = ['slots', 'documentPreviews'];
    // Exposed for the mount probe in tests/ and for in-browser debugging.
    exports.MediaBody = MediaBody;
    return module.exports;
  },
});
