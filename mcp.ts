// mcp.ts — the Model Context Protocol endpoint at POST /mcp (JSON-RPC 2.0 over
// Streamable HTTP). Both eras: modern 2026-07-28 (`server/discover` with
// supportedVersions) and the legacy handshake (`initialize` +
// `notifications/initialized`). Tools act on the same store as REST.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { VIEWER, createIssue, createPull, mergePullSquash, type Repo } from './store.ts';
import { isAuthorized, sendJson, type ReqCtx } from './httputil.ts';
import { repoJson, issueJson, pullJson } from './rest.ts';

const SERVER_NAME = 'mamang-forge';
const SERVER_VERSION = '1.0.0';
const PREFERRED_REVISION = '2026-07-28';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const LEGACY_REVISIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

/** The tools this server offers. The list is a constant: two tools/list calls answer byte for byte. */
export const MCP_TOOLS: Array<Record<string, unknown>> = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the token owner.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        owner: { type: 'string', description: 'The owner login (defaults to the token owner).' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The owner/repo full name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The owner/repo full name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The owner/repo full name.' },
        state: { type: 'string', description: 'open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The owner/repo full name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash commit.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The owner/repo full name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

const TOOL_REQUIRED: Record<string, string[]> = {
  create_repo: ['name'],
  get_repo: ['owner', 'repo'],
  create_issue: ['owner', 'repo', 'title'],
  list_issues: ['owner', 'repo'],
  create_pull_request: ['owner', 'repo', 'title', 'head', 'base'],
  merge_pull_request: ['owner', 'repo', 'pull_number'],
};

/** A tool result: text content (a JSON string) plus the same value structured. */
function toolResult(value: unknown): Record<string, unknown> {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return { content: [{ type: 'text', text }], structuredContent: value };
}

/** A tool result that reports an execution error. */
function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** The first string among the argument's candidate keys. */
function argStr(args: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  return undefined;
}

/** The owner/repo pair an argument set names (explicit fields, or a full_name). */
function ownerRepo(args: Record<string, unknown>): { owner: string; repo: string } {
  const full = argStr(args, ['full_name', 'repo_full_name', 'repository_full_name']);
  if (full !== undefined && full.includes('/')) {
    const [owner, repo] = full.split('/', 2);
    return { owner: owner ?? '', repo: repo ?? '' };
  }
  return {
    owner: argStr(args, ['owner', 'owner_login', 'login']) ?? VIEWER.login,
    repo: argStr(args, ['repo', 'repository', 'repository_name', 'repo_name', 'name']) ?? '',
  };
}

/** Execute one tool call against the store. */
function callTool(ctx: ReqCtx, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const store = ctx.store;
  if (name === 'create_repo') {
    const repoName = argStr(args, ['name', 'repo', 'repository']);
    if (repoName === undefined) return toolError('Missing required argument: name');
    const owner = argStr(args, ['owner', 'owner_login']) ?? VIEWER.login;
    const repo = store.createRepo(owner, repoName, argStr(args, ['description']) ?? '', args.private === true);
    if (repo === null) return toolError('Repository already exists');
    return toolResult(repoJson(repo));
  }
  if (name === 'get_repo') {
    const { owner, repo } = ownerRepo(args);
    const found = store.getRepo(owner, repo);
    if (found === undefined) return toolError('Repository not found');
    return toolResult(repoJson(found));
  }
  if (name === 'create_issue') {
    const { owner, repo } = ownerRepo(args);
    const title = argStr(args, ['title']);
    if (title === undefined) return toolError('Missing required argument: title');
    const found = store.getRepo(owner, repo);
    if (found === undefined) return toolError('Repository not found');
    const issue = createIssue(found, title, argStr(args, ['body', 'description']) ?? '', []);
    return toolResult(issueJson(found, issue));
  }
  if (name === 'list_issues') {
    const { owner, repo } = ownerRepo(args);
    const found = store.getRepo(owner, repo);
    if (found === undefined) return toolError('Repository not found');
    const state = argStr(args, ['state']) ?? 'open';
    let list = found.issues;
    if (state === 'open') list = list.filter((issue) => issue.state === 'open');
    else if (state === 'closed') list = list.filter((issue) => issue.state === 'closed');
    return toolResult(list.map((issue) => issueJson(found, issue)));
  }
  if (name === 'create_pull_request') {
    const { owner, repo } = ownerRepo(args);
    const title = argStr(args, ['title']);
    const head = argStr(args, ['head', 'head_ref', 'head_branch']);
    const base = argStr(args, ['base', 'base_ref', 'base_branch']);
    if (title === undefined || head === undefined || base === undefined) return toolError('Missing required argument: title, head or base');
    const found = store.getRepo(owner, repo);
    if (found === undefined) return toolError('Repository not found');
    try {
      const pull = createPull(found, title, argStr(args, ['body', 'description']) ?? '', head, base);
      return toolResult(pullJson(found, pull));
    } catch {
      return toolError('head or base branch does not exist');
    }
  }
  if (name === 'merge_pull_request') {
    const { owner, repo } = ownerRepo(args);
    const number = Number(args.pull_number ?? args.number ?? NaN);
    const found: Repo | undefined = store.getRepo(owner, repo);
    if (found === undefined) return toolError('Repository not found');
    const pull = found.pullsByNumber.get(number);
    if (pull === undefined) return toolError('Pull request not found');
    const merged = mergePullSquash(found, pull);
    if (merged === null) return toolError('Pull request cannot be merged');
    return toolResult(pullJson(found, pull));
  }
  return toolError(`Unknown tool: ${name}`);
}

// ---------------------------------------------------------------- JSON-RPC

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}
function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

/** Handle POST /mcp. */
export function handleMcp(ctx: ReqCtx, req: IncomingMessage, res: ServerResponse, rawBody: Buffer): boolean {
  if (!isAuthorized(ctx, req)) {
    res.writeHead(401, { 'content-type': 'application/json; charset=utf-8', 'x-github-request-id': ctx.nextReqId() });
    res.end(JSON.stringify({ message: 'Bad credentials' }));
    return true;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8')) as unknown;
  } catch {
    sendJson(res, 400, rpcError(null, -32700, 'Parse error'), { 'x-github-request-id': ctx.nextReqId() });
    return true;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    sendJson(res, 400, rpcError(null, -32600, 'Invalid Request'), { 'x-github-request-id': ctx.nextReqId() });
    return true;
  }
  const record = parsed as Record<string, unknown>;
  const method = typeof record.method === 'string' ? record.method : '';
  const id = record.id ?? null;
  const params = (record.params !== null && typeof record.params === 'object' && !Array.isArray(record.params) ? record.params : {}) as Record<string, unknown>;
  const headers = { 'x-github-request-id': ctx.nextReqId() };

  // Notifications carry no id and get no JSON-RPC answer (202, empty).
  if (id === null && method.startsWith('notifications/')) {
    res.writeHead(202, { 'x-github-request-id': ctx.nextReqId() });
    res.end();
    return true;
  }

  if (method === 'server/discover') {
    sendJson(res, 200, rpcResult(id, {
      protocolVersion: PREFERRED_REVISION,
      supportedVersions: SUPPORTED_VERSIONS,
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      capabilities: { tools: {} },
    }), headers);
    return true;
  }
  if (method === 'initialize') {
    const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const chosen = offered !== '' && (SUPPORTED_VERSIONS.includes(offered) || LEGACY_REVISIONS.includes(offered)) ? offered : '2025-11-25';
    sendJson(res, 200, rpcResult(id, {
      protocolVersion: chosen,
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      capabilities: { tools: {} },
    }), headers);
    return true;
  }
  if (method === 'tools/list') {
    sendJson(res, 200, rpcResult(id, { tools: MCP_TOOLS }), headers);
    return true;
  }
  if (method === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments !== null && typeof params.arguments === 'object' && !Array.isArray(params.arguments) ? params.arguments : {}) as Record<string, unknown>;
    const known = MCP_TOOLS.some((tool) => tool.name === toolName);
    if (!known) {
      sendJson(res, 200, rpcError(id, -32602, `Unknown tool: ${toolName}`), headers);
      return true;
    }
    const required = TOOL_REQUIRED[toolName] ?? [];
    const missing = required.filter((key) => {
      if (key === 'owner' || key === 'repo') {
        const { owner, repo } = ownerRepo(args);
        return key === 'owner' ? owner === '' : repo === '';
      }
      return args[key] === undefined || args[key] === null || args[key] === '';
    });
    if (missing.length > 0) {
      sendJson(res, 200, rpcError(id, -32602, `Missing required argument: ${missing.join(', ')}`), headers);
      return true;
    }
    sendJson(res, 200, rpcResult(id, callTool(ctx, toolName, args)), headers);
    return true;
  }
  if (method === 'ping') {
    sendJson(res, 200, rpcResult(id, {}), headers);
    return true;
  }
  sendJson(res, 200, rpcError(id, -32601, `Method not found: ${method}`), headers);
  return true;
}
