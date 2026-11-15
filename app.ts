// The forge's HTTP server: routing, auth, body reading. Everything else lives in
// rest.ts (REST v3), graphql.ts (GraphQL v4), mcp.ts (MCP) and git.ts (smart HTTP).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store, VIEWER_LOGIN } from './store.ts';
import { routeRest } from './rest.ts';
import { GraphQLExecutor } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleInfoRefs, handleUploadPack, handleReceivePackRequest } from './git.ts';

const MAX_BODY_BYTES = 64 * 1024 * 1024;

export function createApp(): Server {
  const store = new Store();
  const graphql = new GraphQLExecutor(store);
  const shopToken = process.env.MAKEFUN_SHOP_TOKEN ?? '';

  const server = createServer((req, res) => {
    void handleRequest(req, res, store, graphql, shopToken).catch((err: unknown) => {
      if (!res.headersSent) {
        sendJson(res, 500, { message: 'Internal Server Error' }, store);
      }
      process.stderr.write(`[entry] unhandled request error: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    });
  });
  return server;
}

function sendJson(res: ServerResponse, status: number, body: unknown, store: Store, extraHeaders?: Record<string, string>): void {
  const payload = body === null ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'x-github-request-id': store.nextRequestId(),
    ...(body === null ? {} : { 'content-length': String(Buffer.byteLength(payload)) }),
    ...extraHeaders,
  });
  res.end(payload);
}

function sendRaw(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': String(body.length) });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer (.+)$/.exec(header);
  return match === null ? null : match[1]!;
}

function authenticated(req: IncomingMessage, shopToken: string): boolean {
  const token = bearerToken(req);
  if (token === null || token === '') return false;
  if (shopToken !== '') return token === shopToken;
  return true;
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  graphql: GraphQLExecutor,
  shopToken: string,
): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
  const pathname = url.pathname;
  const method = req.method ?? 'GET';
  const baseUrl = `http://${req.headers.host ?? '127.0.0.1'}`;

  // GET /healthz — the env's boot probe, no auth.
  if (pathname === '/healthz') {
    if (method !== 'GET') return sendJson(res, 405, { message: 'Method Not Allowed' }, store);
    return sendJson(res, 200, { ok: true }, store);
  }

  // POST /api/graphql — GraphQL v4 (batched arrays included).
  if (pathname === '/api/graphql') {
    if (method !== 'POST') return sendJson(res, 405, { message: 'Method Not Allowed' }, store);
    if (!authenticated(req, shopToken)) return sendJson(res, 401, { message: 'Requires authentication' }, store);
    const raw = await readBody(req);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString('utf8'));
    } catch {
      return sendJson(res, 400, { message: 'Invalid JSON' }, store);
    }
    if (Array.isArray(parsed)) {
      const out = parsed.map((entry) => {
        if (entry === null || typeof entry !== 'object') return { data: {}, errors: [{ message: 'Invalid operation' }] };
        const operation = entry as Record<string, unknown>;
        return graphql.execute(
          typeof operation.query === 'string' ? operation.query : '',
          (operation.variables ?? {}) as Record<string, unknown>,
        );
      });
      return sendJson(res, 200, out, store);
    }
    if (parsed === null || typeof parsed !== 'object') {
      return sendJson(res, 400, { message: 'Invalid GraphQL request' }, store);
    }
    const operation = parsed as Record<string, unknown>;
    const result = graphql.execute(
      typeof operation.query === 'string' ? operation.query : '',
      (operation.variables ?? {}) as Record<string, unknown>,
    );
    return sendJson(res, 200, result, store);
  }

  // /mcp — JSON-RPC 2.0 over Streamable HTTP (plain JSON answers).
  if (pathname === '/mcp') {
    if (method === 'DELETE') return sendJson(res, 200, {}, store);
    if (method === 'GET') return sendJson(res, 405, { message: 'Method Not Allowed' }, store);
    if (method !== 'POST') return sendJson(res, 405, { message: 'Method Not Allowed' }, store);
    const raw = await readBody(req);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString('utf8'));
    } catch {
      return sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, store);
    }
    const result = handleMcp(store, parsed, authenticated(req, shopToken));
    if (result.body === null) {
      res.writeHead(result.status);
      res.end();
      return;
    }
    return sendJson(res, result.status, result.body, store);
  }

  // /api/v3/* — REST v3, bearer token required on every route.
  if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
    if (!authenticated(req, shopToken)) {
      return sendJson(res, 401, { message: 'Requires authentication' }, store);
    }
    const restPath = pathname === '/api/v3' ? '' : pathname.slice('/api/v3'.length);
    let body: unknown;
    if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
      const raw = await readBody(req);
      if (raw.length > 0) {
        try {
          body = JSON.parse(raw.toString('utf8'));
        } catch {
          return sendJson(res, 400, { message: 'Invalid JSON' }, store);
        }
      }
    }
    const result = routeRest(store, method, restPath, url.searchParams, body, baseUrl);
    if (result.status === 204) {
      res.writeHead(204, { 'x-github-request-id': store.nextRequestId() });
      res.end();
      return;
    }
    return sendJson(res, result.status, result.body, store, result.headers);
  }

  // /<owner>/<repo>.git/* — git smart HTTP, no token (the git client sends none).
  const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(.*)$/.exec(pathname);
  if (gitMatch !== null) {
    const owner = decodeURIComponent(gitMatch[1]!);
    const repoName = decodeURIComponent(gitMatch[2]!);
    const tail = gitMatch[3]!;
    const repo = owner.toLowerCase() === VIEWER_LOGIN ? store.getRepo(owner, repoName) : undefined;
    if (tail === 'info/refs') {
      const service = url.searchParams.get('service');
      if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
        return sendJson(res, 400, { message: 'Unknown service' }, store);
      }
      const isV2 = req.headers['git-protocol'] === 'version=2';
      const result = handleInfoRefs(repo, service, isV2);
      return sendRaw(res, result.status, result.contentType, result.body);
    }
    if (tail === 'git-upload-pack' && method === 'POST') {
      const isV2 = req.headers['git-protocol'] === 'version=2';
      const raw = await readBody(req);
      const result = handleUploadPack(repo, isV2, raw);
      return sendRaw(res, result.status, result.contentType, result.body);
    }
    if (tail === 'git-receive-pack' && method === 'POST') {
      const raw = await readBody(req);
      const result = handleReceivePackRequest(repo, store, raw);
      return sendRaw(res, result.status, result.contentType, result.body);
    }
    return sendJson(res, 404, { message: 'Not Found' }, store);
  }

  return sendJson(res, 404, { message: 'Not Found' }, store);
}
