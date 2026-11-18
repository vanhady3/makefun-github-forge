// store.ts — the forge's in-memory store and its domain operations.
//
// One process, one store, no disk: every scored surface (git smart HTTP, REST v3,
// GraphQL v4, MCP) reads and writes the same objects, so a change on one surface is
// visible on the others at once. Behaviour is deterministic: sequential ids, fixed
// timestamps, no randomness, no wall clock in any scored output.

import { ZERO_OID, hashObject, parseCommit, parseTree, buildTree, buildCommit, type GitObject, type ObjType } from './gitutil.ts';

/** A fixed timestamp for every created/updated/merged record. Deterministic: no clock. */
export const FIXED_TS = '2026-01-01T00:00:00Z';

/** The token owner, hard-coded from the sealed scenario seed (the same in every trial). */
export const VIEWER = { login: 'adaiversen', id: 1000, type: 'User', name: 'ada iversen' } as const;
/** The stranger login, for ownership checks (a repo under another owner is 404, never 403). */
export const STRANGER = { login: 'olgabauer', id: 1002, type: 'User' } as const;
/** The scenario org. */
export const ORG = 'faint-meadow-org';

/** A user reference as REST/GraphQL render it. */
export interface UserRef {
  login: string;
  id: number;
  type: string;
}

/** One issue comment. `id` is the numeric REST id; the GraphQL id is derived. */
export interface Comment {
  id: number;
  body: string;
  user: UserRef;
  created_at: string;
  updated_at: string;
}

/** One label on a repository. */
export interface Label {
  name: string;
  color: string;
}

/** One issue. `jsonCache` holds the last rendered JSON string; cleared on any mutation. */
export interface Issue {
  id: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  user: UserRef;
  comments: Comment[];
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  jsonCache: string | null;
}

/** One pull request. */
export interface Pull {
  id: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  merged_at: string | null;
  merge_commit_sha: string | null;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  user: UserRef;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

/** One repository: its metadata, its git objects and refs, and its issues and pulls. */
export interface Repo {
  owner: string;
  name: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  databaseId: number;
  /** The opaque global id: the same string REST and GraphQL report as `id`. */
  id: string;
  /** Creation order, for stable list ordering. */
  seq: number;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Issue[];
  issuesByNumber: Map<number, Issue>;
  pulls: Pull[];
  pullsByNumber: Map<number, Pull>;
  nextIssue: number;
  nextPull: number;
  nextComment: number;
}

/** Opaque global ids: base64 of a typed key, never the plain database id or number. */
export function repoGlobalId(databaseId: number): string {
  return Buffer.from(`R:${databaseId}`).toString('base64');
}
export function issueGlobalId(databaseId: number, number: number): string {
  return Buffer.from(`I:${databaseId}:${number}`).toString('base64');
}
export function pullGlobalId(databaseId: number, number: number): string {
  return Buffer.from(`P:${databaseId}:${number}`).toString('base64');
}
export function commentGlobalId(databaseId: number, issueNumber: number, commentId: number): string {
  return Buffer.from(`C:${databaseId}:${issueNumber}:${commentId}`).toString('base64');
}

/** Decode an opaque global id back to its typed key, or null when it is not one. */
export function decodeGlobalId(id: string): { kind: string; databaseId: number; number: number; commentId: number } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const parts = text.split(':');
    if (parts.length < 2) return null;
    const databaseId = Number(parts[1]);
    if (!Number.isInteger(databaseId)) return null;
    return { kind: parts[0]!, databaseId, number: Number(parts[2] ?? 0), commentId: Number(parts[3] ?? 0) };
  } catch {
    return null;
  }
}

