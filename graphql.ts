// graphql.ts — a small GraphQL v4 executor for the documents gh and
// github-mcp-server send. It parses the operation, substitutes variables, and
// resolves against the same store REST and MCP use. Unknown fields answer HTTP 200
// with an `errors` array naming the field; an unknown repository is data null
// with no errors; an unauthenticated request is exactly 401.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  VIEWER,
  FIXED_TS,
  createIssue,
  createPull,
  mergePullSquash,
  pullFiles,
  pullMergeable,
  decodeGlobalId,
  commentGlobalId,
  touchIssue,
  type Repo,
  type Issue,
  type Pull,
} from './store.ts';
import { isAuthorized, parseJsonBody, sendError, sendJson, type ReqCtx } from './httputil.ts';

// ---------------------------------------------------------------- document parsing

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'spread'; value: '...' };

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && src.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@|&'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          const esc = src[j + 1]!;
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          out += src[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j]!)) j += 1;
      tokens.push({ kind: 'int', value: src.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j]!)) j += 1;
      tokens.push({ kind: 'name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return tokens;
}

/** One field in a selection set (or an inline fragment when `fragmentType` is set). */
export interface FieldNode {
  alias: string;
  name: string;
  args: Record<string, unknown>;
  selections: FieldNode[] | null;
  fragmentType: string | null;
}

/** One parsed operation: query or mutation, with its selection set. */
interface Operation {
  kind: 'query' | 'mutation';
  selections: FieldNode[];
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }
  private next(): Token {
    const tok = this.tokens[this.pos];
    if (tok === undefined) throw new Error('unexpected end of document');
    this.pos += 1;
    return tok;
  }
  private expectPunct(value: string): void {
    const tok = this.next();
    if (tok.kind !== 'punct' || tok.value !== value) throw new Error(`expected ${value}`);
  }
  private expectName(value?: string): string {
    const tok = this.next();
    if (tok.kind !== 'name') throw new Error('expected a name');
    if (value !== undefined && tok.value !== value) throw new Error(`expected ${value}`);
    return tok.value;
  }

  parseOperation(): Operation {
    let kind: 'query' | 'mutation' = 'query';
    const first = this.peek();
    if (first !== undefined && first.kind === 'name' && (first.value === 'query' || first.value === 'mutation')) {
      kind = this.next().value as 'query' | 'mutation';
      const maybeName = this.peek();
      if (maybeName !== undefined && maybeName.kind === 'name') this.next();
    }
    // Variable definitions: ($name: Type, ...) — skipped; values come from `variables`.
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') {
      let depth = 0;
      while (this.pos < this.tokens.length) {
        const tok = this.next();
        if (tok.kind === 'punct' && tok.value === '(') depth += 1;
        else if (tok.kind === 'punct' && tok.value === ')') {
          depth -= 1;
          if (depth === 0) break;
        }
      }
    }
    return { kind, selections: this.parseSelectionSet() };
  }

  private parseSelectionSet(): FieldNode[] {
    this.expectPunct('{');
    const fields: FieldNode[] = [];
    while (true) {
      const tok = this.peek();
      if (tok === undefined) throw new Error('unterminated selection set');
      if (tok.kind === 'punct' && tok.value === '}') {
        this.next();
        return fields;
      }
      fields.push(this.parseField());
    }
  }

  private parseField(): FieldNode {
    const tok = this.next();
    if (tok.kind === 'spread') {
      // Inline fragment: `... on Type { ... }` (fragment spreads are not used here).
      const on = this.peek();
      let fragmentType: string | null = null;
      if (on !== undefined && on.kind === 'name' && on.value === 'on') {
        this.next();
        fragmentType = this.expectName();
      }
      return { alias: '', name: '', args: {}, selections: this.parseSelectionSet(), fragmentType };
    }
    if (tok.kind !== 'name') throw new Error('expected a field name');
    let alias = tok.value;
    let name = tok.value;
    const colon = this.peek();
    if (colon !== undefined && colon.kind === 'punct' && colon.value === ':') {
      this.next();
      name = this.expectName();
    }
    const args: Record<string, unknown> = {};
    const open = this.peek();
    if (open !== undefined && open.kind === 'punct' && open.value === '(') {
      this.next();
      while (true) {
        const next = this.peek();
        if (next !== undefined && next.kind === 'punct' && next.value === ')') {
          this.next();
          break;
        }
        const argName = this.expectName();
        this.expectPunct(':');
        args[argName] = this.parseValue();
      }
    }
    let selections: FieldNode[] | null = null;
    const brace = this.peek();
    if (brace !== undefined && brace.kind === 'punct' && brace.value === '{') selections = this.parseSelectionSet();
    return { alias, name, args, selections, fragmentType: null };
  }

  parseValue(): unknown {
    const tok = this.next();
    if (tok.kind === 'string') return tok.value;
    if (tok.kind === 'int') return Number(tok.value);
    if (tok.kind === 'punct' && tok.value === '$') return { __variable: this.expectName() };
    if (tok.kind === 'punct' && tok.value === '[') {
      const items: unknown[] = [];
      while (true) {
        const next = this.peek();
        if (next !== undefined && next.kind === 'punct' && next.value === ']') {
          this.next();
          return items;
        }
        items.push(this.parseValue());
      }
    }
    if (tok.kind === 'punct' && tok.value === '{') {
      const obj: Record<string, unknown> = {};
      while (true) {
        const next = this.peek();
        if (next !== undefined && next.kind === 'punct' && next.value === '}') {
          this.next();
          return obj;
        }
        const key = this.expectName();
        this.expectPunct(':');
        obj[key] = this.parseValue();
      }
    }
    if (tok.kind === 'name') {
      if (tok.value === 'true') return true;
      if (tok.value === 'false') return false;
      if (tok.value === 'null') return null;
      return { __enum: tok.value };
    }
    throw new Error('unexpected value in GraphQL document');
  }
}

