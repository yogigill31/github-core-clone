// The forge's in-memory model: repositories, refs, git objects, issues, pull requests,
// labels and comments — plus the git object primitives (hashing, trees, commits,
// reachability, three-way merge) the REST, GraphQL, MCP and smart-HTTP surfaces share.
//
// The token owner's login is not passed to the entry by the harness; it is the scenario's
// viewer, fixed by the contest's one seed (wire.ts SCENARIO_SEED, "never change it: it is
// the contest's fixed data"). The derivation below is the same PRNG the env uses, so the
// entry names the same viewer the checks address, without hard-coding the login itself.

import { createHash } from 'node:crypto';

export const ZERO_OID = '0000000000000000000000000000000000000000';
export const CONFORMANCE_IDENTITY = 'Conformance <conformance@make.fun>';
export const DEFAULT_BRANCH = 'main';

// ---------------------------------------------------------------------------
// The scenario's viewer (wire.ts buildScenario, one fixed seed)
// ---------------------------------------------------------------------------

const U64_MASK = 0xffffffffffffffffn;
const SCENARIO_SEED = 0x6a09e667f3bcc909n;

function fnv1a64(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & U64_MASK;
  }
  return hash;
}

function mix64(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & U64_MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64_MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64_MASK;
  return (z ^ (z >> 31n)) & U64_MASK;
}

class ScenarioRng {
  #state: bigint;
  constructor(seed: bigint) {
    const masked = seed & U64_MASK;
    this.#state = masked === 0n ? SCENARIO_SEED : masked;
  }
  nextU32(): number {
    let x = this.#state;
    x = (x ^ (x >> 12n)) & U64_MASK;
    x = (x ^ (x << 25n)) & U64_MASK;
    x = (x ^ (x >> 27n)) & U64_MASK;
    this.#state = x;
    return Number(((x * 0x2545f4914f6cdd1dn) & U64_MASK) >> 32n);
  }
  nextInt(maxExclusive: number): number {
    if (maxExclusive === 1) return 0;
    const range = 4_294_967_296;
    const limit = range - (range % maxExclusive);
    for (;;) {
      const value = this.nextU32();
      if (value < limit) return value % maxExclusive;
    }
  }
  pick<T>(items: readonly T[]): T {
    return items[this.nextInt(items.length)];
  }
}

const FIRST_NAMES = [
  'ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars',
  'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane',
];
const LAST_NAMES = [
  'anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller',
  'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber',
  'xu', 'yilmaz', 'zimmer',
];

/** The first user of the scenario's seeded users: the token owner. */
export function scenarioViewerLogin(): string {
  const rng = new ScenarioRng(mix64(SCENARIO_SEED ^ fnv1a64('users')));
  const first = rng.pick(FIRST_NAMES);
  const last = rng.pick(LAST_NAMES);
  return `${first}${last}`.replace(/[^a-z0-9-]/g, '');
}

export const VIEWER_LOGIN = scenarioViewerLogin();
export const VIEWER_ID = 1000;

// ---------------------------------------------------------------------------
// Git object primitives
// ---------------------------------------------------------------------------

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** The object id of a git object: sha1("<type> <size>\0" + data). */
export function hashObject(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return sha1Hex(Buffer.concat([header, data]));
}

export function isObjectId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{40}$/i.test(value);
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode');
    const mode = data.subarray(offset, space).toString('ascii');
    const nul = data.indexOf(0x00, space);
    if (nul < 0 || nul + 21 > data.length) throw new Error('tree entry has no name');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headerText = data.subarray(0, headerEnd).toString('utf8');
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of headerText.split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  if (!isObjectId(tree)) throw new Error('commit has no valid tree header');
  return { tree, parents, author, committer, message };
}

export interface TagView {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): TagView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headers = new Map<string, string>();
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space < 0) continue;
    headers.set(line.slice(0, space), line.slice(space + 1));
  }
  return {
    object: headers.get('object') ?? '',
    type: headers.get('type') ?? '',
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : data.subarray(blank + 2).toString('utf8'),
  };
}

/** Git's tree-name order: a directory compares as if its name ended in '/'. */
function treeNameCompare(a: string, aIsDir: boolean, b: string, bIsDir: boolean): number {
  const an = aIsDir ? `${a}/` : a;
  const bn = bIsDir ? `${b}/` : b;
  if (an < bn) return -1;
  if (an > bn) return 1;
  return 0;
}

/** Build one tree object from its entries (sorted git order). */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((x, y) =>
    treeNameCompare(x.name, x.mode === '40000', y.name, y.mode === '40000'));
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/**
 * Build the nested trees for a flat path -> blob map. Returns the root tree's oid
 * and every tree object created (blobs are the caller's).
 */
