import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, unlink } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { randomUUID } from 'node:crypto';

const root = path.dirname(fileURLToPath(import.meta.url));
const directory = path.join(root, 'downloads');
const limit = 1024 ** 3;

export function isPublicAddress(address) {
  if (net.isIP(address) !== 4) return false; // IPv4 only; mapped IPv6 cannot bypass checks.
  const [a, b] = address.split('.').map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || b === 2)) ||
    (a === 198 && (b === 18 || b === 19 || b === 51)) || (a === 203 && b === 0));
}

export async function openRemote(input, signal, redirects = 0) {
  const url = new URL(input);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      (url.port && !['80', '443'].includes(url.port))) throw new Error('仅支持无认证的 HTTP/HTTPS 文件直链和标准端口');
  // A managed proxy resolves DNS remotely. Only explicitly trusted public hosts
  // may use it, so redirects cannot turn the proxy into an arbitrary network relay.
  const allowedHosts = (process.env.DOWNLOAD_ALLOWED_HOSTS || '').split(',').map(s => s.trim()).filter(Boolean);
  const proxyMode = allowedHosts.length > 0;
  let connection;
  if (proxyMode) {
    if (!allowedHosts.includes(url.hostname) || net.isIP(url.hostname)) throw new Error('该域名未加入下载允许列表');
    if (!process.env.HTTPS_PROXY && !process.env.HTTP_PROXY) throw new Error('代理模式需要环境代理');
    connection = { agent: url.protocol === 'https:' ? new https.Agent({ proxyEnv: process.env }) : new http.Agent({ proxyEnv: process.env }) };
  } else {
    const addresses = await dns.lookup(url.hostname, { all: true, family: 4 });
    if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address)))
      throw new Error('禁止访问本机、内网或保留地址');
    const { address, family } = addresses[0];
    connection = { lookup: (_hostname, options, callback) => options.all
      ? callback(null, [{ address, family }]) : callback(null, address, family) };
  }
  const response = await new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? https : http).get(url, {
      signal,
      headers: { 'User-Agent': 'ToolHub/1.0', 'Accept-Encoding': 'identity' },
      ...connection,
    }, resolve);
    request.setTimeout(30000, () => request.destroy(new Error('远端响应超时')));
    request.on('error', reject);
  });
  if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
    response.resume();
    if (redirects >= 5 || !response.headers.location) throw new Error('重定向过多或无效');
    return openRemote(new URL(response.headers.location, url).href, signal, redirects + 1);
  }
  if (response.statusCode !== 200) {
    response.resume();
    throw new Error(`远端返回 HTTP ${response.statusCode}`);
  }
  return { response, url };
}

export function createApp({ opener = openRemote, storage = directory } = {}) {
  const jobs = new Map();
  const controllers = new Map();
  const json = (res, status, data) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data));
  };
  async function download(job) {
    const controller = new AbortController();
    controllers.set(job.id, controller);
    const deadline = setTimeout(() => controller.abort(), 30 * 60 * 1000);
    const filename = path.join(storage, job.id);
    try {
      await mkdir(storage, { recursive: true });
      const { response, url } = await opener(job.url, controller.signal);
      const size = Number(response.headers['content-length']);
      job.total = Number.isFinite(size) && size > 0 ? size : null;
      if (job.total > limit) { response.destroy(); throw new Error('文件超过 1 GiB 上限'); }
      job.name = decodeURIComponent(path.basename(url.pathname)) || 'download';
      job.name = job.name.replace(/[\x00-\x1f\x7f/\\]/g, '_').slice(0, 180);
      await pipeline(response, new Transform({ transform(chunk, _encoding, callback) {
        job.received += chunk.length;
        callback(job.received > limit ? new Error('文件超过 1 GiB 上限') : null, chunk);
      } }), createWriteStream(filename, { flags: 'wx' }), { signal: controller.signal });
      job.status = 'complete';
    } catch (error) {
      job.status = controller.signal.aborted ? 'cancelled' : 'failed';
      job.error = controller.signal.aborted ? '下载已取消或超时' : error.message;
      await unlink(filename).catch(() => {});
    } finally {
      clearTimeout(deadline);
      controllers.delete(job.id);
    }
  }
  const server = http.createServer(async (req, res) => {
    try {
      // Reject cross-origin requests, including cross-site POSTs to localhost.
      if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`)
        return json(res, 403, { error: '不允许跨域请求' });
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/api/jobs') return json(res, 200, [...jobs.values()]);
      if (req.method === 'POST' && url.pathname === '/api/jobs') {
        if (!req.headers['content-type']?.startsWith('application/json')) return json(res, 415, { error: '需要 JSON 请求' });
        if (controllers.size >= 3) return json(res, 429, { error: '最多同时下载 3 个文件' });
        if (jobs.size >= 100) return json(res, 429, { error: '任务已达上限，请清理任务' });
        let body = '';
        for await (const chunk of req) {
          body += chunk;
          if (Buffer.byteLength(body) > 8192) return json(res, 413, { error: '请求过大' });
        }
        const input = JSON.parse(body).url;
        const remote = new URL(input);
        if (!['https:', 'http:'].includes(remote.protocol)) throw new Error('请输入 HTTP/HTTPS 文件直链');
        const job = { id: randomUUID(), url: remote.href, name: 'download', received: 0, total: null, status: 'downloading' };
        jobs.set(job.id, job);
        void download(job);
        return json(res, 202, job);
      }
      const match = url.pathname.match(/^\/api\/jobs\/([0-9a-f-]+)(\/file)?$/);
      if (match) {
        const job = jobs.get(match[1]);
        if (!job) return json(res, 404, { error: '任务不存在' });
        if (req.method === 'DELETE' && !match[2]) {
          if (controllers.has(job.id)) controllers.get(job.id).abort();
          else { await unlink(path.join(storage, job.id)).catch(() => {}); jobs.delete(job.id); }
          return json(res, 200, { ok: true });
        }
        if (req.method === 'GET' && match[2] && job.status === 'complete') {
          res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': job.received,
            'Content-Disposition': `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(job.name)}` });
          await pipeline(createReadStream(path.join(storage, job.id)), res);
          return;
        }
      }
      const files = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/style.css': ['style.css', 'text/css; charset=utf-8'] };
      if (req.method === 'GET' && files[url.pathname]) {
        const [name, type] = files[url.pathname];
        res.writeHead(200, { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'" });
        await pipeline(createReadStream(path.join(root, 'public', name)), res);
        return;
      }
      json(res, 404, { error: '未找到资源' });
    } catch (error) {
      if (!res.headersSent) json(res, 400, { error: error.message });
      else res.destroy();
    }
  });
  server.on('close', () => { for (const controller of controllers.values()) controller.abort(); });
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  createApp().listen(Number(process.env.PORT || 3000), process.env.HOST || '127.0.0.1', () => {
    console.log(`Tool Hub listening on port ${process.env.PORT || 3000}`);
  });
}