/** Substitute `$variables` and unwrap `{__enum}` markers in a parsed value. */
function substitute(value: unknown, variables: Record<string, unknown>): unknown {
  if (value !== null && typeof value === 'object') {
    if ('__variable' in (value as Record<string, unknown>)) {
      return variables[(value as { __variable: string }).__variable] ?? null;
    }
    if ('__enum' in (value as Record<string, unknown>)) return (value as { __enum: string }).__enum;
    if (Array.isArray(value)) return value.map((entry) => substitute(entry, variables));
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) out[key] = substitute(entry, variables);
    return out;
  }
  return value;
}

// ---------------------------------------------------------------- values

/** A resolved object value: its GraphQL type plus its raw fields. */
interface GqlObject {
  __typename: string;
  [key: string]: unknown;
}

function gqlObj(typename: string, fields: Record<string, unknown>): GqlObject {
  return { __typename: typename, ...fields };
}

function repoValue(repo: Repo): GqlObject {
  return gqlObj('Repository', { repo });
}
function issueValue(repo: Repo, issue: Issue): GqlObject {
  return gqlObj('Issue', { repo, issue });
}
function pullValue(repo: Repo, pull: Pull): GqlObject {
  return gqlObj('PullRequest', { repo, pull });
}
function userValue(login: string): GqlObject {
  return gqlObj('User', { login });
}

// ---------------------------------------------------------------- schema

/** The fields introspection reports for each type (the ones the suite probes, plus the usual). */
const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'closedAt', 'author', 'labels', 'comments', 'url', 'repository'],
  PullRequest: ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files', 'title', 'body', 'createdAt', 'closedAt', 'mergedAt', 'author', 'headRef', 'baseRef'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'isPrivate', 'url', 'createdAt'],
  SearchType: [],
  User: ['id', 'login', 'name'],
  Ref: ['id', 'name'],
  IssueConnection: ['nodes', 'pageInfo', 'totalCount', 'edges'],
  PullRequestConnection: ['nodes', 'pageInfo', 'totalCount', 'edges'],
  PullRequestChangedFileConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  PageInfo: ['hasNextPage', 'endCursor', 'hasPreviousPage', 'startCursor'],
  Comment: ['id', 'body', 'author', 'createdAt'],
};

/** The enum values introspection reports. */
const TYPE_ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'CODE'],
};

/** A field the schema does not hold. */
class UnknownField extends Error {
  readonly field: string;
  readonly parentType: string;
  constructor(field: string, parentType: string) {
    super(`Cannot query field "${field}" on type "${parentType}".`);
    this.field = field;
    this.parentType = parentType;
  }
}

/** A resolver failure: reported in `errors`, the field answers null. */
class GqlError extends Error {}

// ---------------------------------------------------------------- cursors

function encodeCursor(number: number): string {
  return Buffer.from(`cursor:${number}`).toString('base64');
}
function decodeCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    if (!text.startsWith('cursor:')) return null;
    const n = Number(text.slice(7));
    return Number.isInteger(n) ? n : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- resolvers

interface GqlCtx {
  store: import('./store.ts').Store;
}