export function buildTreesForFiles(
  files: ReadonlyMap<string, { oid: string; mode: string }>,
): { root: string; objects: Map<string, GitObject> } {
  const created = new Map<string, GitObject>();
  const buildDir = (prefix: string): string => {
    const entries: TreeEntry[] = [];
    const subdirs = new Set<string>();
    for (const [path, file] of files) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash < 0) {
        entries.push({ mode: file.mode, name: rest, oid: file.oid });
      } else {
        subdirs.add(rest.slice(0, slash));
      }
    }
    for (const dir of [...subdirs].sort()) {
      entries.push({ mode: '40000', name: dir, oid: buildDir(`${prefix}${dir}/`) });
    }
    const data = buildTree(entries);
    const oid = hashObject('tree', data);
    created.set(oid, { type: 'tree', data });
    return oid;
  };
  const root = buildDir('');
  return { root, objects: created };
}

/** Flatten a tree (recursively) to path -> {oid, mode}. */
export function flattenTree(
  lookup: (oid: string) => GitObject | undefined,
  treeOid: string,
  prefix = '',
  out: Map<string, { oid: string; mode: string }> = new Map(),
): Map<string, { oid: string; mode: string }> {
  const tree = lookup(treeOid);
  if (tree === undefined || tree.type !== 'tree') return out;
  for (const entry of parseTree(tree.data)) {
    if (entry.mode === '40000') {
      flattenTree(lookup, entry.oid, `${prefix}${entry.name}/`, out);
    } else if (entry.mode !== '160000') {
      out.set(`${prefix}${entry.name}`, { oid: entry.oid, mode: entry.mode });
    }
  }
  return out;
}

/** Every object reachable from `roots`: commit -> tree + parents, tag -> target, tree -> entries. */
export function collectReachable(
  roots: Iterable<string>,
  lookup: (oid: string) => GitObject | undefined,
  options: { allowMissing?: boolean; stopAt?: ReadonlySet<string> } = {},
): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) if (isObjectId(root)) queue.push(root);
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    if (options.stopAt?.has(oid)) {
      seen.add(oid);
      continue;
    }
    const object = lookup(oid);
    if (object === undefined) {
      if (options.allowMissing) continue;
      throw new Error(`object ${oid} is missing from the store`);
    }
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      for (const parent of commit.parents) queue.push(parent);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '160000') continue;
        queue.push(entry.oid);
      }
    }
  }
  return seen;
}

/** True when `ancestor` is an ancestor of `tip` (or the same commit). */
export function isAncestor(
  lookup: (oid: string) => GitObject | undefined,
  ancestor: string,
  tip: string,
): boolean {
  if (ancestor === tip) return true;
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length) {
    const oid = queue.pop()!;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = lookup(oid);
    if (object?.type === 'commit') queue.push(...parseCommit(object.data).parents);
  }
  return false;
}

/** The nearest common ancestor of two commits (BFS from both sides). */
export function mergeBase(
  lookup: (oid: string) => GitObject | undefined,
  a: string,
  b: string,
): string | null {
  if (a === b) return a;
  const ancestorsA = new Set<string>();
  const queueA = [a];
  while (queueA.length) {
    const oid = queueA.pop()!;
    if (ancestorsA.has(oid)) continue;
    ancestorsA.add(oid);
    const object = lookup(oid);
    if (object?.type === 'commit') queueA.push(...parseCommit(object.data).parents);
  }
  const queueB = [b];
  const seenB = new Set<string>();
  while (queueB.length) {
    const oid = queueB.pop()!;
    if (ancestorsA.has(oid)) return oid;
    if (seenB.has(oid)) continue;
    seenB.add(oid);
    const object = lookup(oid);
    if (object?.type === 'commit') queueB.push(...parseCommit(object.data).parents);
  }
  return null;
}

/** Line counts for a file diff (a tiny LCS over lines; files here are small). */
export function lineDiffCounts(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldLines = oldText === '' ? [] : oldText.split('\n');
  const newLines = newText === '' ? [] : newText.split('\n');
  if (oldText.endsWith('\n')) oldLines.pop();
  if (newText.endsWith('\n')) newLines.pop();
  const n = oldLines.length;
  const m = newLines.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i]![j] = oldLines[i] === newLines[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const common = dp[0]![0]!;
  return { additions: m - common, deletions: n - common };
}

// ---------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------

export interface Label {
  name: string;
  color: string;
}

export interface Comment {
  id: number;
  body: string;
  createdSeq: number;
}

