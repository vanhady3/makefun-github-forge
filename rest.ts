// rest.ts — the GitHub REST v3 surface under /api/v3.
//
// Every reply is application/json with a non-empty X-GitHub-Request-Id. Errors are
// {"message": string}. A repo under another owner is 404, never 403. Unknown routes
// are 404 JSON, never HTML. Malformed JSON bodies are 400.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseCommit, parseTree } from './gitutil.ts';
import {
  VIEWER,
  STRANGER,
  FIXED_TS,
  createIssue,
  createPull,
  mergePullSquash,
  pullFiles,
  pullConflicted,
  touchIssue,
  writeContents,
  deleteContents,
  blobAtPath,
  commitTree,
  commitHistory,
  flattenTree,
  type Repo,
  type Issue,
  type Pull,
  type Comment,
} from './store.ts';
import { isAuthorized, parseJsonBody, sendError, sendJson, sendJsonText, type ReqCtx } from './httputil.ts';

// ---------------------------------------------------------------- shapes

/** The user object the token owner reads as. */
export function userJson(login: string): Record<string, unknown> {
  const id = login === VIEWER.login ? VIEWER.id : login === STRANGER.login ? STRANGER.id : 1000;
  return { login, id, node_id: login, type: 'User', site_admin: false, name: login, avatar_url: '', html_url: `https://example.invalid/${login}` };
}

/** A repository as REST renders it. `id` is the opaque global id (also GraphQL's id). */
export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userJson(repo.owner),
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: FIXED_TS,
    updated_at: FIXED_TS,
    pushed_at: FIXED_TS,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    clone_url: `https://example.invalid/${repo.owner}/${repo.name}.git`,
    git_url: `git://example.invalid/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@example.invalid:${repo.owner}/${repo.name}.git`,
    homepage: null,
    language: null,
    topics: [],
    visibility: repo.private ? 'private' : 'public',
    fork: false,
    archived: false,
    disabled: false,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    has_pages: false,
    has_downloads: true,
    license: null,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}

/** An issue as REST renders it. */
export function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((label) => ({ name: label.name, color: label.color, url: '' })),
    user: userJson(issue.user.login),
    assignee: null,
    assignees: [],
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    closed_at: issue.closed_at,
    comments: issue.comments.length,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${repo.owner}/${repo.name}`,
  };
}

/** The rendered JSON string for one issue, cached until the issue mutates. */
export function issueJsonString(repo: Repo, issue: Issue): string {
  if (issue.jsonCache !== null) return issue.jsonCache;
  const text = JSON.stringify(issueJson(repo, issue));
  issue.jsonCache = text;
  return text;
}

/** A comment as REST renders it: `id` is numeric here (the GraphQL id is derived). */
export function commentJson(repo: Repo, issue: Issue, comment: Comment): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: comment.id,
    body: comment.body,
    user: userJson(comment.user.login),
    created_at: comment.created_at,
    updated_at: comment.updated_at,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments/${comment.id}`,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
  };
}

/** A pull request as REST renders it. */
export function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  const refJson = (ref: string, sha: string): Record<string, unknown> => ({
    label: `${repo.owner}:${ref}`,
    ref,
    sha,
    user: userJson(repo.owner),
    repo: { id: repo.id, name: repo.name, full_name: `${repo.owner}/${repo.name}` },
  });
  return {
    id: pull.id,
    node_id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.merged_at,
    merge_commit_sha: pull.merge_commit_sha,
    draft: false,
    head: refJson(pull.headRef, pull.headSha),
    base: refJson(pull.baseRef, pull.baseSha),
    user: userJson(pull.user.login),
    created_at: pull.created_at,
    updated_at: pull.updated_at,
    closed_at: pull.closed_at,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`,
  };
}

/** A branch as REST renders it. */
function branchJson(repo: Repo, name: string, sha: string): Record<string, unknown> {
  return {
    name,
    commit: { sha, url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}` },
    protected: false,
  };
}

