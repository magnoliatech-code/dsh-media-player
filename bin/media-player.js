#!/usr/bin/env node
/**
 * Standalone launcher, for when the harness is not running.
 *
 *   node bin/media-player.js [--root DIR] [--port N] [--host ADDR]
 */
import { createMediaServer } from '../server.js';

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const server = createMediaServer({
  root: arg('root', process.cwd()),
  port: Number(arg('port', process.env.PORT || 8099)),
  host: arg('host', '127.0.0.1'),
});

const { url } = await server.start();
console.log(`player: ${url}`);
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    await server.close();
    process.exit(0);
  });
}