/** The whole forge state. */
export class Store {
  repos = new Map<string, Repo>();
  nextDbId = 5000;
  nextSeq = 1;

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  createRepo(owner: string, name: string, description: string, isPrivate: boolean): Repo | null {
    const key = this.key(owner, name);
    if (this.repos.has(key)) return null;
    const databaseId = this.nextDbId++;
    const repo: Repo = {
      owner,
      name,
      description,
      private: isPrivate,
      defaultBranch: 'main',
      databaseId,
      id: repoGlobalId(databaseId),
      seq: this.nextSeq++,
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: [],
      issuesByNumber: new Map(),
      pulls: [],
      pullsByNumber: new Map(),
      nextIssue: 1,
      nextPull: 1,
      nextComment: 1,
    };
    this.repos.set(key, repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  getRepoByDbId(databaseId: number): Repo | undefined {
    for (const repo of this.repos.values()) if (repo.databaseId === databaseId) return repo;
    return undefined;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  listReposByOwner(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === owner) out.push(repo);
    out.sort((a, b) => a.seq - b.seq);
    return out;
  }
}

/** The user reference for the token owner. */
export function viewerRef(): UserRef {
  return { login: VIEWER.login, id: VIEWER.id, type: VIEWER.type };
}

// ---------------------------------------------------------------- git graph operations

/** Store an object in a repo (idempotent) and return its id. */
export function storeObject(repo: Repo, type: ObjType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

/** The parents of a commit object, or [] when the object is not a commit. */
export function commitParents(repo: Repo, oid: string): string[] {
  const obj = repo.objects.get(oid);
  if (obj === undefined || obj.type !== 'commit') return [];
  return parseCommit(obj.data).parents;
}

/** Whether `anc` is `desc` itself or one of its ancestors (a parent walk). */
export function isAncestor(repo: Repo, anc: string, desc: string): boolean {
  if (anc === desc) return true;
  const seen = new Set<string>();
  const stack: string[] = [desc];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (cur === anc) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const parent of commitParents(repo, cur)) stack.push(parent);
  }
  return false;
}

/**
 * The merge-base of two commits: the nearest common ancestor. Walks `a`'s ancestors
 * with their distance, then walks `b`'s ancestors breadth-first and takes the first
 * one `a` also reaches (the shallowest from `b`, which for linear histories is the
 * newest common commit). Null when the histories share nothing.
 */
export function mergeBase(repo: Repo, a: string, b: string): string | null {
  const distA = new Map<string, number>();
  const queueA: Array<[string, number]> = [[a, 0]];
  while (queueA.length > 0) {
    const [cur, d] = queueA.shift()!;
    if (distA.has(cur)) continue;
    distA.set(cur, d);
    for (const parent of commitParents(repo, cur)) queueA.push([parent, d + 1]);
  }
  const seenB = new Set<string>();
  const queueB: string[] = [b];
  while (queueB.length > 0) {
    const cur = queueB.shift()!;
    if (seenB.has(cur)) continue;
    seenB.add(cur);
    if (distA.has(cur)) return cur;
    for (const parent of commitParents(repo, cur)) queueB.push(parent);
  }
  return null;
}

/** One flattened tree entry: a path and the blob (or subtree) it holds. */
export interface FlatEntry {
  mode: string;
  oid: string;
}

/** Flatten a tree (recursively) into path -> entry. Null tree means an empty tree. */
export function flattenTree(repo: Repo, treeOid: string | null, prefix = ''): Map<string, FlatEntry> {
  const out = new Map<string, FlatEntry>();
  if (treeOid === null) return out;
  const obj = repo.objects.get(treeOid);
  if (obj === undefined || obj.type !== 'tree') return out;
  for (const entry of parseTree(obj.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') {
      for (const [sub, subEntry] of flattenTree(repo, entry.oid, path)) out.set(sub, subEntry);
    } else {
      out.set(path, { mode: entry.mode, oid: entry.oid });
    }
  }
  return out;
}

/** The tree a commit points at, or null when the commit is unknown. */
export function commitTree(repo: Repo, commitOid: string): string | null {
  const obj = repo.objects.get(commitOid);
  if (obj === undefined || obj.type !== 'commit') return null;
  return parseCommit(obj.data).tree;
}

/** One changed path between two trees. */
export interface DiffEntry {
  path: string;
  status: 'added' | 'modified' | 'removed';
  oldOid: string | null;
  newOid: string | null;
}

/** Diff two trees (null = empty): one entry per path that changed. */
export function diffTrees(repo: Repo, baseTree: string | null, headTree: string | null): DiffEntry[] {
  const base = flattenTree(repo, baseTree);
  const head = flattenTree(repo, headTree);
  const out: DiffEntry[] = [];
  const paths = new Set<string>([...base.keys(), ...head.keys()]);
  for (const path of paths) {
    const b = base.get(path);
    const h = head.get(path);
    if (b !== undefined && h === undefined) out.push({ path, status: 'removed', oldOid: b.oid, newOid: null });
    else if (b === undefined && h !== undefined) out.push({ path, status: 'added', oldOid: null, newOid: h.oid });
    else if (b !== undefined && h !== undefined && b.oid !== h.oid) out.push({ path, status: 'modified', oldOid: b.oid, newOid: h.oid });
  }
  out.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
  return out;
}

/** Count the lines of a blob (a trailing newline does not make an extra line). */
export function lineCount(data: Buffer): number {
  if (data.length === 0) return 0;
  const text = data.toString('utf8');
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.length;
}

/** Line-level additions/deletions between two blobs (multiset difference of lines). */
export function lineDiff(oldData: Buffer | null, newData: Buffer | null): { additions: number; deletions: number } {
  const oldLines = oldData === null ? [] : oldData.toString('utf8').split('\n').filter((l, i, a) => !(i === a.length - 1 && l === ''));
  const newLines = newData === null ? [] : newData.toString('utf8').split('\n').filter((l, i, a) => !(i === a.length - 1 && l === ''));
  const oldCount = new Map<string, number>();
  for (const line of oldLines) oldCount.set(line, (oldCount.get(line) ?? 0) + 1);
  let additions = 0;
  for (const line of newLines) {
    const n = oldCount.get(line) ?? 0;
    if (n > 0) oldCount.set(line, n - 1);
    else additions += 1;
  }
  let deletions = 0;
  for (const n of oldCount.values()) deletions += n;
  return { additions, deletions };
}

/** One pull-request file entry, as REST reports it. */
export interface PullFile {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

/** The files a pull request changes: diff of the merge-base tree against the head tree. */
export function pullFiles(repo: Repo, pull: Pull): PullFile[] {
  const base = mergeBase(repo, pull.headSha, pull.baseSha);
  const baseTree = base === null ? null : commitTree(repo, base);
  const headTree = commitTree(repo, pull.headSha);
  const out: PullFile[] = [];
  for (const diff of diffTrees(repo, baseTree, headTree)) {
    const oldData = diff.oldOid === null ? null : (repo.objects.get(diff.oldOid)?.data ?? null);
    const newData = diff.newOid === null ? null : (repo.objects.get(diff.newOid)?.data ?? null);
    const { additions, deletions } = lineDiff(oldData, newData);
    out.push({ filename: diff.path, status: diff.status, additions, deletions, changes: additions + deletions });
  }
  return out;
}

/**
 * Whether a pull request is conflicted: head and base both changed the same path
 * differently since the merge-base (different resulting content, or one side deleted
 * what the other modified).
 */
export function pullConflicted(repo: Repo, pull: Pull): boolean {
  const base = mergeBase(repo, pull.headSha, pull.baseSha);
  const baseTree = base === null ? null : commitTree(repo, base);
  const baseFlat = flattenTree(repo, baseTree);
  const headFlat = flattenTree(repo, commitTree(repo, pull.headSha));
  // The base side is the base branch's CURRENT tip, not the sha captured when the
  // pull request was opened: a merge that lands after the PR opens can conflict it.
  const currentBaseTip = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
  const baseBranchFlat = flattenTree(repo, commitTree(repo, currentBaseTip));
  const paths = new Set<string>([...baseFlat.keys(), ...headFlat.keys(), ...baseBranchFlat.keys()]);
  for (const path of paths) {
    const b = baseFlat.get(path)?.oid ?? null;
    const h = headFlat.get(path)?.oid ?? null;
    const s = baseBranchFlat.get(path)?.oid ?? null;
    const headChanged = h !== b;
    const baseChanged = s !== b;
    if (headChanged && baseChanged && h !== s) return true;
  }
  return false;
}

// ---------------------------------------------------------------- contents commits

/**
 * Rebuild a tree with one path replaced by a blob (or removed when `blobOid` is null).
 * `segments` is the path split on '/'. Returns the new tree's id; intermediate trees
 * are created and stored as needed. An empty subtree is pruned.
 */
export function updateTree(repo: Repo, treeOid: string | null, segments: readonly string[], blobOid: string | null): string | null {
  const obj = treeOid === null ? undefined : repo.objects.get(treeOid);
  const entries = obj !== undefined && obj.type === 'tree' ? parseTree(obj.data) : [];
  const byName = new Map<string, { mode: string; name: string; oid: string }>();
  for (const entry of entries) byName.set(entry.name, entry);
  const [head, ...rest] = segments;
  if (head === undefined) return treeOid;
  if (rest.length === 0) {
    if (blobOid === null) byName.delete(head);
    else byName.set(head, { mode: '100644', name: head, oid: blobOid });
  } else {
    const child = byName.get(head);
    const childTree = child !== undefined && child.mode === '40000' ? child.oid : null;
    const next = updateTree(repo, childTree, rest, blobOid);
    if (next === null) byName.delete(head);
    else byName.set(head, { mode: '40000', name: head, oid: next });
  }
  if (byName.size === 0) return null;
  return storeObject(repo, 'tree', buildTree([...byName.values()]));
}

/** The result of a contents write. */
export interface ContentsWrite {
  commitOid: string;
  contentSha: string;
  created: boolean;
}

/**
 * Write a file through the contents API: store the blob, rebuild the trees up to the
 * root, commit on `branch` (creating the branch at the default tip when it does not
 * exist yet, or the first commit when the repo is unborn), and move the ref.
 * `expectedSha` is the blob sha the caller believes the file has: a mismatch is a 409.
 */
export function writeContents(
  repo: Repo,
  branch: string,
  path: string,
  content: Buffer,
  message: string,
  expectedSha?: string,
): ContentsWrite {
  const ref = `refs/heads/${branch}`;
  let tip = repo.refs.get(ref);
  if (tip === undefined && branch !== repo.defaultBranch) {
    tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    if (tip !== undefined) repo.refs.set(ref, tip);
  }
  const segments = path.split('/').filter((s) => s !== '');
  if (segments.length === 0) throw new Error('empty path');
  // 201 when the file is new on this branch, 200 when it replaces an existing file:
  // the branch's existence says nothing (a new branch inherits the default tip).
  const existed = tip === undefined ? false : blobAtPath(repo, commitTree(repo, tip), path) !== null;
  if (expectedSha !== undefined) {
    const current = tip === undefined ? null : blobAtPath(repo, commitTree(repo, tip), path);
    if (current === null || current.oid !== expectedSha) {
      const err = new Error('sha mismatch') as Error & { code?: string };
      err.code = 'SHA_MISMATCH';
      throw err;
    }
  }
  const blobOid = storeObject(repo, 'blob', content);
  const parentTree = tip === undefined ? null : commitTree(repo, tip);
  const newTree = updateTree(repo, parentTree, segments, blobOid);
  if (newTree === null) throw new Error('empty tree');
  const created = !existed;
  const commitOid = storeObject(
    repo,
    'commit',
    buildCommit({ tree: newTree, parents: tip === undefined ? [] : [tip], message }),
  );
  repo.refs.set(ref, commitOid);
  return { commitOid, contentSha: blobOid, created };
}

/** The blob at a path in a tree, or null when the path is not a file there. */
export function blobAtPath(repo: Repo, treeOid: string | null, path: string): { oid: string; data: Buffer } | null {
  const flat = flattenTree(repo, treeOid);
  const entry = flat.get(path);
  if (entry === undefined) return null;
  const obj = repo.objects.get(entry.oid);
  if (obj === undefined || obj.type !== 'blob') return null;
  return { oid: entry.oid, data: obj.data };
}

/**
 * Delete a file through the contents API: rebuild the trees without it, commit on
 * `branch`, and move the ref. Throws with code SHA_MISMATCH when the file or the
 * expected sha is wrong.
 */
export function deleteContents(repo: Repo, branch: string, path: string, message: string, expectedSha?: string): string {
  const ref = `refs/heads/${branch}`;
  const tip = repo.refs.get(ref);
  if (tip === undefined) throw Object.assign(new Error('no such branch'), { code: 'NO_BRANCH' });
  const segments = path.split('/').filter((s) => s !== '');
  if (segments.length === 0) throw Object.assign(new Error('empty path'), { code: 'NO_FILE' });
  const current = blobAtPath(repo, commitTree(repo, tip), path);
  if (current === null) throw Object.assign(new Error('no such file'), { code: 'NO_FILE' });
  if (expectedSha !== undefined && current.oid !== expectedSha) {
    throw Object.assign(new Error('sha mismatch'), { code: 'SHA_MISMATCH' });
  }
  const newTree = updateTree(repo, commitTree(repo, tip), segments, null);
  const commitOid = storeObject(
    repo,
    'commit',
    buildCommit({ tree: newTree ?? storeObject(repo, 'tree', buildTree([])), parents: [tip], message }),
  );
  repo.refs.set(ref, commitOid);
  return commitOid;
}

// ---------------------------------------------------------------- issues and pulls

/** Create an issue on a repo (labels must already exist; unknown labels are a 422). */
export function createIssue(repo: Repo, title: string, body: string, labelNames: readonly string[]): Issue {
  const labels: Label[] = [];
  for (const name of labelNames) {
    const label = repo.labels.get(name);
    if (label === undefined) {
      throw Object.assign(new Error(`Label does not exist: ${name}`), { code: 'UNKNOWN_LABEL' });
    }
    labels.push({ name: label.name, color: label.color });
  }
  const number = repo.nextIssue++;
  const issue: Issue = {
    id: issueGlobalId(repo.databaseId, number),
    number,
    title,
    body,
    state: 'open',
    labels,
    user: viewerRef(),
    comments: [],
    created_at: FIXED_TS,
    updated_at: FIXED_TS,
    closed_at: null,
    jsonCache: null,
  };
  repo.issues.push(issue);
  repo.issuesByNumber.set(number, issue);
  return issue;
}

/** Clear an issue's cached rendering after any mutation of it. */
export function touchIssue(issue: Issue): void {
  issue.jsonCache = null;
}

/** Create a pull request on a repo. Head and base must be existing branches. */
export function createPull(repo: Repo, title: string, body: string, headRef: string, baseRef: string): Pull {
  const headSha = repo.refs.get(`refs/heads/${headRef}`);
  const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
  if (headSha === undefined || baseSha === undefined) {
    throw Object.assign(new Error('head or base branch does not exist'), { code: 'NO_BRANCH' });
  }
  const number = repo.nextPull++;
  const pull: Pull = {
    id: pullGlobalId(repo.databaseId, number),
    number,
    title,
    body,
    state: 'open',
    merged: false,
    merged_at: null,
    merge_commit_sha: null,
    headRef,
    baseRef,
    headSha,
    baseSha,
    user: viewerRef(),
    created_at: FIXED_TS,
    updated_at: FIXED_TS,
    closed_at: null,
  };
  repo.pulls.push(pull);
  repo.pullsByNumber.set(number, pull);
  return pull;
}

/** The mergeable state a pull request reports over GraphQL. */
export function pullMergeable(repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
  if (pull.state !== 'open') return 'UNKNOWN';
  return pullConflicted(repo, pull) ? 'CONFLICTING' : 'MERGEABLE';
}

/**
 * Merge a pull request with a squash commit: one commit on the base branch whose tree
 * is the head tree, then the PR closes as merged. Returns null when conflicted.
 */
export function mergePullSquash(repo: Repo, pull: Pull): { sha: string; message: string } | null {
  if (pull.state !== 'open') return null;
  if (pullConflicted(repo, pull)) return null;
  const headTree = commitTree(repo, pull.headSha);
  if (headTree === null) return null;
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  if (baseTip === undefined) return null;
  const message = pull.title;
  const sha = storeObject(repo, 'commit', buildCommit({ tree: headTree, parents: [baseTip], message }));
  repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
  pull.state = 'closed';
  pull.merged = true;
  pull.merged_at = FIXED_TS;
  pull.merge_commit_sha = sha;
  pull.closed_at = FIXED_TS;
  pull.updated_at = FIXED_TS;
  return { sha, message };
}

/** The commit history of a branch tip, newest first. */
export function commitHistory(repo: Repo, tip: string): Array<{ sha: string; message: string }> {
  const out: Array<{ sha: string; message: string }> = [];
  const seen = new Set<string>();
  const stack: string[] = [tip];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const obj = repo.objects.get(cur);
    if (obj === undefined || obj.type !== 'commit') continue;
    const parsed = parseCommit(obj.data);
    out.push({ sha: cur, message: parsed.message });
    for (const parent of parsed.parents) stack.push(parent);
  }
  return out;
}

export { ZERO_OID };
