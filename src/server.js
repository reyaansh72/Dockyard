const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC_ROOT = path.join(ROOT, 'public');
const CONFIG_ROOT = path.join(ROOT, 'config');
const SOCKET_PATH = process.env.DOCKER_SOCKET || '/var/run/docker.sock';
const API_VERSION = (process.env.DOCKER_API_VERSION || 'v1.41').replace(/^\/?/, '');
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const MAX_BODY_SIZE = 1024 * 1024;
const AUTH_USER = process.env.DOCKYARD_USER || 'admin';
const AUTH_PASSWORD = process.env.DOCKYARD_PASSWORD || '';
const SESSION_TTL = 8 * 60 * 60 * 1000;
const REMEMBERED_SESSION_TTL = 30 * 24 * 60 * 60 * 1000;
const sessions = new Map();
const loginAttempts = new Map();
const SESSION_COOKIE = 'dockyard_session';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

function sendJson(response, statusCode, value) {
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(value));
}

function getSession(request) {
  const cookie = request.headers.cookie || '';
  const token = cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${SESSION_COOKIE}=`))?.slice(SESSION_COOKIE.length + 1);
  const session = token && sessions.get(token);
  if (!session || session.expiresAt <= Date.now()) {
    if (token) sessions.delete(token);
    return null;
  }
  return { token, ...session };
}

function setSessionCookie(request, response, token, maxAge) {
  const secure = request.socket.encrypted || process.env.COOKIE_SECURE === '1' ? '; Secure' : '';
  response.setHeader('set-cookie', `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure}`);
}

function matchesPassword(candidate) {
  const actual = crypto.createHash('sha256').update(String(candidate || '')).digest();
  const expected = crypto.createHash('sha256').update(AUTH_PASSWORD).digest();
  return crypto.timingSafeEqual(actual, expected);
}

async function handleAuth(request, response, url) {
  const { pathname } = url;
  if (request.method === 'GET' && pathname === '/api/session') {
    const session = getSession(request);
    return sendJson(response, 200, { configured: Boolean(AUTH_PASSWORD), authenticated: Boolean(session), username: session?.username || null, rememberMe: session?.rememberMe || false, loginUser: AUTH_PASSWORD ? AUTH_USER : '' });
  }
  if (request.method === 'POST' && pathname === '/api/login') {
    const remoteAddress = request.socket.remoteAddress || 'local';
    const attempt = loginAttempts.get(remoteAddress) || { count: 0, blockedUntil: 0 };
    if (attempt.blockedUntil > Date.now()) throw Object.assign(new Error('Too many sign-in attempts. Try again in a few minutes.'), { statusCode: 429 });
    const body = await readJson(request);
    const username = String(body.username || '').trim().slice(0, 120);
    const rememberMe = body.rememberMe === true;
    if (!username) throw Object.assign(new Error('Enter a username or email address.'), { statusCode: 400 });
    const validUser = !AUTH_PASSWORD || username === AUTH_USER;
    const validPassword = !AUTH_PASSWORD || matchesPassword(body.password);
    if (!validUser || !validPassword) {
      attempt.count += 1;
      if (attempt.count >= 8) {
        attempt.count = 0;
        attempt.blockedUntil = Date.now() + 5 * 60 * 1000;
      }
      loginAttempts.set(remoteAddress, attempt);
      throw Object.assign(new Error('That username or password did not match.'), { statusCode: 401 });
    }
    loginAttempts.delete(remoteAddress);
    const token = crypto.randomBytes(32).toString('base64url');
    const sessionTtl = rememberMe ? REMEMBERED_SESSION_TTL : SESSION_TTL;
    for (const [key, session] of sessions) if (session.expiresAt <= Date.now()) sessions.delete(key);
    sessions.set(token, { username, rememberMe, expiresAt: Date.now() + sessionTtl });
    setSessionCookie(request, response, token, sessionTtl / 1000);
    return sendJson(response, 200, { authenticated: true, username, rememberMe, passwordConfigured: Boolean(AUTH_PASSWORD) });
  }
  if (request.method === 'POST' && pathname === '/api/logout') {
    const session = getSession(request);
    if (session) sessions.delete(session.token);
    setSessionCookie(request, response, '', 0);
    return sendJson(response, 200, { authenticated: false });
  }
  return false;
}

function dockerRequest(method, endpoint, body) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      socketPath: SOCKET_PATH,
      path: `/${API_VERSION}${endpoint}`,
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      timeout: 30000,
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const buffer = Buffer.concat(chunks);
        const text = buffer.toString('utf8');
        if (response.statusCode < 200 || response.statusCode >= 300) {
          let message = text;
          try {
            message = JSON.parse(text).message || text;
          } catch {}
          const error = new Error(message || `Docker returned ${response.statusCode}`);
          error.statusCode = response.statusCode;
          reject(error);
          return;
        }

        if (!text) {
          resolve(null);
          return;
        }

        if (method === 'GET' && endpoint.includes('/logs?')) {
          resolve(decodeDockerStream(buffer));
          return;
        }

        try {
          resolve(JSON.parse(text));
        } catch {
          const lines = text.split('\n').filter(Boolean);
          try {
            resolve(lines.map((line) => JSON.parse(line)));
          } catch {
            resolve({ raw: text });
          }
        }
      });
    });

    request.on('timeout', () => request.destroy(new Error('Docker request timed out')));
    request.on('error', reject);
    if (body !== undefined) request.write(JSON.stringify(body));
    request.end();
  });
}

function streamDockerPull(image, tag, response) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      socketPath: SOCKET_PATH,
      path: `/${API_VERSION}/images/create?fromImage=${encodeURIComponent(image)}&tag=${encodeURIComponent(tag)}`,
      method: 'POST',
      timeout: 0,
    }, (dockerResponse) => {
      let pending = '';
      let body = '';
      dockerResponse.setEncoding('utf8');
      dockerResponse.on('data', (chunk) => {
        body += chunk;
        pending += chunk;
        const lines = pending.split('\n');
        pending = lines.pop() || '';
        for (const line of lines) {
          if (!line) continue;
          let event;
          try { event = JSON.parse(line); } catch { event = { status: line }; }
          if (dockerResponse.statusCode >= 200 && dockerResponse.statusCode < 300) response.write(`${JSON.stringify(event)}\n`);
        }
      });
      dockerResponse.on('end', () => {
        if (dockerResponse.statusCode < 200 || dockerResponse.statusCode >= 300) {
          let message = body;
          try { message = JSON.parse(body).message || body; } catch {}
          reject(Object.assign(new Error(message || `Docker returned ${dockerResponse.statusCode}`), { statusCode: dockerResponse.statusCode }));
          return;
        }
        if (pending) {
          try { response.write(`${JSON.stringify(JSON.parse(pending))}\n`); } catch {}
        }
        response.end();
        resolve();
      });
    });
    request.on('error', (error) => {
      if (!response.headersSent) reject(error);
      else response.end(`${JSON.stringify({ error: error.message })}\n`);
    });
    response.on('close', () => request.destroy());
    request.end();
  });
}

function decodeDockerStream(buffer) {
  if (buffer.length < 8 || buffer[0] > 2) return buffer.toString('utf8');
  const output = [];
  let offset = 0;
  while (offset + 8 <= buffer.length) {
    const size = buffer.readUInt32BE(offset + 4);
    if (offset + 8 + size > buffer.length) return buffer.toString('utf8');
    output.push(buffer.subarray(offset + 8, offset + 8 + size));
    offset += 8 + size;
  }
  return Buffer.concat(output).toString('utf8');
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_SIZE) {
        reject(Object.assign(new Error('Request body is too large'), { statusCode: 413 }));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (!size) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('Request body must be valid JSON'), { statusCode: 400 }));
      }
    });
    request.on('error', reject);
  });
}

function dockerId(value) {
  if (!/^[a-zA-Z0-9_.:@-]+$/.test(value)) throw Object.assign(new Error('Invalid Docker resource ID'), { statusCode: 400 });
  return encodeURIComponent(value);
}

async function handleApi(request, response, url) {
  const { pathname, searchParams } = url;
  const method = request.method;

  if (method === 'GET' && pathname === '/api/catalog') {
    const catalog = JSON.parse(await fs.promises.readFile(path.join(CONFIG_ROOT, 'images.json'), 'utf8'));
    return sendJson(response, 200, catalog);
  }
  if (method === 'GET' && pathname === '/api/about') {
    const packageInfo = JSON.parse(await fs.promises.readFile(path.join(ROOT, 'package.json'), 'utf8'));
    return sendJson(response, 200, {
      app: packageInfo.name,
      version: packageInfo.version,
      node: process.version,
      platform: `${process.platform} ${process.arch}`,
      dockerApi: API_VERSION,
      socketConfigured: Boolean(SOCKET_PATH),
      passwordAuth: Boolean(AUTH_PASSWORD),
      bindAddress: HOST,
    });
  }

  if (method === 'GET' && pathname === '/api/overview') {
    const [info, version, containers, images, diskUsage] = await Promise.all([
      dockerRequest('GET', '/info'),
      dockerRequest('GET', '/version'),
      dockerRequest('GET', '/containers/json?all=1'),
      dockerRequest('GET', '/images/json'),
      dockerRequest('GET', '/system/df').catch(() => null),
    ]);
    return sendJson(response, 200, { info, version, containers, images, diskUsage });
  }

  if (method === 'GET' && pathname === '/api/monitor') {
    const containers = await dockerRequest('GET', '/containers/json?all=0');
    const visible = (containers || []).slice(0, 40);
    const stats = await Promise.all(visible.map((container) => dockerRequest('GET', `/containers/${dockerId(container.Id)}/stats?stream=false`).catch(() => null)));
    return sendJson(response, 200, { items: visible.map((container, index) => ({ container, stats: stats[index] })), truncated: (containers || []).length > visible.length });
  }

  if (method === 'GET' && pathname === '/api/events') {
    const now = Math.floor(Date.now() / 1000);
    const requestedSince = Number(searchParams.get('since') || now - 24 * 60 * 60);
    const since = Number.isFinite(requestedSince) ? Math.max(now - 7 * 24 * 60 * 60, Math.min(now, requestedSince)) : now - 24 * 60 * 60;
    const events = await dockerRequest('GET', `/events?since=${since}&until=${now}`);
    return sendJson(response, 200, { events: Array.isArray(events) ? events : events ? [events] : [], since, until: now });
  }

  if (method === 'GET' && pathname === '/api/containers') {
    const all = searchParams.get('all') === '0' ? '0' : '1';
    return sendJson(response, 200, await dockerRequest('GET', `/containers/json?all=${all}`));
  }
  if (method === 'GET' && pathname === '/api/images') return sendJson(response, 200, await dockerRequest('GET', '/images/json'));
  if (method === 'GET' && pathname === '/api/networks') return sendJson(response, 200, await dockerRequest('GET', '/networks'));
  if (method === 'GET' && pathname === '/api/volumes') return sendJson(response, 200, await dockerRequest('GET', '/volumes'));
  if (method === 'GET' && pathname === '/api/info') return sendJson(response, 200, await dockerRequest('GET', '/info'));
  if (method === 'GET' && pathname === '/api/version') return sendJson(response, 200, await dockerRequest('GET', '/version'));
  if (method === 'GET' && pathname === '/api/disk-usage') return sendJson(response, 200, await dockerRequest('GET', '/system/df'));

  let match = pathname.match(/^\/api\/containers\/([^/]+)\/(inspect|logs|stats)$/);
  if (method === 'GET' && match) {
    const id = dockerId(decodeURIComponent(match[1]));
    if (match[2] === 'inspect') return sendJson(response, 200, await dockerRequest('GET', `/containers/${id}/json`));
    if (match[2] === 'stats') return sendJson(response, 200, await dockerRequest('GET', `/containers/${id}/stats?stream=false`));
    const tail = Math.min(5000, Math.max(1, Number(searchParams.get('tail') || 200)));
    const logs = await dockerRequest('GET', `/containers/${id}/logs?stdout=1&stderr=1&timestamps=1&tail=${tail}`);
    response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    return response.end(logs);
  }

  match = pathname.match(/^\/api\/containers\/([^/]+)\/(start|stop|restart|pause|unpause|kill|remove|rename)$/);
  if (method === 'POST' && match) {
    const id = dockerId(decodeURIComponent(match[1]));
    const action = match[2];
    if (action === 'rename') {
      const name = searchParams.get('name');
      if (!name || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)) throw Object.assign(new Error('Enter a valid container name'), { statusCode: 400 });
      return sendJson(response, 200, await dockerRequest('POST', `/containers/${id}/rename?name=${encodeURIComponent(name)}`));
    }
    if (action === 'remove') {
      return sendJson(response, 200, await dockerRequest('DELETE', `/containers/${id}?force=${searchParams.get('force') === '1' ? '1' : '0'}&v=1`));
    }
    const endpoint = action === 'kill' ? `/containers/${id}/kill` : `/containers/${id}/${action}`;
    return sendJson(response, 200, await dockerRequest('POST', endpoint));
  }

  if (method === 'POST' && pathname === '/api/containers/create') {
    const body = await readJson(request);
    if (!body.Image) throw Object.assign(new Error('Choose an image before creating a container'), { statusCode: 400 });
    const name = body.name;
    const autoStart = body.autoStart === true;
    delete body.name;
    delete body.autoStart;
    const endpoint = `/containers/create${name ? `?name=${encodeURIComponent(name)}` : ''}`;
    const created = await dockerRequest('POST', endpoint, body);
    if (autoStart) await dockerRequest('POST', `/containers/${dockerId(created.Id)}/start`);
    return sendJson(response, 201, { ...created, Started: autoStart });
  }

  match = pathname.match(/^\/api\/images\/([^/]+)\/(remove|tag)$/);
  if (match && method === 'POST' && match[2] === 'tag') {
    const repo = searchParams.get('repo');
    const tag = searchParams.get('tag') || 'latest';
    if (!repo) throw Object.assign(new Error('Enter a repository name'), { statusCode: 400 });
    return sendJson(response, 200, await dockerRequest('POST', `/images/${dockerId(decodeURIComponent(match[1]))}/tag?repo=${encodeURIComponent(repo)}&tag=${encodeURIComponent(tag)}`));
  }
  if (match && (method === 'DELETE' || (method === 'POST' && match[2] === 'remove'))) {
    return sendJson(response, 200, await dockerRequest('DELETE', `/images/${dockerId(decodeURIComponent(match[1]))}?force=${searchParams.get('force') === '1' ? '1' : '0'}&noprune=0`));
  }
  if (method === 'POST' && pathname === '/api/images/pull') {
    const image = searchParams.get('image');
    if (!image || image.length > 255) throw Object.assign(new Error('Enter a valid image name'), { statusCode: 400 });
    const tag = searchParams.get('tag') || 'latest';
    response.writeHead(200, {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    try {
      return await streamDockerPull(image, tag, response);
    } catch (error) {
      response.end(`${JSON.stringify({ error: error.message })}\n`);
      return;
    }
  }

  match = pathname.match(/^\/api\/images\/([^/]+)\/(inspect|history)$/);
  if (method === 'GET' && match) {
    const id = dockerId(decodeURIComponent(match[1]));
    const suffix = match[2] === 'inspect' ? 'json' : 'history';
    return sendJson(response, 200, await dockerRequest('GET', `/images/${id}/${suffix}`));
  }

  if (method === 'POST' && pathname === '/api/networks/create') {
    const body = await readJson(request);
    if (!body.Name) throw Object.assign(new Error('Enter a network name'), { statusCode: 400 });
    return sendJson(response, 201, await dockerRequest('POST', '/networks/create', body));
  }
  match = pathname.match(/^\/api\/networks\/([^/]+)$/);
  if (method === 'GET' && match) return sendJson(response, 200, await dockerRequest('GET', `/networks/${dockerId(decodeURIComponent(match[1]))}`));
  if (method === 'DELETE' && match) return sendJson(response, 200, await dockerRequest('DELETE', `/networks/${dockerId(decodeURIComponent(match[1]))}`));
  match = pathname.match(/^\/api\/networks\/([^/]+)\/(connect|disconnect)$/);
  if (method === 'POST' && match) {
    const body = await readJson(request);
    if (!body.Container) throw Object.assign(new Error('Choose a container'), { statusCode: 400 });
    return sendJson(response, 200, await dockerRequest('POST', `/networks/${dockerId(decodeURIComponent(match[1]))}/${match[2]}`, body));
  }

  match = pathname.match(/^\/api\/volumes\/([^/]+)$/);
  if (method === 'GET' && match) return sendJson(response, 200, await dockerRequest('GET', `/volumes/${dockerId(decodeURIComponent(match[1]))}`));
  if (method === 'POST' && pathname === '/api/volumes/create') {
    const body = await readJson(request);
    if (!body.Name) throw Object.assign(new Error('Enter a volume name'), { statusCode: 400 });
    return sendJson(response, 201, await dockerRequest('POST', '/volumes/create', body));
  }
  match = pathname.match(/^\/api\/volumes\/([^/]+)$/);
  if (method === 'DELETE' && match) return sendJson(response, 200, await dockerRequest('DELETE', `/volumes/${dockerId(decodeURIComponent(match[1]))}?force=1`));

  if (method === 'POST' && pathname === '/api/prune') {
    const kind = searchParams.get('kind');
    const routes = {
      containers: '/containers/prune',
      images: '/images/prune?filters=%7B%22dangling%22%3A%5B%22false%22%5D%7D',
      networks: '/networks/prune',
      volumes: '/volumes/prune',
      build: '/build/prune',
    };
    if (!routes[kind]) throw Object.assign(new Error('Unknown cleanup target'), { statusCode: 400 });
    return sendJson(response, 200, await dockerRequest('POST', routes[kind]));
  }

  sendJson(response, 404, { message: 'API route not found' });
}

function serveStatic(response, pathname) {
  const requested = pathname === '/' ? '/index.html' : pathname;
  const filename = path.resolve(PUBLIC_ROOT, `.${requested}`);
  if (!filename.startsWith(`${PUBLIC_ROOT}${path.sep}`)) {
    response.writeHead(403).end('Forbidden');
    return;
  }
  fs.readFile(filename, (error, data) => {
    if (error) {
      response.writeHead(404).end('Not found');
      return;
    }
    response.writeHead(200, { 'content-type': MIME_TYPES[path.extname(filename)] || 'application/octet-stream' });
    response.end(data);
  });
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      const authResponse = await handleAuth(request, response, url);
      if (authResponse !== false) return;
      const session = getSession(request);
      if (!session) return sendJson(response, 401, { message: 'Sign in to access the Docker workspace.' });
      await handleApi(request, response, url);
    }
    else if (request.method === 'GET') serveStatic(response, decodeURIComponent(url.pathname));
    else sendJson(response, 405, { message: 'Method not allowed' });
  } catch (error) {
    const status = error.statusCode || (error.code === 'EACCES' || error.code === 'ENOENT' ? 503 : 500);
    sendJson(response, status, { message: error.message || 'Unexpected server error' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Docker UI listening at http://${HOST}:${PORT}`);
  console.log(`Docker socket: ${SOCKET_PATH}`);
});