function issueState(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}
function pullState(pull: Pull): string {
  if (pull.state === 'open') return 'OPEN';
  return pull.merged ? 'MERGED' : 'CLOSED';
}

/** The issues connection for a repository, with states/orderBy/first/after applied. */
function issuesConnection(repo: Repo, args: Record<string, unknown>): GqlObject {
  let list = [...repo.issues];
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((s) => String(s)));
    list = list.filter((issue) => wanted.has(issueState(issue)));
  }
  const orderBy = args.orderBy as Record<string, unknown> | undefined;
  const desc = orderBy !== undefined && orderBy.direction === 'DESC';
  list.sort((a, b) => (desc ? b.number - a.number : a.number - b.number));
  const after = typeof args.after === 'string' ? decodeCursor(args.after) : null;
  if (after !== null) list = list.filter((issue) => (desc ? issue.number < after : issue.number > after));
  const first = typeof args.first === 'number' ? args.first : list.length;
  const page = list.slice(0, first);
  const hasNextPage = list.length > page.length;
  const endCursor = page.length > 0 ? encodeCursor(page[page.length - 1]!.number) : null;
  return gqlObj('IssueConnection', {
    nodes: page.map((issue) => issueValue(repo, issue)),
    pageInfo: gqlObj('PageInfo', { hasNextPage, endCursor, hasPreviousPage: false, startCursor: page.length > 0 ? encodeCursor(page[0]!.number) : null }),
    totalCount: list.length,
  });
}

