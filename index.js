/**
 * DSH plugin: a loopback video/audio player for reviewing renders from the Web panel.
 *
 * Configure it in the profile patch:
 *
 *   - name: dsh-media-player
 *     config:
 *       root: /path/to/project   # defaults to the directory dsh was launched in
 *       port: 8099
 *       host: 127.0.0.1
 *
 * The listener lives inside the harness process, so it starts with `dsh web`,
 * stops when the harness exits, and can never outlive it as an orphan.
 */
import { createMediaServer } from './server.js';

export const name = 'media-player';

/**
 * Start the media server for the lifetime of this plugin entry.
 * @param ctx - plugin context; disposal closes the listener.
 * @param config - `root`, `port`, and `host` overrides.
 */
export function apply(ctx, config) {
  const options = config || {};
  const root = options.root ? String(options.root) : process.cwd();
  const host = options.host ? String(options.host) : '127.0.0.1';
  const port = Number.isInteger(options.port) ? options.port : 8099;

  ctx.effect(() => {
    const server = createMediaServer({ root, host, port });
    server.start().catch((error) => {
      console.warn(`[media-player] ${error?.message || error}`);
    });
    return () => server.close();
  }, 'media player listener');
}
