// app.ts — the forge's HTTP server: one process, four surfaces.
//
// Routing:
//   GET  /healthz                 the env's boot probe: 200 {"ok":true}
//   /{owner}/{repo}.git/...       git smart HTTP (upload-pack v2/v0, receive-pack v0)
//   /api/v3/...                   GitHub REST v3
//   POST /api/graphql             GitHub GraphQL v4 (single operations and batches)
//   POST /mcp                     Model Context Protocol (JSON-RPC 2.0, Streamable HTTP)
//   anything else                 404 {"message":"Not Found"}, never HTML
//
// main.ts owns the lifecycle (bind, register, wait for done); this file owns the
// server. The bearer token comes from MAKEFUN_SHOP_TOKEN; when it is unset (local
// development) any bearer is accepted.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { handleGit } from './githttp.ts';
import { handleRest } from './rest.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { readBody, sendError, sendJson, type ReqCtx } from './httputil.ts';

/** Build the server. It binds nothing until the caller listens. */
export function createApp(): Server {
  const store = new Store();
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  let reqCounter = 0;
  const ctx: ReqCtx = {
    store,
    token,
    nextReqId: () => `req-${++reqCounter}`,
  };
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void handleRequest(ctx, req, res).catch((err: unknown) => {
      try {
        sendError(ctx, res, 500, err instanceof Error ? err.message : 'internal error');
      } catch {
        // The response is already gone; nothing left to do.
      }
    });
  });
}

/** The path segments of a request URL, without empty parts. */
function segmentsOf(pathname: string): string[] {
  return pathname.split('/').filter((part) => part !== '');
}

/** Route one request to its surface and answer it. */
async function handleRequest(ctx: ReqCtx, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET';
  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://entry');
  } catch {
    sendError(ctx, res, 404, 'Not Found');
    return;
  }
  const path = url.pathname;
  const segments = segmentsOf(path);

  // The env's boot check calls this twice: 200 {"ok":true}. No token needed.
  if (method === 'GET' && path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  // GET/HEAD carry no body; every other method's body is read once, up front.
  const body = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);

  // Git smart HTTP: /{owner}/{repo}.git/info/refs, .../git-upload-pack, .../git-receive-pack.
  if (segments.length >= 2 && segments[1]!.endsWith('.git')) {
    const owner = segments[0]!;
    const repo = segments[1]!.slice(0, -4);
    if (handleGit(ctx, req, res, owner, repo, segments.slice(2), body)) return;
  }

  // REST v3: /api/v3, /api/v3/, /api/v3/user, /api/v3/repos/...
  if (segments.length >= 2 && segments[0] === 'api' && segments[1] === 'v3') {
    if (handleRest(ctx, req, res, method, segments.slice(2), url, body)) return;
  }

  // GraphQL v4: POST /api/graphql (one operation, or a batched array).
  if (segments.length === 2 && segments[0] === 'api' && segments[1] === 'graphql') {
    if (method !== 'POST') {
      sendError(ctx, res, 404, 'Not Found');
      return;
    }
    handleGraphql(ctx, req, res, body);
    return;
  }

  // MCP: POST /mcp.
  if (segments.length === 1 && segments[0] === 'mcp') {
    if (method !== 'POST') {
      sendError(ctx, res, 404, 'Not Found');
      return;
    }
    handleMcp(ctx, req, res, body);
    return;
  }

  // Everything else, every method: GitHub's 404 body.
  sendError(ctx, res, 404, 'Not Found');
}