/** Resolve one field on a value. Throws UnknownField or GqlError. */
function resolveField(ctx: GqlCtx, parentType: string, parent: GqlObject, field: string, args: Record<string, unknown>): unknown {
  const repo = parent.repo as Repo | undefined;
  const issue = parent.issue as Issue | undefined;
  const pull = parent.pull as Pull | undefined;

  if (parentType === 'Query') {
    if (field === 'viewer') return userValue(VIEWER.login);
    if (field === 'repository') {
      const found = ctx.store.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
      return found === undefined ? null : repoValue(found);
    }
    if (field === 'node') {
      const decoded = decodeGlobalId(String(args.id ?? ''));
      if (decoded === null) return null;
      const found = ctx.store.getRepoByDbId(decoded.databaseId);
      if (found === undefined) return null;
      if (decoded.kind === 'R') return repoValue(found);
      if (decoded.kind === 'I') {
        const foundIssue = found.issuesByNumber.get(decoded.number);
        return foundIssue === undefined ? null : issueValue(found, foundIssue);
      }
      if (decoded.kind === 'P') {
        const foundPull = found.pullsByNumber.get(decoded.number);
        return foundPull === undefined ? null : pullValue(found, foundPull);
      }
      return null;
    }
    if (field === '__type') {
      const name = String(args.name ?? '');
      if (!(name in TYPE_FIELDS) && !(name in TYPE_ENUM_VALUES)) return null;
      return gqlObj('__Type', { name, kind: name in TYPE_ENUM_VALUES ? 'ENUM' : 'OBJECT' });
    }
    throw new UnknownField(field, parentType);
  }

  if (parentType === 'Mutation') {
    if (field === 'createIssue') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
      if (decoded === null || decoded.kind !== 'R') throw new GqlError('createIssue: unknown repository');
      const target = ctx.store.getRepoByDbId(decoded.databaseId);
      if (target === undefined) throw new GqlError('createIssue: unknown repository');
      const created = createIssue(target, String(input.title ?? ''), String(input.body ?? ''), []);
      return gqlObj('CreateIssuePayload', { issue: issueValue(target, created) });
    }
    if (field === 'closeIssue') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeGlobalId(String(input.issueId ?? ''));
      if (decoded === null || decoded.kind !== 'I') throw new GqlError('closeIssue: unknown issue');
      const target = ctx.store.getRepoByDbId(decoded.databaseId);
      const found = target?.issuesByNumber.get(decoded.number);
      if (target === undefined || found === undefined) throw new GqlError('closeIssue: unknown issue');
      found.state = 'closed';
      found.closed_at = FIXED_TS;
      found.updated_at = FIXED_TS;
      touchIssue(found);
      return gqlObj('CloseIssuePayload', { issue: issueValue(target, found) });
    }
    if (field === 'createPullRequest') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
      if (decoded === null || decoded.kind !== 'R') throw new GqlError('createPullRequest: unknown repository');
      const target = ctx.store.getRepoByDbId(decoded.databaseId);
      if (target === undefined) throw new GqlError('createPullRequest: unknown repository');
      try {
        const created = createPull(target, String(input.title ?? ''), String(input.body ?? ''), String(input.headRefName ?? ''), String(input.baseRefName ?? ''));
        return gqlObj('CreatePullRequestPayload', { pullRequest: pullValue(target, created) });
      } catch {
        throw new GqlError('createPullRequest: head or base branch does not exist');
      }
    }
    if (field === 'mergePullRequest') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeGlobalId(String(input.pullRequestId ?? ''));
      if (decoded === null || decoded.kind !== 'P') throw new GqlError('mergePullRequest: unknown pull request');
      const target = ctx.store.getRepoByDbId(decoded.databaseId);
      const found = target?.pullsByNumber.get(decoded.number);
      if (target === undefined || found === undefined) throw new GqlError('mergePullRequest: unknown pull request');
      const merged = mergePullSquash(target, found);
      if (merged === null) throw new GqlError('mergePullRequest: pull request cannot be merged');
      return gqlObj('MergePullRequestPayload', { pullRequest: pullValue(target, found) });
    }
    if (field === 'addComment') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeGlobalId(String(input.subjectId ?? ''));
      if (decoded === null || decoded.kind !== 'I') throw new GqlError('addComment: unknown subject');
      const target = ctx.store.getRepoByDbId(decoded.databaseId);
      const found = target?.issuesByNumber.get(decoded.number);
      if (target === undefined || found === undefined) throw new GqlError('addComment: unknown subject');
      const comment = {
        id: target.nextComment++,
        body: String(input.body ?? ''),
        user: { login: VIEWER.login, id: VIEWER.id, type: VIEWER.type },
        created_at: FIXED_TS,
        updated_at: FIXED_TS,
      };
      found.comments.push(comment);
      touchIssue(found);
      const node = gqlObj('Comment', {
        id: commentGlobalId(target.databaseId, found.number, comment.id),
        body: comment.body,
      });
      return gqlObj('AddCommentPayload', { commentEdge: gqlObj('IssueCommentEdge', { node }) });
    }
    throw new UnknownField(field, parentType);
  }

  if (parentType === 'Repository' && repo !== undefined) {
    if (field === 'id') return repo.id;
    if (field === 'databaseId') return repo.databaseId;
    if (field === 'name') return repo.name;
    if (field === 'nameWithOwner') return `${repo.owner}/${repo.name}`;
    if (field === 'owner') return userValue(repo.owner);
    if (field === 'defaultBranchRef') return gqlObj('Ref', { name: repo.defaultBranch });
    if (field === 'viewerPermission') return 'ADMIN';
    if (field === 'hasIssuesEnabled') return true;
    if (field === 'description') return repo.description;
    if (field === 'isPrivate') return repo.private;
    if (field === 'url') return `/api/v3/repos/${repo.owner}/${repo.name}`;
    if (field === 'createdAt') return FIXED_TS;
    if (field === 'issue') {
      const found = repo.issuesByNumber.get(Number(args.number ?? 0));
      return found === undefined ? null : issueValue(repo, found);
    }
    if (field === 'issues') return issuesConnection(repo, args);
    if (field === 'pullRequests') {
      const first = typeof args.first === 'number' ? args.first : repo.pulls.length;
      const page = [...repo.pulls].sort((a, b) => b.number - a.number).slice(0, first);
      return gqlObj('PullRequestConnection', {
        nodes: page.map((entry) => pullValue(repo, entry)),
        pageInfo: gqlObj('PageInfo', { hasNextPage: repo.pulls.length > page.length, endCursor: null, hasPreviousPage: false, startCursor: null }),
        totalCount: repo.pulls.length,
      });
    }
    if (field === 'pullRequest') {
      const found = repo.pullsByNumber.get(Number(args.number ?? 0));
      return found === undefined ? null : pullValue(repo, found);
    }
    throw new UnknownField(field, parentType);
  }

  if (parentType === 'Issue' && issue !== undefined) {
    if (field === 'id') return issue.id;
    if (field === 'number') return issue.number;
    if (field === 'title') return issue.title;
    if (field === 'body') return issue.body;
    if (field === 'state') return issueState(issue);
    if (field === 'createdAt') return issue.created_at;
    if (field === 'updatedAt') return issue.updated_at;
    if (field === 'closedAt') return issue.closed_at;
    if (field === 'author') return userValue(issue.user.login);
    if (field === 'url') return `/api/v3/repos/${repo!.owner}/${repo!.name}/issues/${issue.number}`;
    throw new UnknownField(field, parentType);
  }

  if (parentType === 'PullRequest' && pull !== undefined) {
    if (field === 'id') return pull.id;
    if (field === 'number') return pull.number;
    if (field === 'title') return pull.title;
    if (field === 'body') return pull.body;
    if (field === 'headRefName') return pull.headRef;
    if (field === 'baseRefName') return pull.baseRef;
    if (field === 'mergeable') return pullMergeable(repo!, pull);
    if (field === 'state') return pullState(pull);
    if (field === 'merged') return pull.merged;
    if (field === 'createdAt') return pull.created_at;
    if (field === 'closedAt') return pull.closed_at;
    if (field === 'mergedAt') return pull.merged_at;
    if (field === 'author') return userValue(pull.user.login);
    if (field === 'files') {
      const first = typeof args.first === 'number' ? args.first : 100;
      const files = pullFiles(repo!, pull).slice(0, first);
      return gqlObj('PullRequestChangedFileConnection', {
        nodes: files.map((file) => gqlObj('PullRequestChangedFile', { path: file.filename, additions: file.additions, deletions: file.deletions })),
        pageInfo: gqlObj('PageInfo', { hasNextPage: false, endCursor: null, hasPreviousPage: false, startCursor: null }),
        totalCount: files.length,
      });
    }
    throw new UnknownField(field, parentType);
  }

  if (parentType === 'User') {
    if (field === 'login') return String(parent.login ?? '');
    if (field === 'id') return VIEWER.id;
    if (field === 'name') return VIEWER.name;
    throw new UnknownField(field, parentType);
  }

  if (parentType === 'Ref') {
    if (field === 'name') return String(parent.name ?? '');
    throw new UnknownField(field, parentType);
  }

  if (parentType === 'IssueConnection' || parentType === 'PullRequestConnection' || parentType === 'PullRequestChangedFileConnection') {
    if (field === 'nodes') return (parent.nodes as unknown[]) ?? [];
    if (field === 'pageInfo') return parent.pageInfo as GqlObject;
    if (field === 'totalCount') return parent.totalCount as number;
    if (field === 'edges') return [];
    throw new UnknownField(field, parentType);
  }

  if (parentType === 'PageInfo') {
    if (field === 'hasNextPage') return Boolean(parent.hasNextPage);
    if (field === 'endCursor') return (parent.endCursor as string | null) ?? null;
    if (field === 'hasPreviousPage') return Boolean(parent.hasPreviousPage);
    if (field === 'startCursor') return (parent.startCursor as string | null) ?? null;
    throw new UnknownField(field, parentType);
  }

  if (parentType === 'PullRequestChangedFile') {
    if (field === 'path') return String(parent.path ?? '');
    if (field === 'additions') return Number(parent.additions ?? 0);
    if (field === 'deletions') return Number(parent.deletions ?? 0);
    throw new UnknownField(field, parentType);
  }

  if (parentType === '__Type') {
    if (field === 'name') return String(parent.name ?? '');
    if (field === 'kind') return String(parent.kind ?? 'OBJECT');
    if (field === 'fields') {
      const names = TYPE_FIELDS[String(parent.name ?? '')] ?? [];
      return names.map((name) => gqlObj('__Field', { name }));
    }
    if (field === 'enumValues') {
      const names = TYPE_ENUM_VALUES[String(parent.name ?? '')] ?? [];
      return names.map((name) => gqlObj('__EnumValue', { name }));
    }
    throw new UnknownField(field, parentType);
  }

  if (parentType === '__Field' || parentType === '__EnumValue') {
    if (field === 'name') return String(parent.name ?? '');
    throw new UnknownField(field, parentType);
  }

  if (parentType === 'Comment') {
    if (field === 'id') return String(parent.id ?? '');
    if (field === 'body') return String(parent.body ?? '');
    if (field === 'createdAt') return FIXED_TS;
    throw new UnknownField(field, parentType);
  }

  // Payload objects: resolve the wrapped field by name.
  if (parentType === 'CreateIssuePayload' || parentType === 'CloseIssuePayload') {
    if (field === 'issue') return parent.issue as GqlObject;
    throw new UnknownField(field, parentType);
  }
  if (parentType === 'CreatePullRequestPayload' || parentType === 'MergePullRequestPayload') {
    if (field === 'pullRequest') return parent.pullRequest as GqlObject;
    throw new UnknownField(field, parentType);
  }
  if (parentType === 'AddCommentPayload') {
    if (field === 'commentEdge') return parent.commentEdge as GqlObject;
    throw new UnknownField(field, parentType);
  }
  if (parentType === 'IssueCommentEdge') {
    if (field === 'node') return parent.node as GqlObject;
    throw new UnknownField(field, parentType);
  }

  throw new UnknownField(field, parentType);
}

