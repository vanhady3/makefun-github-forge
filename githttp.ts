// githttp.ts — git smart HTTP: info/refs advertisements, upload-pack (v2 and v0),
// receive-pack (v0). The packfile codec lives in gitutil.ts; the object store in store.ts.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  ZERO_OID,
  pktLine,
  pktFlush,
  pktDelim,
  encodePktLines,
  decodePktLines,
  writePack,
  readPack,
  verifyPackChecksum,
  parseCommit,
  parseTag,
  parseTree,
  type GitObject,
} from './gitutil.ts';
import { isAncestor, commitParents, type Repo } from './store.ts';
import { isAuthorized, sendBuffer, sendError, type ReqCtx } from './httputil.ts';

const AGENT = 'mamang-forge/1.0';
const UPLOAD_CAPS = `side-band-64k thin-pack ofs-delta shallow multi_ack agent=${AGENT} symref=HEAD:refs/heads/main`;
const RECEIVE_CAPS = `report-status side-band-64k delete-refs agent=${AGENT}`;

/** The refs of a repo, sorted by name, with their peeled commit for annotated tags. */
function sortedRefs(repo: Repo): Array<{ ref: string; oid: string; peeled: string | null }> {
  const out: Array<{ ref: string; oid: string; peeled: string | null }> = [];
  const refs = [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  for (const [ref, oid] of refs) {
    let peeled: string | null = null;
    const obj = repo.objects.get(oid);
    if (obj !== undefined && obj.type === 'tag') {
      const tag = parseTag(obj.data);
      if (tag.type === 'commit') peeled = tag.object;
    }
    out.push({ ref, oid, peeled });
  }
  return out;
}

/** The tip of the repo's default branch, or the zero id when it is unborn. */
function headTip(repo: Repo): string {
  return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? ZERO_OID;
}

// ---------------------------------------------------------------- advertisements

/** The v2 capability advertisement for upload-pack. */
function advertisementV2(): Buffer {
  return Buffer.concat([
    pktLine('# service=git-upload-pack\n'),
    pktFlush(),
    pktLine('version 2\n'),
    pktLine(`agent=${AGENT}\n`),
    pktLine('ls-refs\n'),
    pktLine('fetch=shallow filter\n'),
    pktLine('server-option\n'),
    pktLine('object-format=sha1\n'),
    pktFlush(),
  ]);
}

/** The v0 ref advertisement for a service. The first line carries the capabilities. */
function advertisementV0(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack' ? UPLOAD_CAPS : RECEIVE_CAPS;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), pktFlush()];
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const tip = headTip(repo);
    parts.push(pktLine(`${tip} HEAD\0${caps}\n`));
    for (const { ref, oid, peeled } of refs) {
      parts.push(pktLine(`${oid} ${ref}\n`));
      if (peeled !== null) parts.push(pktLine(`${peeled} ${ref}^{}\n`));
    }
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- fetch selection

interface FetchSelection {
  /** Objects to send, in deterministic (oid-sorted) order. */
  objects: Array<{ oid: string; object: GitObject }>;
  shallow: string[];
  unshallow: string[];
  acks: string[];
  nak: boolean;
}

/** Collect a tree's objects (trees and blobs, recursively) into `out`. */
function collectTreeObjects(repo: Repo, treeOid: string, out: Map<string, GitObject>): void {
  const obj = repo.objects.get(treeOid);
  if (obj === undefined || obj.type !== 'tree') return;
  if (out.has(treeOid)) return;
  out.set(treeOid, obj);
  for (const entry of parseTree(obj.data)) {
    const child = repo.objects.get(entry.oid);
    if (child === undefined) continue;
    if (child.type === 'tree') collectTreeObjects(repo, entry.oid, out);
    else if (!out.has(entry.oid)) out.set(entry.oid, child);
  }
}

/**
 * Decide what a fetch sends: objects reachable from the wants (limited by depth),
 * minus objects reachable from the haves — where the have-walk never descends past
 * a commit the client lists as shallow (its parents are not held by the client).
 * Shallow boundaries are the included commits whose parents are not included; an old
 * shallow boundary that is now included and is not a boundary any more is unshallow.
 */
function selectFetch(
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  reqShallow: ReadonlySet<string>,
  depth: number | null,
): FetchSelection {
  const included = new Map<string, GitObject>();
  const includedCommits = new Set<string>();
  const queue: Array<{ oid: string; dist: number }> = wants.map((oid) => ({ oid, dist: 0 }));
  const seen = new Set<string>();
  while (queue.length > 0) {
    const { oid, dist } = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (obj === undefined) continue;
    if (obj.type === 'commit') {
      if (depth !== null && dist >= depth) continue;
      included.set(oid, obj);
      includedCommits.add(oid);
      const parsed = parseCommit(obj.data);
      collectTreeObjects(repo, parsed.tree, included);
      for (const parent of parsed.parents) queue.push({ oid: parent, dist: dist + 1 });
    } else if (obj.type === 'tag') {
      included.set(oid, obj);
      const tag = parseTag(obj.data);
      queue.push({ oid: tag.object, dist });
    } else {
      included.set(oid, obj);
    }
  }
  // Objects the client already holds: everything reachable from the haves.
  const held = new Set<string>();
  const hqueue: string[] = [...haves];
  const hseen = new Set<string>();
  while (hqueue.length > 0) {
    const oid = hqueue.shift()!;
    if (hseen.has(oid)) continue;
    hseen.add(oid);
    const obj = repo.objects.get(oid);
    if (obj === undefined) continue;
    held.add(oid);
    if (obj.type === 'commit') {
      const parsed = parseCommit(obj.data);
      const treeHeld = new Map<string, GitObject>();
      collectTreeObjects(repo, parsed.tree, treeHeld);
      for (const key of treeHeld.keys()) held.add(key);
      // Never descend past a commit the client lists as shallow: its parents are
      // not held by the client, so they must stay out of the held set.
      if (reqShallow.has(oid)) continue;
      for (const parent of parsed.parents) hqueue.push(parent);
    } else if (obj.type === 'tag') {
      hqueue.push(parseTag(obj.data).object);
    }
  }
  const objects: Array<{ oid: string; object: GitObject }> = [];
  for (const [oid, object] of included) if (!held.has(oid)) objects.push({ oid, object });
  objects.sort((a, b) => (a.oid < b.oid ? -1 : a.oid > b.oid ? 1 : 0));

  let shallow: string[] = [];
  if (depth !== null) {
    for (const oid of includedCommits) {
      const parents = commitParents(repo, oid);
      if (parents.some((p) => !includedCommits.has(p))) shallow.push(oid);
    }
    shallow.sort();
  }
  const shallowSet = new Set(shallow);
  const unshallow: string[] = [];
  for (const oid of reqShallow) if (includedCommits.has(oid) && !shallowSet.has(oid)) unshallow.push(oid);
  unshallow.sort();

  const acks: string[] = [];
  for (const have of haves) if (repo.objects.has(have)) acks.push(have);
  return { objects, shallow, unshallow, acks, nak: acks.length === 0 };
}

/** Split a pack into sideband band-1 pkt-lines (at most 65515 data bytes per packet). */
function sidebandPack(pack: Buffer): Buffer[] {
  const out: Buffer[] = [];
  for (let pos = 0; pos < pack.length; pos += 65515) {
    const chunk = pack.subarray(pos, Math.min(pack.length, pos + 65515));
    out.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return out;
}

// ---------------------------------------------------------------- upload-pack

/** The v2 ls-refs answer: one pkt-line per matching ref, then a flush. */
function lsRefsResponse(
  repo: Repo,
  opts: { peel: boolean; symrefs: boolean; unborn: boolean; prefixes: string[] },
): Buffer {
  const parts: Buffer[] = [];
  const keep = (name: string): boolean => opts.prefixes.length === 0 || opts.prefixes.some((p) => name.startsWith(p));
  const tip = headTip(repo);
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    if (opts.unborn) parts.push(pktLine(`unborn refs/heads/${repo.defaultBranch}\n`));
  } else {
    if (keep('HEAD')) {
      parts.push(pktLine(opts.symrefs ? `${tip} HEAD symref-target:refs/heads/${repo.defaultBranch}\n` : `${tip} HEAD\n`));
    }
    for (const { ref, oid, peeled } of refs) {
      if (!keep(ref)) continue;
      parts.push(pktLine(opts.peel && peeled !== null ? `${oid} ${ref} peeled:${peeled}\n` : `${oid} ${ref}\n`));
    }
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** The v2 fetch answer: acknowledgments, shallow-info, then the packfile section. */
function fetchV2Response(sel: FetchSelection): Buffer {
  const parts: Buffer[] = [];
  parts.push(pktLine('acknowledgments\n'));
  if (sel.nak) parts.push(pktLine('NAK\n'));
  for (const ack of sel.acks) parts.push(pktLine(`ACK ${ack}\n`));
  parts.push(pktLine('ready\n'));
  parts.push(pktDelim());
  if (sel.shallow.length > 0 || sel.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of sel.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of sel.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(pktDelim());
  }
  if (sel.objects.length > 0) {
    const pack = writePack(sel.objects.map((entry) => entry.object));
    parts.push(pktLine('packfile\n'));
    for (const chunk of sidebandPack(pack)) parts.push(chunk);
    parts.push(pktFlush());
  }
  return Buffer.concat(parts);
}

/** The v0 fetch answer: plain NAK/ACK/shallow lines, then the sideband pack. */
function fetchV0Response(sel: FetchSelection): Buffer {
  const parts: Buffer[] = [];
  if (sel.nak) parts.push(pktLine('NAK\n'));
  for (const ack of sel.acks) parts.push(pktLine(`ACK ${ack}\n`));
  for (const oid of sel.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of sel.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  if (sel.objects.length > 0) {
    const pack = writePack(sel.objects.map((entry) => entry.object));
    for (const chunk of sidebandPack(pack)) parts.push(chunk);
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** Handle POST git-upload-pack: a v2 command (ls-refs/fetch) or a v0 fetch. */
function handleUploadPack(ctx: ReqCtx, repo: Repo, body: Buffer, isV2: boolean, res: ServerResponse): void {
  const { packets } = decodePktLines(body);
  if (!isV2) {
    // v0: wants (+features on the first line) / shallow / deepen, flush, haves / done, flush.
    const wants: string[] = [];
    const haves: string[] = [];
    const shallow = new Set<string>();
    let depth: number | null = null;
    let section = 0;
    for (const packet of packets) {
      if (packet.kind === 'flush') {
        section += 1;
        continue;
      }
      if (packet.kind !== 'data') continue;
      const line = packet.payload.toString('utf8').replace(/\n$/, '');
      if (section === 0) {
        if (line.startsWith('want ')) wants.push(line.slice(5).split(' ')[0]!);
        else if (line.startsWith('shallow ')) shallow.add(line.slice(8).trim());
        else if (line.startsWith('deepen ')) depth = Number(line.slice(7));
      } else if (line.startsWith('have ')) {
        haves.push(line.slice(5).trim());
      }
    }
    const sel = selectFetch(repo, wants, haves, shallow, depth);
    sendBuffer(res, 200, fetchV0Response(sel), 'application/x-git-upload-pack-result');
    return;
  }
  // v2: command lines, delim, argument lines, flush.
  let command = '';
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow = new Set<string>();
  let depth: number | null = null;
  let afterDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      afterDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (!afterDelim) {
      if (line.startsWith('command=')) command = line.slice(8);
      continue;
    }
    if (command === 'ls-refs') {
      if (line === 'peel') peel = true;
      else if (line === 'symrefs') symrefs = true;
      else if (line === 'unborn') unborn = true;
      else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice(11));
    } else if (command === 'fetch') {
      if (line.startsWith('want ')) wants.push(line.slice(5).trim());
      else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
      else if (line.startsWith('shallow ')) shallow.add(line.slice(8).trim());
      else if (line.startsWith('deepen ')) depth = Number(line.slice(7));
    }
  }
  if (command === 'ls-refs') {
    sendBuffer(res, 200, lsRefsResponse(repo, { peel, symrefs, unborn, prefixes }), 'application/x-git-upload-pack-result');
    return;
  }
  if (command === 'fetch') {
    if (wants.length === 0) {
      sendBuffer(res, 200, fetchV2Response({ objects: [], shallow: [], unshallow: [], acks: [], nak: true }), 'application/x-git-upload-pack-result');
      return;
    }
    const sel = selectFetch(repo, wants, haves, shallow, depth);
    sendBuffer(res, 200, fetchV2Response(sel), 'application/x-git-upload-pack-result');
    return;
  }
  sendError(ctx, res, 400, `unknown command ${command}`);
}

// ---------------------------------------------------------------- receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** Apply one push command with fast-forward rules; returns ok or the ng reason. */
function applyPushCommand(repo: Repo, cmd: PushCommand): { ok: boolean; reason: string } {
  const current = repo.refs.get(cmd.ref);
  if (cmd.newOid === ZERO_OID) {
    if (current === undefined || current !== cmd.oldOid) return { ok: false, reason: 'non-fast-forward' };
    repo.refs.delete(cmd.ref);
    return { ok: true, reason: '' };
  }
  if (!repo.objects.has(cmd.newOid)) return { ok: false, reason: 'non-fast-forward' };
  if (cmd.oldOid === ZERO_OID) {
    if (current !== undefined) return { ok: false, reason: 'non-fast-forward' };
    repo.refs.set(cmd.ref, cmd.newOid);
    return { ok: true, reason: '' };
  }
  if (current === undefined || current !== cmd.oldOid) return { ok: false, reason: 'non-fast-forward' };
  if (!isAncestor(repo, current, cmd.newOid)) return { ok: false, reason: 'non-fast-forward' };
  repo.refs.set(cmd.ref, cmd.newOid);
  return { ok: true, reason: '' };
}

/** Handle POST git-receive-pack: command list, then the pack, then the report. */
function handleReceivePack(ctx: ReqCtx, repo: Repo, body: Buffer, res: ServerResponse): void {
  let commands: PushCommand[] = [];
  let packOffset = body.length;
  try {
    // The command list ends at the first flush packet; the raw pack follows it, so
    // decode pkt-lines only up to that flush (the pack bytes are not pkt-lines).
    packOffset = offsetAfterFirstFlush(body);
    const { packets } = decodePktLines(body.subarray(0, packOffset));
    let first = true;
    let seenFlush = false;
    for (const packet of packets) {
      if (packet.kind === 'flush') {
        seenFlush = true;
        break;
      }
      if (packet.kind !== 'data') continue;
      let line = packet.payload.toString('utf8').replace(/\n$/, '');
      if (first) {
        first = false;
        const nul = line.indexOf('\0');
        if (nul >= 0) line = line.slice(0, nul);
      }
      const parts = line.split(' ');
      if (parts.length >= 3) commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts.slice(2).join(' ') });
    }
    if (!seenFlush) throw new Error('no flush after command list');
  } catch {
    // A malformed body must not crash the server; the check only needs it to stay up.
    sendError(ctx, res, 400, 'malformed receive-pack request');
    return;
  }
  // The pack, when there is one (a delete-only push carries none). Store its objects
  // first: git unpacks before it applies any ref update.
  const packBytes = body.subarray(packOffset);
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (packBytes.length > 0) {
    try {
      const checksum = verifyPackChecksum(packBytes);
      if (!checksum.ok) throw new Error('pack trailer checksum mismatch');
      const { objects } = readPack(packBytes);
      for (const [oid, object] of objects) if (!repo.objects.has(oid)) repo.objects.set(oid, object);
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : 'unpack error';
    }
  }
  const reportLines: Array<string | 'flush'> = [unpackOk ? 'unpack ok\n' : `unpack ${unpackDetail}\n`];
  if (unpackOk) {
    for (const cmd of commands) {
      const result = applyPushCommand(repo, cmd);
      reportLines.push(result.ok ? `ok ${cmd.ref}\n` : `ng ${cmd.ref} ${result.reason}\n`);
    }
  } else {
    for (const cmd of commands) reportLines.push(`ng ${cmd.ref} unpack error\n`);
  }
  reportLines.push('flush');
  const inner = encodePktLines(reportLines);
  // Each inner pkt-line rides inside a sideband band-1 packet; a final outer flush ends it.
  const outer: Buffer[] = [];
  let pos = 0;
  while (pos < inner.length) {
    if (inner.subarray(pos, pos + 4).toString('ascii') === '0000') {
      outer.push(pktLine(Buffer.concat([Buffer.from([1]), Buffer.from('0000', 'ascii')])));
      pos += 4;
      continue;
    }
    const len = parseInt(inner.subarray(pos, pos + 4).toString('ascii'), 16);
    outer.push(pktLine(Buffer.concat([Buffer.from([1]), inner.subarray(pos, pos + len)])));
    pos += len;
  }
  outer.push(pktFlush());
  sendBuffer(res, 200, Buffer.concat(outer), 'application/x-git-receive-pack-result');
}

/** The offset just past the first flush packet in `body`, or the body length. */
function offsetAfterFirstFlush(body: Buffer): number {
  let pos = 0;
  while (pos + 4 <= body.length) {
    const head = body.subarray(pos, pos + 4).toString('ascii');
    if (head === '0000') return pos + 4;
    if (head === '0001') {
      pos += 4;
      continue;
    }
    const len = parseInt(head, 16);
    if (!Number.isFinite(len) || len < 4 || pos + len > body.length) return body.length;
    pos += len;
  }
  return body.length;
}

// ---------------------------------------------------------------- entry point

/**
 * Handle a git smart-HTTP request. `parts` is the path after `/<owner>/<repo>.git/`.
 * Returns true when the path is a git route (even when it answers 404/401).
 */
export function handleGit(ctx: ReqCtx, req: IncomingMessage, res: ServerResponse, owner: string, repoName: string, parts: string[], body: Buffer): boolean {
  if (parts.length === 0) return false;
  const isInfoRefs = parts.length === 2 && parts[0] === 'info' && parts[1] === 'refs';
  const isUpload = parts.length === 1 && parts[0] === 'git-upload-pack';
  const isReceive = parts.length === 1 && parts[0] === 'git-receive-pack';
  if (!isInfoRefs && !isUpload && !isReceive) return false;
  if (!isAuthorized(ctx, req)) {
    sendError(ctx, res, 401, 'Bad credentials');
    return true;
  }
  const repo = ctx.store.getRepo(owner, repoName);
  if (repo === undefined) {
    sendError(ctx, res, 404, 'Not Found');
    return true;
  }
  try {
    if (isInfoRefs) {
      const url = new URL(req.url ?? '/', 'http://entry');
      const service = url.searchParams.get('service');
      if (service === 'git-upload-pack') {
        const isV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
        sendBuffer(res, 200, isV2 ? advertisementV2() : advertisementV0(repo, 'git-upload-pack'), 'application/x-git-upload-pack-advertisement');
      } else if (service === 'git-receive-pack') {
        sendBuffer(res, 200, advertisementV0(repo, 'git-receive-pack'), 'application/x-git-receive-pack-advertisement');
      } else {
        sendError(ctx, res, 404, 'Not Found');
      }
      return true;
    }
    if (isUpload) {
      if (req.method !== 'POST') {
        sendError(ctx, res, 405, 'Method Not Allowed');
        return true;
      }
      const isV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
      handleUploadPack(ctx, repo, body, isV2, res);
      return true;
    }
    if (req.method !== 'POST') {
      sendError(ctx, res, 405, 'Method Not Allowed');
      return true;
    }
    handleReceivePack(ctx, repo, body, res);
    return true;
  } catch (err) {
    // A malformed git request must never take the server down.
    try {
      sendError(ctx, res, 400, err instanceof Error ? err.message : 'malformed request');
    } catch {
      // The response is already gone; nothing left to do.
    }
    return true;
  }
}
