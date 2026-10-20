/**
 * HTTP media server with Range support.
 *
 * Serves one player page plus the video/audio files under `root`, so a large
 * render streams and seeks instead of being read into memory. Loopback only by
 * default: foreign Host headers are refused, and only media/subtitle suffixes
 * are reachable.
 */
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat, readdir, realpath, readFile } from 'node:fs/promises';
import { extname, join, resolve, sep, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

const TYPES = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime',
  '.webm': 'video/webm', '.mkv': 'video/x-matroska', '.ogv': 'video/ogg',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac',
  '.wav': 'audio/wav', '.flac': 'audio/flac', '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg; codecs=opus', '.weba': 'audio/webm',
  '.srt': 'text/plain; charset=utf-8', '.vtt': 'text/vtt; charset=utf-8',
};
const VIDEO = new Set(['mp4', 'm4v', 'mov', 'webm', 'mkv', 'ogv']);
const AUDIO = new Set(['mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'opus', 'weba']);
const MEDIA = new Set([...VIDEO, ...AUDIO]);
const SERVABLE = new Set([...MEDIA, 'srt', 'vtt']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.cache']);
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/** Whether a browser Origin is itself loopback, so CORS never widens beyond the machine. */
function isLoopbackOrigin(origin) {
  try { return LOOPBACK_HOSTS.has(new URL(origin).hostname); } catch { return false; }
}

/** Allow the harness page (a different loopback port) to read the JSON API. */
function applyCors(req, res) {
  const origin = req.headers.origin;
  if (typeof origin !== 'string' || !isLoopbackOrigin(origin)) return;
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD');
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

/**
 * Create the media server.
 * @param options.root - directory whose media files are listed and served.
 * @param options.host - bind address; defaults to loopback.
 * @param options.port - TCP port; 0 asks the OS for one.
 * @returns A handle with `start()`, `close()`, and the announced `url`.
 */
export function createMediaServer({ root, host = '127.0.0.1', port = 8099, log = console } = {}) {
  const rootDir = resolve(root || process.cwd());
  let server;
  let boundPort = port;
  const allowedHosts = () => new Set([
    `127.0.0.1:${boundPort}`, `localhost:${boundPort}`, `[::1]:${boundPort}`,
  ]);

  /** Resolve a URL path to a file inside rootDir, or null when it escapes. */
  async function resolveInside(relPath) {
    let decoded;
    try { decoded = decodeURIComponent(relPath); } catch { return null; }
    const target = resolve(rootDir, '.' + sep + decoded);
    if (target !== rootDir && !target.startsWith(rootDir + sep)) return null;
    try { return await realpath(target); } catch { return null; }
  }

  async function walk(dir, out, depth = 0) {
    if (depth > 8 || out.length > 5000) return;
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.isDirectory()) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        await walk(full, out, depth + 1);
        continue;
      }
      const ext = extname(entry.name).slice(1).toLowerCase();
      if (!MEDIA.has(ext)) continue;
      try {
        const s = await stat(full);
        out.push({
          path: full.slice(rootDir.length + 1).split(sep).join('/'),
          name: entry.name,
          size: s.size,
          mtime: Math.round(s.mtimeMs),
          kind: VIDEO.has(ext) ? 'video' : 'audio',
        });
      } catch { /* vanished mid-scan */ }
    }
  }

  let indexCache = { at: 0, value: null };

  /** Encode one relative media path as a stream URL. */
  const streamPath = (rel) => '/m/' + rel.split('/').map(encodeURIComponent).join('/');

  /**
   * Map a resource address (`dsh-resource://file/session/<id>/<path>`) or a plain
   * path — absolute or workspace-relative — onto one indexed media file.
   * @param input - address or path as the caller knows it.
   * @returns `found`, `ambiguous`, `missing`, or `invalid`.
   */
  async function resolveMediaFile(input) {
    if (typeof input !== 'string' || input.length === 0) return { kind: 'invalid' };
    let raw = input;
    if (raw.startsWith('dsh-resource:')) {
      try { raw = new URL(raw).pathname; } catch { /* not a URL; use the raw text */ }
    }
    try { raw = decodeURIComponent(raw); } catch { /* keep the raw text */ }
    const segments = raw.split('/').filter(Boolean);
    const files = await mediaIndex();
    const byPath = new Map(files.map((file) => [file.path, file]));
    const rootName = rootDir.replace(/^\/+/, '');
    for (let i = 0; i < segments.length; i += 1) {
      const candidate = segments.slice(i).join('/');
      const normalized = candidate.startsWith(rootName + '/') ? candidate.slice(rootName.length + 1) : candidate;
      if (byPath.has(normalized)) return { kind: 'found', file: byPath.get(normalized) };
    }
    // Workspace-relative addresses have no server-root prefix; match by unique suffix.
    for (let i = 0; i < segments.length; i += 1) {
      const candidate = segments.slice(i).join('/');
      const matches = files.filter((file) => file.path.endsWith('/' + candidate));
      if (matches.length === 1) return { kind: 'found', file: matches[0] };
      if (matches.length > 1) {
        const recent = matches.slice(0, 8).map((file) => file.path);
        return { kind: 'ambiguous', matches: recent };
      }
    }
    return { kind: 'missing' };
  }

  async function mediaIndex() {
    // The page polls; a directory walk per poll would be wasteful on a large root.
    if (indexCache.value && Date.now() - indexCache.at < 2500) return indexCache.value;
    const files = [];
    await walk(rootDir, files);
    files.sort((a, b) => b.mtime - a.mtime || a.path.localeCompare(b.path));
    indexCache = { at: Date.now(), value: files };
    return files;
  }

  async function handle(req, res) {
    if (!allowedHosts().has((req.headers.host || '').toLowerCase())) return send(res, 403, 'forbidden host');
    const url = new URL(req.url, 'http://' + req.headers.host);
    const pathname = url.pathname;
    if (pathname.startsWith('/api/')) applyCors(req, res);

    if (pathname === '/' || pathname === '/player') {
      const html = await readFile(join(HERE, 'player.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(html);
    }

    if (pathname === '/api/media') {
      const files = await mediaIndex();
      return send(res, 200, JSON.stringify({ root: rootDir, files }), {
        'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
      });
    }

    if (pathname === '/api/health') {
      return send(res, 200, JSON.stringify({ ok: true, pid: process.pid, root: rootDir, port: boundPort }), {
        'Content-Type': 'application/json; charset=utf-8',
      });
    }

    if (pathname === '/api/resolve') {
      const target = url.searchParams.get('address') || url.searchParams.get('path') || '';
      const result = await resolveMediaFile(target);
      if (result.kind === 'found') {
        const { file } = result;
        return send(res, 200, JSON.stringify({
          path: file.path,
          name: file.name,
          kind: file.kind,
          size: file.size,
          mtime: file.mtime,
          url: streamPath(file.path),
          absolute: join(rootDir, file.path),
          root: rootDir,
        }), { 'Content-Type': 'application/json; charset=utf-8' });
      }
      if (result.kind === 'ambiguous') {
        return send(res, 409, JSON.stringify({ error: 'ambiguous path', matches: result.matches }), {
          'Content-Type': 'application/json; charset=utf-8',
        });
      }
      return send(res, 404, JSON.stringify({ error: result.kind === 'invalid' ? 'no path given' : 'not under the media root' }), {
        'Content-Type': 'application/json; charset=utf-8',
      });
    }

    if (pathname === '/favicon.ico') return send(res, 204, '');

    const rel = pathname.replace(/^\/(m|file)\//, '').replace(/^\//, '');
    const file = await resolveInside(rel);
    if (!file) return send(res, 404, 'not found');

    let info;
    try { info = await stat(file); } catch { return send(res, 404, 'not found'); }
    if (info.isDirectory()) return send(res, 404, 'is a directory');

    const ext = extname(file).toLowerCase().slice(1);
    // Only media and subtitle files are served; source text and secrets stay unreachable.
    if (!SERVABLE.has(ext)) return send(res, 404, 'not a media file');

    const type = TYPES['.' + ext] || 'application/octet-stream';
    const etag = `W/"${info.size.toString(16)}-${Math.round(info.mtimeMs).toString(16)}"`;
    if (req.headers['if-none-match'] === etag) return send(res, 304, '');

    const base = {
      'Content-Type': type,
      'Accept-Ranges': 'bytes',
      'ETag': etag,
      'Last-Modified': info.mtime.toUTCString(),
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    };

    if (req.method === 'HEAD') {
      res.writeHead(200, { ...base, 'Content-Length': info.size });
      return res.end();
    }

    const range = req.headers.range;
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
      if (!m) return send(res, 400, 'bad range');
      let start = m[1] === '' ? null : Number(m[1]);
      let end = m[2] === '' ? null : Number(m[2]);
      if (start === null && end === null) return send(res, 400, 'bad range');
      if (start === null) { start = Math.max(0, info.size - end); end = info.size - 1; }
      else if (end === null) end = info.size - 1;
      if (start > end || start >= info.size) {
        return send(res, 416, 'range not satisfiable', { 'Content-Range': `bytes */${info.size}` });
      }
      end = Math.min(end, info.size - 1);
      res.writeHead(206, {
        ...base,
        'Content-Range': `bytes ${start}-${end}/${info.size}`,
        'Content-Length': end - start + 1,
      });
      if (req.method === 'HEAD') return res.end();
      const stream = createReadStream(file, { start, end });
      return pipe(stream, res);
    }

    res.writeHead(200, { ...base, 'Content-Length': info.size });
    if (req.method === 'HEAD') return res.end();
    return pipe(createReadStream(file), res);
  }

  /** Stream a file and release its descriptor when either side stops. */
  function pipe(stream, res) {
    stream.on('error', () => res.destroy());
    // A paused tab or a seek aborts the response; do not leak the read stream.
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  }

  return {
    /** @returns The announced player URL once listening. */
    async start() {
      server = createServer((req, res) => {
        handle(req, res).catch((error) => {
          if (!res.headersSent) send(res, 500, 'internal error');
          else res.destroy();
          log.warn?.(`[media-player] ${req.method} ${req.url}: ${error?.message || error}`);
        });
      });
      server.on('clientError', (_error, socket) => {
        if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      });
      for (let attempt = 0; ; attempt += 1) {
        try {
          await new Promise((resolveListen, rejectListen) => {
            const onError = (error) => { server.off('listening', onListening); rejectListen(error); };
            const onListening = () => { server.off('error', onError); resolveListen(); };
            server.once('error', onError);
            server.once('listening', onListening);
            server.listen(port, host);
          });
          break;
        } catch (error) {
          // A reload can overlap the previous listener's close; retry briefly.
          if (error?.code === 'EADDRINUSE' && attempt < 10) {
            await new Promise((r) => setTimeout(r, 200));
            continue;
          }
          throw new Error(
            error?.code === 'EADDRINUSE'
              ? `media-player: ${host}:${port} is already in use by another process`
              : `media-player: cannot listen on ${host}:${port}: ${error?.message || error}`,
            { cause: error },
          );
        }
      }
      boundPort = server.address().port;
      const url = `http://${host}:${boundPort}/`;
      log.info?.(`[media-player] ${url}  root=${rootDir}`);
      return { url, root: rootDir, port: boundPort };
    },

    /** Stop listening and drop open streams. */
    async close() {
      if (!server) return;
      const closing = server;
      server = undefined;
      closing.closeAllConnections?.();
      await new Promise((done) => closing.close(() => done()));
    },
  };
}
