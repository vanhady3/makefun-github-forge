// httputil.ts — small shared helpers for the forge's HTTP handlers: JSON answers,
// body reading, bearer-token auth, request ids.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Store } from './store.ts';

/** What every handler receives: the store, the expected bearer token, and a request-id source. */
export interface ReqCtx {
  store: Store;
  /** The bearer token the trial presents (MAKEFUN_SHOP_TOKEN). Empty means "accept any" (local dev). */
  token: string;
  nextReqId: () => string;
}

const JSON_TYPE = 'application/json; charset=utf-8';

/** Answer with a JSON body. */
export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

/** Answer with raw bytes and a content type. */
export function sendBuffer(res: ServerResponse, status: number, body: Buffer, contentType: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length, ...headers });
  res.end(body);
}

/** Answer with a pre-rendered JSON string (no re-stringify). */
export function sendJsonText(res: ServerResponse, status: number, text: string, headers: Record<string, string> = {}): void {
  const body = text.endsWith('\n') ? text : `${text}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(body), ...headers });
  res.end(body);
}

/** Read a request body fully into a buffer. */
export function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Whether the request carries the expected bearer token. */
export function isAuthorized(ctx: ReqCtx, req: IncomingMessage): boolean {
  if (ctx.token === '') return true;
  const header = req.headers.authorization ?? '';
  return header === `Bearer ${ctx.token}`;
}

/** The GitHub error body for a status. */
export function sendError(ctx: ReqCtx, res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message }, { 'x-github-request-id': ctx.nextReqId() });
}

/** Parse a JSON body buffer; returns null (and answers 400) when it is malformed. */
export function parseJsonBody(ctx: ReqCtx, res: ServerResponse, body: Buffer): unknown {
  if (body.length === 0) return {};
  try {
    return JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    sendError(ctx, res, 400, 'Problems parsing JSON');
    return null;
  }
}