/** A commit as REST renders it. */
function commitJson(repo: Repo, sha: string, message: string): Record<string, unknown> {
  const obj = repo.objects.get(sha);
  const parents: Array<Record<string, unknown>> = [];
  if (obj !== undefined && obj.type === 'commit') {
    for (const parent of parseCommit(obj.data).parents) parents.push({ sha: parent });
  }
  return {
    sha,
    commit: {
      message,
      author: { name: 'Conformance', email: 'conformance@make.fun', date: FIXED_TS },
      committer: { name: 'Conformance', email: 'conformance@make.fun', date: FIXED_TS },
    },
    author: userJson(VIEWER.login),
    committer: userJson(VIEWER.login),
    parents,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}`,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/commit/${sha}`,
  };
}

// ---------------------------------------------------------------- helpers

/** Answer a REST call with the request-id header attached. */
function ok(ctx: ReqCtx, res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  sendJson(res, status, body, { 'x-github-request-id': ctx.nextReqId(), ...headers });
}

/** Parse `?per_page=&page=` (GitHub defaults: 30 per page, page 1). */
function pageParams(url: URL): { perPage: number; page: number } {
  const perPage = Math.max(1, Math.min(100, Number(url.searchParams.get('per_page') ?? '30') || 30));
  const page = Math.max(1, Number(url.searchParams.get('page') ?? '1') || 1);
  return { perPage, page };
}

/** Slice a list into a page and build the Link header when more pages follow. */
function paginate<T>(req: IncomingMessage, url: URL, items: readonly T[]): { page: T[]; link: string } {
  const { perPage, page } = pageParams(url);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  let link = '';
  if (start + perPage < items.length) {
    const base = `http://${req.headers.host ?? 'entry'}${url.pathname}`;
    const next = new URL(base);
    next.searchParams.set('per_page', String(perPage));
    next.searchParams.set('page', String(page + 1));
    link = `<${next.toString()}>; rel="next"`;
  }
  return { page: [...slice], link };
}

/** The repo a route names, or null (with a 404 already sent) when it is absent. */
function needRepo(ctx: ReqCtx, res: ServerResponse, owner: string, name: string): Repo | null {
  const repo = ctx.store.getRepo(owner, name);
  if (repo === undefined) {
    sendError(ctx, res, 404, 'Not Found');
    return null;
  }
  return repo;
}

/** A ref name from a head/base value that may be `owner:branch` or just `branch`. */
function shortRef(ref: string): string {
  const idx = ref.indexOf(':');
  return idx >= 0 ? ref.slice(idx + 1) : ref;
}

// ---------------------------------------------------------------- route handlers

/** Resolve a ref name or sha to a commit id, or null when it names nothing. */
function resolveRef(repo: Repo, ref: string | null): string | null {
  if (ref === null || ref === '') return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  const byBranch = repo.refs.get(`refs/heads/${ref}`);
  if (byBranch !== undefined) return byBranch;
  if (repo.objects.has(ref)) return ref;
  return null;
}

/** The tree id at a path inside a tree (walking subtrees), or null when it is not a tree. */
function treeOidAtPath(repo: Repo, treeOid: string | null, path: string): string | null {
  if (path === '') return treeOid;
  let current = treeOid;
  for (const segment of path.split('/')) {
    if (current === null) return null;
    const obj = repo.objects.get(current);
    if (obj === undefined || obj.type !== 'tree') return null;
    const entry = parseTree(obj.data).find((e) => e.name === segment && e.mode === '40000');
    if (entry === undefined) return null;
    current = entry.oid;
  }
  return current;
}

/** The contents of a path in a tree: a file entry or a directory listing. */
function contentsAt(repo: Repo, treeOid: string | null, path: string): Record<string, unknown> | Array<Record<string, unknown>> | null {
  const flat = flattenTree(repo, treeOid);
  const file = flat.get(path);
  if (file !== undefined) {
    const obj = repo.objects.get(file.oid);
    if (obj === undefined || obj.type !== 'blob') return null;
    const name = path.split('/').pop() ?? path;
    return {
      type: 'file',
      encoding: 'base64',
      size: obj.data.length,
      name,
      path,
      content: obj.data.toString('base64'),
      sha: file.oid,
      url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
      html_url: `https://example.invalid/${repo.owner}/${repo.name}/blob/HEAD/${path}`,
      git_url: '',
      download_url: '',
    };
  }
  // A directory: its immediate children.
  const prefix = path === '' ? '' : `${path}/`;
  const children = new Map<string, { type: string; oid: string }>();
  for (const [p, entry] of flat) {
    if (!p.startsWith(prefix)) continue;
    const rest = p.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash < 0) children.set(rest, { type: 'file', oid: entry.oid });
    else children.set(rest.slice(0, slash), { type: 'dir', oid: '' });
  }
  if (children.size === 0) return null;
  const out: Array<Record<string, unknown>> = [];
  for (const [name, child] of [...children.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const childPath = prefix + name;
    const sha = child.type === 'dir' ? (treeOidAtPath(repo, treeOid, childPath) ?? '') : child.oid;
    out.push({
      type: child.type,
      name,
      path: childPath,
      sha,
      size: child.type === 'file' ? (repo.objects.get(child.oid)?.data.length ?? 0) : 0,
      url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${childPath}`,
      html_url: `https://example.invalid/${repo.owner}/${repo.name}/tree/HEAD/${childPath}`,
    });
  }
  return out;
}