// ---------------------------------------------------------------- execution

interface GqlErrorEntry {
  message: string;
}

/** Execute a selection set on an object; null when an unknown field voids the object. */
function executeObject(
  ctx: GqlCtx,
  parentType: string,
  parent: GqlObject,
  selections: FieldNode[],
  variables: Record<string, unknown>,
  errors: GqlErrorEntry[],
): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  for (const field of selections) {
    if (field.fragmentType !== null) {
      if (parent.__typename !== field.fragmentType) continue;
      const merged = executeObject(ctx, parentType, parent, field.selections ?? [], variables, errors);
      if (merged === null) return null;
      Object.assign(out, merged);
      continue;
    }
    const args: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(field.args)) args[key] = substitute(value, variables);
    let value: unknown;
    try {
      value = resolveField(ctx, parentType, parent, field.name, args);
    } catch (err) {
      if (err instanceof UnknownField) {
        errors.push({ message: err.message });
        return null;
      }
      if (err instanceof GqlError) {
        errors.push({ message: err.message });
        out[field.alias] = null;
        continue;
      }
      throw err;
    }
    if (value === null || value === undefined) {
      out[field.alias] = null;
      continue;
    }
    if (field.selections !== null) {
      if (Array.isArray(value)) {
        const items: Array<Record<string, unknown> | null> = [];
        for (const entry of value) {
          if (entry !== null && typeof entry === 'object' && '__typename' in (entry as Record<string, unknown>)) {
            items.push(executeObject(ctx, (entry as GqlObject).__typename, entry as GqlObject, field.selections, variables, errors));
          } else items.push(null);
        }
        out[field.alias] = items;
      } else if (typeof value === 'object' && '__typename' in (value as Record<string, unknown>)) {
        out[field.alias] = executeObject(ctx, (value as GqlObject).__typename, value as GqlObject, field.selections, variables, errors);
      } else {
        out[field.alias] = null;
      }
      continue;
    }
    out[field.alias] = value;
  }
  return out;
}