export interface Issue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  createdSeq: number;
  comments: Comment[];
}

export interface Pull {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  createdSeq: number;
}

export interface Repo {
  owner: string;
  name: string;
  dbId: number;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  refs: Map<string, string>;
  objects: Map<string, GitObject>;
  issues: Issue[];
  pulls: Pull[];
  labels: Label[];
  issueSeq: number;
  pullSeq: number;
  commentSeq: number;
  createdSeq: number;
}

export class Store {
  repos = new Map<string, Repo>();
  seq = 0;
  nextDbId = 1;
  requestSeq = 0;
  /** Monotonic commit clock: 1700000000 + n, so every server-made commit is unique. */
  commitSeq = 0;

  key(owner: string, name: string): string {
    return `${owner.toLowerCase()}/${name.toLowerCase()}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  createRepo(owner: string, name: string, isPrivate: boolean, description: string): Repo {
    const repo: Repo = {
      owner,
      name,
      dbId: this.nextDbId,
      description,
      isPrivate,
      defaultBranch: DEFAULT_BRANCH,
      refs: new Map(),
      objects: new Map(),
      issues: [],
      pulls: [],
      labels: [],
      issueSeq: 0,
      pullSeq: 0,
      commentSeq: 0,
      createdSeq: ++this.seq,
    };
    this.nextDbId += 1;
    this.repos.set(this.key(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  listViewerRepos(): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) {
      if (repo.owner === VIEWER_LOGIN) out.push(repo);
    }
    out.sort((a, b) => a.createdSeq - b.createdSeq);
    return out;
  }

  nextRequestId(): string {
    this.requestSeq += 1;
    return `req-${this.requestSeq}`;
  }

  /** Store an object, verifying its id; returns the id. */
  putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    repo.objects.set(oid, { type, data });
    return oid;
  }

  /** Build and store a commit the server authors (REST contents, merges). */
  makeCommit(repo: Repo, treeOid: string, parents: readonly string[], message: string): string {
    const timestamp = 1700000000 + this.commitSeq;
    this.commitSeq += 1;
    const who = `${CONFORMANCE_IDENTITY} ${timestamp} +0000`;
    const lines = [`tree ${treeOid}`];
    for (const parent of parents) lines.push(`parent ${parent}`);
    lines.push(`author ${who}`, `committer ${who}`, '');
    const data = Buffer.from(`${lines.join('\n')}\n${message}`, 'utf8');
    return this.putObject(repo, 'commit', data);
  }

  /** The files at a ref tip (empty map when the ref does not exist). */
  filesAt(repo: Repo, ref: string): Map<string, { oid: string; mode: string }> {
    const tip = repo.refs.get(ref);
    if (tip === undefined) return new Map();
    const commit = repo.objects.get(tip);
    if (commit?.type !== 'commit') return new Map();
    return flattenTree((oid) => repo.objects.get(oid), parseCommit(commit.data).tree);
  }

  /** Commit a new tree on a branch: builds the trees, the commit, stores them, moves the ref. */
  commitFiles(
    repo: Repo,
    branch: string,
    files: ReadonlyMap<string, { oid: string; mode: string }>,
    message: string,
  ): string {
    const { root, objects } = buildTreesForFiles(files);
    for (const [oid, object] of objects) repo.objects.set(oid, object);
    const parent = repo.refs.get(`refs/heads/${branch}`);
    const commitOid = this.makeCommit(repo, root, parent === undefined ? [] : [parent], message);
    repo.refs.set(`refs/heads/${branch}`, commitOid);
    return commitOid;
  }

  /** Commits reachable from a ref, newest first (BFS, parents after the child). */
  commitsFrom(repo: Repo, tip: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const queue = [tip];
    while (queue.length) {
      const oid = queue.shift()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (object?.type !== 'commit') continue;
      out.push(oid);
      queue.push(...parseCommit(object.data).parents);
    }
    return out;
  }

  /** The changed files of a pull request: merge-base tree vs head tree. */
  pullFiles(repo: Repo, pull: Pull): Array<{ filename: string; status: string; additions: number; deletions: number; changes: number; oldOid: string | null; newOid: string | null }> {
    const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
    const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
    if (headTip === undefined || baseTip === undefined) return [];
    const base = mergeBase((oid) => repo.objects.get(oid), headTip, baseTip) ?? baseTip;
    const baseFiles = this.filesAtRef(repo, base);
    const headFiles = this.filesAtRef(repo, headTip);
    const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
    const out: Array<{ filename: string; status: string; additions: number; deletions: number; changes: number; oldOid: string | null; newOid: string | null }> = [];
    for (const path of [...paths].sort()) {
      const oldEntry = baseFiles.get(path);
      const newEntry = headFiles.get(path);
      if (oldEntry?.oid === newEntry?.oid) continue;
      const oldText = oldEntry === undefined ? '' : this.blobText(repo, oldEntry.oid);
      const newText = newEntry === undefined ? '' : this.blobText(repo, newEntry.oid);
      const { additions, deletions } = lineDiffCounts(oldText, newText);
      const status = oldEntry === undefined ? 'added' : newEntry === undefined ? 'removed' : 'modified';
      out.push({
        filename: path,
        status,
        additions: status === 'removed' ? 0 : additions,
        deletions: status === 'added' ? 0 : deletions,
        changes: additions + deletions,
        oldOid: oldEntry?.oid ?? null,
        newOid: newEntry?.oid ?? null,
      });
    }
    return out;
  }

  filesAtRef(repo: Repo, commitOid: string): Map<string, { oid: string; mode: string }> {
    const commit = repo.objects.get(commitOid);
    if (commit?.type !== 'commit') return new Map();
    return flattenTree((oid) => repo.objects.get(oid), parseCommit(commit.data).tree);
  }

  blobText(repo: Repo, oid: string): string {
    const object = repo.objects.get(oid);
    if (object?.type !== 'blob') return '';
    return object.data.toString('utf8');
  }

  /** Three-way merge for a pull request: squash onto the base tip. */
  mergePull(repo: Repo, pull: Pull): { ok: true; commitSha: string } | { ok: false; reason: string } {
    const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
    const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
    if (headTip === undefined || baseTip === undefined) return { ok: false, reason: 'missing branch' };
    const base = mergeBase((oid) => repo.objects.get(oid), headTip, baseTip);
    if (base === null) return { ok: false, reason: 'no merge base' };
    const baseFiles = this.filesAtRef(repo, base);
    const headFiles = this.filesAtRef(repo, headTip);
    const tipFiles = this.filesAtRef(repo, baseTip);
    const merged = new Map<string, { oid: string; mode: string }>();
    const paths = new Set([...baseFiles.keys(), ...headFiles.keys(), ...tipFiles.keys()]);
    for (const path of paths) {
      const b = baseFiles.get(path);
      const h = headFiles.get(path);
      const t = tipFiles.get(path);
      const headChanged = h?.oid !== b?.oid;
      const tipChanged = t?.oid !== b?.oid;
      if (headChanged && tipChanged && h?.oid !== t?.oid) {
        return { ok: false, reason: 'conflict' };
      }
      const chosen = headChanged ? h : t;
      if (chosen !== undefined) merged.set(path, chosen);
    }
    const trees = buildTreesForFiles(merged);
    for (const [oid, object] of trees.objects) repo.objects.set(oid, object);
    const rootTreeOid = trees.root;
    const message = `Merge pull request #${pull.number} from ${pull.headRef}`;
    const commitSha = this.makeCommit(repo, rootTreeOid, [baseTip], message);
    repo.refs.set(`refs/heads/${pull.baseRef}`, commitSha);
    return { ok: true, commitSha };
  }

