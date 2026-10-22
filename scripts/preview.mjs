import http from 'node:http';
import {readFile} from 'node:fs/promises';
const worker = (await import('../dist/server/index.js')).default;
const env = {...process.env, APP_ORIGIN: 'http://127.0.0.1:4173'};
// Use .env only for local development; production secrets belong in Sites.
try {
  const source = await readFile(new URL('../.env', import.meta.url), 'utf8');
  for (const line of source.split('\n')) {
    const match = line.match(/^([A-Z_]+)=(.*)$/);
    if (match && !env[match[1]]) env[match[1]] = match[2];
  }
} catch {}
const server = http.createServer(async (incoming, outgoing) => {
  try {
    const method = incoming.method;
    const body = ['GET', 'HEAD'].includes(method) ? undefined : incoming;
    const request = new Request(new URL(incoming.url, env.APP_ORIGIN), {method, headers: incoming.headers, body, ...(body ? {duplex: 'half'} : {})});
    const response = await worker.fetch(request, env);
    outgoing.statusCode = response.status;
    for (const [key, value] of response.headers) if (key !== 'set-cookie') outgoing.setHeader(key, value);
    const cookies = response.headers.getSetCookie();
    if (cookies.length) outgoing.setHeader('set-cookie', cookies);
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  } catch { outgoing.writeHead(500); outgoing.end('Preview failed'); }
});
server.listen(4173, '127.0.0.1', () => console.log('Local: http://127.0.0.1:4173'));