/**
 * Handle a REST request under /api/v3. `segments` is the path split on '/', without
 * the leading /api/v3. Returns true when the path is a REST route.
 */
export function handleRest(
  ctx: ReqCtx,
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  segments: string[],
  url: URL,
  rawBody: Buffer,
): boolean {
  // The API root and the version probe need no token (as api.github.com answers them).
  if (segments.length === 0) {
    if (method === 'GET') {
      ok(ctx, res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
    } else sendError(ctx, res, 404, 'Not Found');
    return true;
  }
  if (segments.length === 1 && segments[0] === 'meta') {
    if (method === 'GET') ok(ctx, res, 200, { installed_version: '1.0.0' });
    else sendError(ctx, res, 404, 'Not Found');
    return true;
  }
  if (!isAuthorized(ctx, req)) {
    sendError(ctx, res, 401, 'Bad credentials');
    return true;
  }
  const body = parseJsonBody(ctx, res, rawBody);
  if (body === null) return true; // 400 already sent (malformed JSON)
  const obj = (typeof body === 'object' && body !== null && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
  const str = (key: string): string => (typeof obj[key] === 'string' ? (obj[key] as string) : '');
  const bool = (key: string): boolean => obj[key] === true;

  // GET /user — the token owner.
  if (segments.length === 1 && segments[0] === 'user') {
    if (method !== 'GET') {
      sendError(ctx, res, 404, 'Not Found');
      return true;
    }
    ok(ctx, res, 200, userJson(VIEWER.login));
    return true;
  }

  // /user/repos — list (paginated) and create.
  if (segments.length === 2 && segments[0] === 'user' && segments[1] === 'repos') {
    if (method === 'GET') {
      const repos = ctx.store.listReposByOwner(VIEWER.login);
      const { page, link } = paginate(req, url, repos.map((repo) => repoJson(repo)));
      ok(ctx, res, 200, page, link === '' ? {} : { link });
      return true;
    }
    if (method === 'POST') {
      const name = str('name');
      if (name === '') {
        sendError(ctx, res, 422, 'name is required');
        return true;
      }
      const repo = ctx.store.createRepo(VIEWER.login, name, str('description'), bool('private'));
      if (repo === null) {
        sendError(ctx, res, 422, 'Repository already exists');
        return true;
      }
      ok(ctx, res, 201, repoJson(repo));
      return true;
    }
    sendError(ctx, res, 404, 'Not Found');
    return true;
  }

  // Everything below is /repos/{owner}/{name}[/...].
  if (segments.length < 3 || segments[0] !== 'repos') return false;
  const owner = segments[1]!;
  const repoName = segments[2]!;
  const rest = segments.slice(3);

  // GET/PATCH/DELETE /repos/{owner}/{name}
  if (rest.length === 0) {
    if (method === 'GET') {
      const repo = needRepo(ctx, res, owner, repoName);
      if (repo !== null) ok(ctx, res, 200, repoJson(repo));
      return true;
    }
    if (method === 'PATCH') {
      const repo = needRepo(ctx, res, owner, repoName);
      if (repo === null) return true;
      if (typeof obj.description === 'string') repo.description = obj.description;
      if (typeof obj.default_branch === 'string' && obj.default_branch !== '') repo.defaultBranch = obj.default_branch;
      if (typeof obj.private === 'boolean') repo.private = obj.private;
      ok(ctx, res, 200, repoJson(repo));
      return true;
    }
    if (method === 'DELETE') {
      const repo = needRepo(ctx, res, owner, repoName);
      if (repo === null) return true;
      ctx.store.deleteRepo(owner, repoName);
      res.writeHead(204, { 'x-github-request-id': ctx.nextReqId() });
      res.end();
      return true;
    }
    sendError(ctx, res, 404, 'Not Found');
    return true;
  }

  // Branches.
  if (rest[0] === 'branches') {
    const repo = needRepo(ctx, res, owner, repoName);
    if (repo === null) return true;
    if (method === 'GET' && rest.length === 1) {
      const branches: Array<Record<string, unknown>> = [];
      for (const [ref, sha] of [...repo.refs.entries()].sort()) {
        if (ref.startsWith('refs/heads/')) branches.push(branchJson(repo, ref.slice(11), sha));
      }
      ok(ctx, res, 200, branches);
      return true;
    }
    if (method === 'GET' && rest.length === 2) {
      const sha = repo.refs.get(`refs/heads/${rest[1]}`);
      if (sha === undefined) {
        sendError(ctx, res, 404, 'Not Found');
        return true;
      }
      ok(ctx, res, 200, branchJson(repo, rest[1]!, sha));
      return true;
    }
    sendError(ctx, res, 404, 'Not Found');
    return true;
  }

  // Commits.
  if (rest[0] === 'commits') {
    const repo = needRepo(ctx, res, owner, repoName);
    if (repo === null) return true;
    if (method === 'GET' && rest.length === 1) {
      const tip = resolveRef(repo, url.searchParams.get('sha'));
      if (tip === null) {
        sendError(ctx, res, 404, 'Not Found');
        return true;
      }
      const history = commitHistory(repo, tip).map((entry) => commitJson(repo, entry.sha, entry.message));
      const { page } = paginate(req, url, history);
      ok(ctx, res, 200, page);
      return true;
    }
    sendError(ctx, res, 404, 'Not Found');
    return true;
  }

  // Git Data: refs.
  if (rest[0] === 'git' && rest[1] === 'refs') {
    const repo = needRepo(ctx, res, owner, repoName);
    if (repo === null) return true;
    if (method === 'GET' && rest.length === 4 && rest[2] === 'heads') {
      const sha = repo.refs.get(`refs/heads/${rest[3]}`);
      if (sha === undefined) {
        sendError(ctx, res, 404, 'Not Found');
        return true;
      }
      ok(ctx, res, 200, { ref: `refs/heads/${rest[3]}`, object: { sha, type: 'commit' }, url: '' });
      return true;
    }
    if (method === 'POST' && rest.length === 2) {
      const ref = str('ref');
      const sha = str('sha');
      if (!ref.startsWith('refs/') || sha === '' || !repo.objects.has(sha)) {
        sendError(ctx, res, 422, 'invalid ref or sha');
        return true;
      }
      if (repo.refs.has(ref)) {
        sendError(ctx, res, 422, 'Reference already exists');
        return true;
      }
      repo.refs.set(ref, sha);
      ok(ctx, res, 201, { ref, object: { sha, type: 'commit' }, url: '' });
      return true;
    }
    sendError(ctx, res, 404, 'Not Found');
    return true;
  }

  // Contents.
  if (rest[0] === 'contents') {
    const repo = needRepo(ctx, res, owner, repoName);
    if (repo === null) return true;
    const path = rest.slice(1).map((s) => decodeURIComponent(s)).join('/');
    if (method === 'GET') {
      const tip = resolveRef(repo, url.searchParams.get('ref'));
      if (tip === null) {
        sendError(ctx, res, 404, 'Not Found');
        return true;
      }
      const found = contentsAt(repo, commitTree(repo, tip), path);
      if (found === null) {
        sendError(ctx, res, 404, 'Not Found');
        return true;
      }
      ok(ctx, res, 200, found);
      return true;
    }
    if (method === 'PUT') {
      const message = str('message');
      const contentB64 = str('content');
      if (message === '' || contentB64 === '') {
        sendError(ctx, res, 422, 'message and content are required');
        return true;
      }
      let content: Buffer;
      try {
        content = Buffer.from(contentB64, 'base64');
      } catch {
        sendError(ctx, res, 422, 'content is not valid base64');
        return true;
      }
      const branch = typeof obj.branch === 'string' && obj.branch !== '' ? (obj.branch as string) : repo.defaultBranch;
      try {
        const written = writeContents(repo, branch, path, content, message, typeof obj.sha === 'string' ? (obj.sha as string) : undefined);
        ok(ctx, res, written.created ? 201 : 200, {
          content: { name: path.split('/').pop() ?? path, path, sha: written.contentSha, size: content.length, encoding: 'base64' },
          commit: { sha: written.commitOid, message },
        });
      } catch (err) {
        if ((err as { code?: string }).code === 'SHA_MISMATCH') sendError(ctx, res, 409, 'sha does not match');
        else sendError(ctx, res, 422, err instanceof Error ? err.message : 'cannot write contents');
      }
      return true;
    }
    if (method === 'DELETE') {
      const message = str('message');
      const branch = typeof obj.branch === 'string' && obj.branch !== '' ? (obj.branch as string) : repo.defaultBranch;
      try {
        const commitOid = deleteContents(repo, branch, path, message, typeof obj.sha === 'string' ? (obj.sha as string) : undefined);
        ok(ctx, res, 200, { commit: { sha: commitOid, message } });
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === 'SHA_MISMATCH') sendError(ctx, res, 409, 'sha does not match');
        else if (code === 'NO_FILE' || code === 'NO_BRANCH') sendError(ctx, res, 404, 'Not Found');
        else sendError(ctx, res, 422, err instanceof Error ? err.message : 'cannot delete contents');
      }
      return true;
    }
    sendError(ctx, res, 404, 'Not Found');
    return true;
  }

  // Labels.
  if (rest[0] === 'labels') {
    const repo = needRepo(ctx, res, owner, repoName);
    if (repo === null) return true;
    if (method === 'GET') {
      ok(ctx, res, 200, [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color, url: '' })));
      return true;
    }
    if (method === 'POST') {
      const name = str('name');
      if (name === '') {
        sendError(ctx, res, 422, 'name is required');
        return true;
      }
      const color = typeof obj.color === 'string' ? (obj.color as string) : 'ffffff';
      repo.labels.set(name, { name, color });
      ok(ctx, res, 201, { name, color, url: '' });
      return true;
    }
    sendError(ctx, res, 404, 'Not Found');
    return true;
  }

  // Issues and comments.
  if (rest[0] === 'issues') {
    const repo = needRepo(ctx, res, owner, repoName);
    if (repo === null) return true;
    if (method === 'GET' && rest.length === 1) {
      const state = url.searchParams.get('state') ?? 'open';
      let list = repo.issues;
      if (state === 'open') list = list.filter((issue) => issue.state === 'open');
      else if (state === 'closed') list = list.filter((issue) => issue.state === 'closed');
      const sort = url.searchParams.get('sort') ?? 'created';
      const direction = url.searchParams.get('direction') ?? 'desc';
      const sorted = [...list];
      if (sort === 'created') sorted.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      const { page } = paginate(req, url, sorted.map((issue) => issueJson(repo, issue)));
      ok(ctx, res, 200, page);
      return true;
    }
    if (method === 'POST' && rest.length === 1) {
      const title = str('title');
      if (title === '') {
        sendError(ctx, res, 422, 'title is required');
        return true;
      }
      const labelNames = Array.isArray(obj.labels) ? (obj.labels as unknown[]).map((entry) => (typeof entry === 'string' ? entry : (entry as { name?: unknown }).name)).filter((name): name is string => typeof name === 'string') : [];
      try {
        const issue = createIssue(repo, title, str('body'), labelNames);
        ok(ctx, res, 201, issueJson(repo, issue));
      } catch (err) {
        if ((err as { code?: string }).code === 'UNKNOWN_LABEL') sendError(ctx, res, 422, err instanceof Error ? err.message : 'unknown label');
        else sendError(ctx, res, 422, err instanceof Error ? err.message : 'cannot create issue');
      }
      return true;
    }
    if (rest.length >= 2) {
      const number = Number(rest[1]);
      const issue = repo.issuesByNumber.get(number);
      if (issue === undefined) {
        sendError(ctx, res, 404, 'Not Found');
        return true;
      }
      if (method === 'GET' && rest.length === 2) {
        sendJsonText(res, 200, issueJsonString(repo, issue), { 'x-github-request-id': ctx.nextReqId() });
        return true;
      }
      if (method === 'PATCH' && rest.length === 2) {
        if (typeof obj.state === 'string' && (obj.state === 'open' || obj.state === 'closed')) {
          issue.state = obj.state;
          issue.closed_at = obj.state === 'closed' ? FIXED_TS : null;
          issue.updated_at = FIXED_TS;
        }
        if (typeof obj.title === 'string') issue.title = obj.title;
        if (typeof obj.body === 'string') issue.body = obj.body;
        touchIssue(issue);
        ok(ctx, res, 200, issueJson(repo, issue));
        return true;
      }
      if (rest.length === 3 && rest[2] === 'comments') {
        if (method === 'GET') {
          ok(ctx, res, 200, issue.comments.map((comment) => commentJson(repo, issue, comment)));
          return true;
        }
        if (method === 'POST') {
          const bodyText = str('body');
          if (bodyText === '') {
            sendError(ctx, res, 422, 'body is required');
            return true;
          }
          const comment: Comment = {
            id: repo.nextComment++,
            body: bodyText,
            user: { login: VIEWER.login, id: VIEWER.id, type: VIEWER.type },
            created_at: FIXED_TS,
            updated_at: FIXED_TS,
          };
          issue.comments.push(comment);
          touchIssue(issue);
          ok(ctx, res, 201, commentJson(repo, issue, comment));
          return true;
        }
      }
    }
    sendError(ctx, res, 404, 'Not Found');
    return true;
  }

  // Pull requests.
  if (rest[0] === 'pulls') {
    const repo = needRepo(ctx, res, owner, repoName);
    if (repo === null) return true;
    if (method === 'GET' && rest.length === 1) {
      const state = url.searchParams.get('state') ?? 'open';
      let list = repo.pulls;
      if (state === 'open') list = list.filter((pull) => pull.state === 'open');
      else if (state === 'closed') list = list.filter((pull) => pull.state === 'closed');
      const { page } = paginate(req, url, [...list].sort((a, b) => b.number - a.number).map((pull) => pullJson(repo, pull)));
      ok(ctx, res, 200, page);
      return true;
    }
    if (method === 'POST' && rest.length === 1) {
      const title = str('title');
      const head = str('head');
      const base = str('base');
      if (title === '' || head === '' || base === '') {
        sendError(ctx, res, 422, 'title, head and base are required');
        return true;
      }
      try {
        const pull = createPull(repo, title, str('body'), shortRef(head), shortRef(base));
        ok(ctx, res, 201, pullJson(repo, pull));
      } catch (err) {
        if ((err as { code?: string }).code === 'NO_BRANCH') sendError(ctx, res, 422, err instanceof Error ? err.message : 'head or base branch does not exist');
        else sendError(ctx, res, 422, err instanceof Error ? err.message : 'cannot create pull request');
      }
      return true;
    }
    if (rest.length >= 2) {
      const number = Number(rest[1]);
      const pull = repo.pullsByNumber.get(number);
      if (pull === undefined) {
        sendError(ctx, res, 404, 'Not Found');
        return true;
      }
      if (method === 'GET' && rest.length === 2) {
        ok(ctx, res, 200, pullJson(repo, pull));
        return true;
      }
      if (method === 'GET' && rest.length === 3 && rest[2] === 'files') {
        const files = pullFiles(repo, pull).map((file) => ({
          filename: file.filename,
          status: file.status,
          additions: file.additions,
          deletions: file.deletions,
          changes: file.changes,
          sha: '',
          patch: '',
        }));
        ok(ctx, res, 200, files);
        return true;
      }
      if (method === 'PUT' && rest.length === 3 && rest[2] === 'merge') {
        if (pull.state !== 'open') {
          sendError(ctx, res, 405, 'pull request is already closed');
          return true;
        }
        if (pullConflicted(repo, pull)) {
          sendError(ctx, res, 405, 'merge conflict');
          return true;
        }
        const merged = mergePullSquash(repo, pull);
        if (merged === null) {
          sendError(ctx, res, 405, 'cannot merge');
          return true;
        }
        ok(ctx, res, 200, { merged: true, sha: merged.sha, message: merged.message });
        return true;
      }
    }
    sendError(ctx, res, 404, 'Not Found');
    return true;
  }

  return false;
}