  /** Is this pull request mergeable right now (no three-way conflict)? */
  pullMergeable(repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
    if (pull.state !== 'open') return 'UNKNOWN';
    const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
    const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
    if (headTip === undefined || baseTip === undefined) return 'UNKNOWN';
    const base = mergeBase((oid) => repo.objects.get(oid), headTip, baseTip);
    if (base === null) return 'UNKNOWN';
    const baseFiles = this.filesAtRef(repo, base);
    const headFiles = this.filesAtRef(repo, headTip);
    const tipFiles = this.filesAtRef(repo, baseTip);
    const paths = new Set([...baseFiles.keys(), ...headFiles.keys(), ...tipFiles.keys()]);
    for (const path of paths) {
      const b = baseFiles.get(path);
      const h = headFiles.get(path);
      const t = tipFiles.get(path);
      if (h?.oid !== b?.oid && t?.oid !== b?.oid && h?.oid !== t?.oid) return 'CONFLICTING';
    }
    return 'MERGEABLE';
  }
}

// ---------------------------------------------------------------------------
// Global ids (opaque, stable, decodable by the entry)
// ---------------------------------------------------------------------------

export function globalId(kind: string, ...parts: string[]): string {
  return Buffer.from([kind, ...parts].join(':'), 'utf8').toString('base64url');
}

export function parseGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const [kind, ...parts] = text.split(':');
    if (kind === undefined || kind === '' || parts.some((p) => p === '')) return null;
    return { kind, parts };
  } catch {
    return null;
  }
}
