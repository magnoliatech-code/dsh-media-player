/**
 * DSH plugin: a loopback video/audio player for reviewing renders from the Web panel.
 *
 * Configure it in the profile patch:
 *
 *   - insert:
 *       - id: media-player
 *         name: /path/to/dsh-media-player/index.js
 *         config:
 *           root: /path/to/project   # defaults to the directory dsh was launched in
 *           port: 8099
 *           host: 127.0.0.1
 *
 * The listener lives inside the harness process, so it starts with `dsh web`,
 * stops when the harness exits, and can never outlive it as an orphan.
 *
 * The address of that listener also rides into the page as `globalThis.dshMediaPlayer`,
 * which is how the client half (a document-preview renderer) finds the stream.
 */
import { createMediaServer } from './server.js';

export const name = 'media-player';
export const inject = ['webServer'];

/**
 * Start the media server for the lifetime of this plugin entry and publish its
 * address into the page boot payload.
 * @param ctx - plugin context; disposal closes the listener.
 * @param config - `root`, `port`, and `host` overrides.
 */
export function apply(ctx, config) {
  const options = config || {};
  const root = options.root ? String(options.root) : process.cwd();
  const host = options.host ? String(options.host) : '127.0.0.1';
  const port = Number.isInteger(options.port) ? options.port : 8099;

  let announced = { url: `http://${host}:${port}/`, root, port, starting: true };

  ctx.effect(() => {
    const server = createMediaServer({ root, host, port });
    server.start().then((started) => {
      announced = { url: started.url, root: started.root, port: started.port, starting: false };
    }, (error) => {
      console.warn(`[media-player] ${error?.message || error}`);
    });
    return () => server.close();
  }, 'media player listener');

  // The client half reads this instead of guessing a port.
  ctx.effect(() => ctx.on('webserver/index-inject', (table) => {
    table.push({ kind: 'global', name: 'dshMediaPlayer', value: announced });
  }), 'media player boot payload');
}