/** Execute one operation document. */
function executeOperation(ctx: GqlCtx, op: Operation, variables: Record<string, unknown>): { data: Record<string, unknown> | null; errors: GqlErrorEntry[] } {
  const errors: GqlErrorEntry[] = [];
  const rootType = op.kind === 'mutation' ? 'Mutation' : 'Query';
  const data = executeObject(ctx, rootType, gqlObj(rootType, {}), op.selections, variables, errors);
  return { data, errors };
}

// ---------------------------------------------------------------- HTTP handler

/** Handle POST /api/graphql: one operation or a batched array of operations. */
export function handleGraphql(ctx: ReqCtx, req: IncomingMessage, res: ServerResponse, rawBody: Buffer): boolean {
  if (!isAuthorized(ctx, req)) {
    sendError(ctx, res, 401, 'Bad credentials');
    return true;
  }
  const parsed = parseJsonBody(ctx, res, rawBody);
  if (parsed === null) return true;
  const gqlCtx: GqlCtx = { store: ctx.store };
  const runOne = (entry: unknown): Record<string, unknown> => {
    const record = (entry !== null && typeof entry === 'object' && !Array.isArray(entry) ? entry : {}) as Record<string, unknown>;
    const query = typeof record.query === 'string' ? record.query : '';
    const variables = (record.variables !== null && typeof record.variables === 'object' && !Array.isArray(record.variables) ? record.variables : {}) as Record<string, unknown>;
    if (query === '') return { errors: [{ message: 'No query provided' }] };
    let op: Operation;
    try {
      op = new Parser(tokenize(query)).parseOperation();
    } catch (err) {
      return { errors: [{ message: err instanceof Error ? err.message : 'could not parse query' }] };
    }
    const { data, errors } = executeOperation(gqlCtx, op, variables);
    return errors.length > 0 ? { data, errors } : { data };
  };
  if (Array.isArray(parsed)) {
    sendJson(res, 200, parsed.map((entry) => runOne(entry)), { 'x-github-request-id': ctx.nextReqId() });
  } else {
    sendJson(res, 200, runOne(parsed), { 'x-github-request-id': ctx.nextReqId() });
  }
  return true;
}
