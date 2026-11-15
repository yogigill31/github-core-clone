// GitHub REST v3: repositories, contents, branches, commits, issues, labels,
// comments and pull requests, over the in-memory store. Every reply is JSON and
// carries an X-GitHub-Request-Id; a missing token is a 401 (auth is the app's job,
// this module only assumes the caller checked it).

import {
  VIEWER_LOGIN,
  VIEWER_ID,
  ZERO_OID,
  isObjectId,
  parseCommit,
  buildTreesForFiles,
  globalId,
  type Repo,
  type Issue,
  type Pull,
  type Store,
} from './store.ts';

export interface RestResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

const json = (status: number, body: unknown, headers?: Record<string, string>): RestResult => ({ status, body, headers });
const message = (status: number, text: string): RestResult => json(status, { message: text });
const notFound = (): RestResult => message(404, 'Not Found');

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

function repoView(repo: Repo): Record<string, unknown> {
  return {
    id: repo.dbId,
    node_id: globalId('repo', repo.owner, repo.name),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER_ID, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
    has_issues: true,
  };
}

function labelView(label: { name: string; color: string }): Record<string, unknown> {
  return { name: label.name, color: label.color, description: '' };
}

function issueView(issue: Issue, repo: Repo): Record<string, unknown> {
  return {
    id: globalId('issue', repo.owner, repo.name, String(issue.number)),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map(labelView),
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
    comments: issue.comments.length,
  };
}

function pullView(pull: Pull, repo: Repo): Record<string, unknown> {
  const headSha = repo.refs.get(`refs/heads/${pull.headRef}`) ?? ZERO_OID;
  const baseSha = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? ZERO_OID;
  return {
    id: globalId('pr', repo.owner, repo.name, String(pull.number)),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: baseSha, label: `${repo.owner}:${pull.baseRef}` },
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
  };
}

function paginate<T>(items: T[], query: URLSearchParams, baseUrl: string, path: string): { page: T[]; link: string | null } {
  const perPage = Math.max(1, Math.min(100, parseInt(query.get('per_page') ?? '30', 10) || 30));
  const pageNum = Math.max(1, parseInt(query.get('page') ?? '1', 10) || 1);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (pageNum - 1) * perPage;
  const page = items.slice(start, start + perPage);
  const links: string[] = [];
  const urlFor = (page: number): string => `${baseUrl}${path}?page=${page}&per_page=${perPage}`;
  if (pageNum < totalPages) links.push(`<${urlFor(pageNum + 1)}>; rel="next"`, `<${urlFor(totalPages)}>; rel="last"`);
  if (pageNum > 1) links.push(`<${urlFor(1)}>; rel="first"`, `<${urlFor(pageNum - 1)}>; rel="prev"`);
  return { page, link: links.length ? links.join(', ') : null };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The repo at /repos/{owner}/{name}, or null when it is not the viewer's. */
function viewerRepo(store: Store, owner: string, name: string): Repo | null {
  if (owner.toLowerCase() !== VIEWER_LOGIN) return null;
  return store.getRepo(owner, name) ?? null;
}

function decodePath(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Resolve a ref name or oid to a commit oid, or null. */
function resolveRef(repo: Repo, ref: string | undefined): string | null {
  if (ref === undefined || ref === '') return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  if (isObjectId(ref)) return repo.objects.has(ref) ? ref : null;
  const direct = repo.refs.get(ref);
  if (direct !== undefined) return direct;
  const branch = repo.refs.get(`refs/heads/${ref}`);
  if (branch !== undefined) return branch;
  const tag = repo.refs.get(`refs/tags/${ref}`);
  if (tag !== undefined) return tag;
  return null;
}

function commitView(repo: Repo, oid: string): Record<string, unknown> {
  const object = repo.objects.get(oid);
  const message = object?.type === 'commit' ? parseCommit(object.data).message : '';
  return {
    sha: oid,
    commit: {
      message,
      author: { name: 'Conformance', email: 'conformance@make.fun' },
      committer: { name: 'Conformance', email: 'conformance@make.fun' },
    },
    author: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    committer: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
  };
}

// ---------------------------------------------------------------------------
// The router
// ---------------------------------------------------------------------------

export function routeRest(
  store: Store,
  method: string,
  pathname: string,
  query: URLSearchParams,
  body: unknown,
  baseUrl: string,
): RestResult {
  // pathname is the part after /api/v3 ('' for the root).
  const path = pathname === '' ? '/' : pathname;
  const segments = path.split('/').filter((s) => s !== '');

  // GET /api/v3/ — the API root.
  if (segments.length === 0) {
    if (method !== 'GET') return message(405, 'Method Not Allowed');
    return json(200, {}, { 'X-OAuth-Scopes': 'repo, read:org' });
  }

  // GET /api/v3/meta
  if (segments[0] === 'meta' && segments.length === 1) {
    if (method !== 'GET') return message(405, 'Method Not Allowed');
    return json(200, { installed_version: '1.0.0' });
  }

  // GET /api/v3/user ; POST /api/v3/user/repos ; GET /api/v3/user/repos
  if (segments[0] === 'user') {
    if (segments.length === 1) {
      if (method !== 'GET') return message(405, 'Method Not Allowed');
      return json(200, { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User', name: VIEWER_LOGIN });
    }
    if (segments[1] === 'repos' && segments.length === 2) {
      if (method === 'POST') return createRepo(store, body);
      if (method === 'GET') {
        const repos = store.listViewerRepos();
        const { page, link } = paginate(repos.map(repoView), query, baseUrl, '/api/v3/user/repos');
        return json(200, page, link === null ? undefined : { Link: link });
      }
      return message(405, 'Method Not Allowed');
    }
    return notFound();
  }

  // /api/v3/repos/{owner}/{name}[...]
  if (segments[0] === 'repos') {
    return routeRepo(store, method, segments.slice(1), pathname, query, body, baseUrl);
  }

  return notFound();
}

function createRepo(store: Store, body: unknown): RestResult {
  const input = (body ?? {}) as Record<string, unknown>;
  const name = typeof input.name === 'string' ? input.name : '';
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name) || name.endsWith('.git')) {
    return message(422, 'Invalid repository name');
  }
  if (store.getRepo(VIEWER_LOGIN, name) !== undefined) {
    return message(422, 'Repository already exists');
  }
  const repo = store.createRepo(
    VIEWER_LOGIN,
    name,
    input.private === true,
    typeof input.description === 'string' ? input.description : '',
  );
  return json(201, repoView(repo));
}

function routeRepo(
  store: Store,
  method: string,
  segments: string[],
  pathname: string,
  query: URLSearchParams,
  body: unknown,
  baseUrl: string,
): RestResult {
  const [ownerRaw, nameRaw, ...rest] = segments;
  if (ownerRaw === undefined || nameRaw === undefined) return notFound();
  const owner = decodePath(ownerRaw);
  const name = decodePath(nameRaw);
  const repo = viewerRepo(store, owner, name);
  if (repo === null) return notFound();

  // /repos/{o}/{r}
  if (rest.length === 0) {
    if (method === 'GET') return json(200, repoView(repo));
    if (method === 'PATCH') {
      const input = (body ?? {}) as Record<string, unknown>;
      if (typeof input.description === 'string') repo.description = input.description;
      if (typeof input.private === 'boolean') repo.isPrivate = input.private;
      return json(200, repoView(repo));
    }
    if (method === 'DELETE') {
      store.deleteRepo(owner, name);
      return { status: 204, body: null };
    }
    return message(405, 'Method Not Allowed');
  }

  const head = rest[0];

  // /repos/{o}/{r}/branches[/{branch}]
  if (head === 'branches') {
    if (rest.length === 1) {
      if (method !== 'GET') return message(405, 'Method Not Allowed');
      const branches = [...repo.refs.keys()]
        .filter((ref) => ref.startsWith('refs/heads/'))
        .map((ref) => ref.slice('refs/heads/'.length))
        .sort()
        .map((branch) => ({
          name: branch,
          commit: { sha: repo.refs.get(`refs/heads/${branch}`)! },
          protected: false,
        }));
      return json(200, branches);
    }
    if (rest.length === 2) {
      if (method !== 'GET') return message(405, 'Method Not Allowed');
      const branch = decodePath(rest[1]!);
      const sha = repo.refs.get(`refs/heads/${branch}`);
      if (sha === undefined) return notFound();
      return json(200, { name: branch, commit: { sha }, protected: false });
    }
    return notFound();
  }

  // /repos/{o}/{r}/commits
  if (head === 'commits') {
    if (rest.length === 1) {
      if (method !== 'GET') return message(405, 'Method Not Allowed');
      const tip = resolveRef(repo, query.get('sha') ?? undefined);
      if (tip === null) return json(200, []);
      const commits = store.commitsFrom(repo, tip).map((oid) => commitView(repo, oid));
      const { page } = paginate(commits, query, baseUrl, pathname);
      return json(200, page);
    }
    return notFound();
  }

  // /repos/{o}/{r}/git/refs
  if (head === 'git' && rest[1] === 'refs') {
    if (method === 'POST' && rest.length === 2) {
      const input = (body ?? {}) as Record<string, unknown>;
      const ref = typeof input.ref === 'string' ? input.ref : '';
      const sha = typeof input.sha === 'string' ? input.sha : '';
      if (!ref.startsWith('refs/heads/') || !isObjectId(sha)) return message(422, 'Invalid ref');
      if (repo.refs.has(ref)) return message(422, 'Reference already exists');
      const object = repo.objects.get(sha);
      if (object?.type !== 'commit') return message(422, 'Invalid sha');
      repo.refs.set(ref, sha);
      return json(201, { ref, object: { sha, type: 'commit' } });
    }
    if (method === 'GET' && rest.length === 4 && rest[2] === 'heads') {
      const branch = decodePath(rest[3]!);
      const sha = repo.refs.get(`refs/heads/${branch}`);
      if (sha === undefined) return notFound();
      return json(200, { ref: `refs/heads/${branch}`, object: { sha, type: 'commit' } });
    }
    return notFound();
  }

  // /repos/{o}/{r}/contents/{path...}
  if (head === 'contents') {
    const filePath = rest.slice(1).map(decodePath).join('/');
    return routeContents(store, repo, method, filePath, query, body);
  }

  // /repos/{o}/{r}/labels
  if (head === 'labels') {
    if (rest.length === 1 && method === 'POST') {
      const input = (body ?? {}) as Record<string, unknown>;
      const labelName = typeof input.name === 'string' ? input.name : '';
      const color = typeof input.color === 'string' ? input.color : 'ededed';
      if (labelName === '') return message(422, 'Invalid label name');
      if (repo.labels.some((l) => l.name === labelName)) return message(422, 'Label already exists');
      const label = { name: labelName, color };
      repo.labels.push(label);
      return json(201, labelView(label));
    }
    if (rest.length === 1 && method === 'GET') return json(200, repo.labels.map(labelView));
    return notFound();
  }

  // /repos/{o}/{r}/issues[/{n}[/comments]]
  if (head === 'issues') {
    return routeIssues(store, repo, method, rest.slice(1), query, body, baseUrl, pathname);
  }

  // /repos/{o}/{r}/pulls[/{n}[/files|merge]]
  if (head === 'pulls') {
    return routePulls(store, repo, method, rest.slice(1), query, body, baseUrl, pathname);
  }

  return notFound();
}

function routeContents(
  store: Store,
  repo: Repo,
  method: string,
  filePath: string,
  query: URLSearchParams,
  body: unknown,
): RestResult {
  if (filePath === '') return notFound();
  const branch = typeof (body as Record<string, unknown> | null)?.branch === 'string'
    ? ((body as Record<string, unknown>).branch as string)
    : (query.get('ref') ?? undefined);
  const tip = resolveRef(repo, branch);
  const files = tip === null ? new Map() : store.filesAtRef(repo, tip);

  if (method === 'GET') {
    const entry = files.get(filePath);
    if (entry !== undefined) {
      const object = repo.objects.get(entry.oid);
      if (object?.type !== 'blob') return notFound();
      return json(200, {
        type: 'file',
        encoding: 'base64',
        content: object.data.toString('base64'),
        sha: entry.oid,
        size: object.data.length,
        name: filePath.split('/').pop(),
        path: filePath,
      });
    }
    // A directory: the immediate children of this prefix.
    const prefix = `${filePath}/`;
    const children = new Map<string, { type: string; name: string; path: string; sha: string; size?: number }>();
    for (const [path, file] of files) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash < 0) {
        children.set(rest, { type: 'file', name: rest, path, sha: file.oid, size: repo.objects.get(file.oid)?.data.length ?? 0 });
      } else {
        const dir = rest.slice(0, slash);
        if (!children.has(dir)) {
          // The subtree oid for the directory listing.
          const dirFiles = new Map<string, { oid: string; mode: string }>();
          for (const [p, f] of files) {
            if (p.startsWith(prefix + dir + '/')) dirFiles.set(p.slice((prefix + dir + '/').length), f);
          }
          const { root } = buildTreesForFiles(dirFiles);
          children.set(dir, { type: 'dir', name: dir, path: `${filePath}/${dir}`, sha: root });
        }
      }
    }
    if (children.size === 0) return notFound();
    return json(200, [...children.values()].sort((a, b) => (a.name < b.name ? -1 : 1)));
  }

  if (method === 'PUT') {
    const input = (body ?? {}) as Record<string, unknown>;
    const messageText = typeof input.message === 'string' ? input.message : '';
    const contentB64 = typeof input.content === 'string' ? input.content : '';
    if (messageText === '' || contentB64 === '') return message(422, 'message and content are required');
    let content: Buffer;
    try {
      content = Buffer.from(contentB64, 'base64');
    } catch {
      return message(422, 'content is not valid base64');
    }
    const branchName = typeof input.branch === 'string' ? input.branch : repo.defaultBranch;
    const currentTip = repo.refs.get(`refs/heads/${branchName}`);
    const currentFiles = currentTip === undefined ? new Map() : store.filesAtRef(repo, currentTip);
    const existing = currentFiles.get(filePath);
    const givenSha = typeof input.sha === 'string' ? input.sha : undefined;
    if (existing !== undefined) {
      if (givenSha === undefined) return message(409, 'sha is required to update a file');
      if (givenSha.toLowerCase() !== existing.oid.toLowerCase()) {
        return message(409, 'sha does not match the current file');
      }
    } else if (givenSha !== undefined) {
      return message(422, 'sha does not match any file');
    }
    const blobOid = store.putObject(repo, 'blob', content);
    const nextFiles = new Map(currentFiles);
    nextFiles.set(filePath, { oid: blobOid, mode: '100644' });
    const commitSha = store.commitFiles(repo, branchName, nextFiles, messageText);
    const status = existing === undefined ? 201 : 200;
    return json(status, {
      content: { name: filePath.split('/').pop(), path: filePath, sha: blobOid, size: content.length, encoding: 'base64' },
      commit: { sha: commitSha, message: messageText },
    });
  }

  if (method === 'DELETE') {
    const input = (body ?? {}) as Record<string, unknown>;
    const givenSha = typeof input.sha === 'string' ? input.sha : undefined;
    const messageText = typeof input.message === 'string' ? input.message : '';
    const currentTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    if (currentTip === undefined) return notFound();
    const currentFiles = store.filesAtRef(repo, currentTip);
    const existing = currentFiles.get(filePath);
    if (existing === undefined) return notFound();
    if (givenSha !== undefined && givenSha.toLowerCase() !== existing.oid.toLowerCase()) {
      return message(409, 'sha does not match the current file');
    }
    const nextFiles = new Map(currentFiles);
    nextFiles.delete(filePath);
    const commitSha = store.commitFiles(repo, repo.defaultBranch, nextFiles, messageText);
    return json(200, { commit: { sha: commitSha, message: messageText } });
  }

  return message(405, 'Method Not Allowed');
}

function routeIssues(
  store: Store,
  repo: Repo,
  method: string,
  rest: string[],
  query: URLSearchParams,
  body: unknown,
  baseUrl: string,
  pathname: string,
): RestResult {
  // POST /issues ; GET /issues
  if (rest.length === 0) {
    if (method === 'POST') {
      const input = (body ?? {}) as Record<string, unknown>;
      const title = typeof input.title === 'string' ? input.title : '';
      const issueBody = typeof input.body === 'string' ? input.body : '';
      if (title === '') return message(422, 'title is required');
      const wanted = Array.isArray(input.labels) ? (input.labels as unknown[]) : [];
      const labels: Array<{ name: string; color: string }> = [];
      for (const name of wanted) {
        if (typeof name !== 'string') continue;
        const label = repo.labels.find((l) => l.name === name);
        if (label === undefined) return message(422, `Label '${name}' does not exist`);
        labels.push(label);
      }
      repo.issueSeq += 1;
      const issue: Issue = {
        number: repo.issueSeq,
        title,
        body: issueBody,
        state: 'open',
        labels,
        createdSeq: ++store.seq,
        comments: [],
      };
      repo.issues.push(issue);
      return json(201, issueView(issue, repo));
    }
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      const sort = query.get('sort') ?? 'created';
      const direction = query.get('direction') ?? 'desc';
      void sort;
      let list = repo.issues.filter((issue) => state === 'all' || issue.state === state);
      list = [...list].sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
      const { page, link } = paginate(list.map((issue) => issueView(issue, repo)), query, baseUrl, pathname);
      return json(200, page, link === null ? undefined : { Link: link });
    }
    return message(405, 'Method Not Allowed');
  }

  const number = parseInt(rest[0] ?? '', 10);
  if (!Number.isInteger(number) || number < 1) return notFound();
  const issue = repo.issues.find((entry) => entry.number === number);
  if (issue === undefined) return notFound();

  // /issues/{n}
  if (rest.length === 1) {
    if (method === 'GET') return json(200, issueView(issue, repo));
    if (method === 'PATCH') {
      const input = (body ?? {}) as Record<string, unknown>;
      if (typeof input.title === 'string') issue.title = input.title;
      if (typeof input.body === 'string') issue.body = input.body;
      if (input.state === 'open' || input.state === 'closed') issue.state = input.state;
      return json(200, issueView(issue, repo));
    }
    return message(405, 'Method Not Allowed');
  }

  // /issues/{n}/comments
  if (rest[1] === 'comments' && rest.length === 2) {
    if (method === 'GET') {
      return json(200, issue.comments.map((comment) => ({
        id: comment.id,
        body: comment.body,
        user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
        created_at: '2025-01-01T00:00:00Z',
      })));
    }
    if (method === 'POST') {
      const input = (body ?? {}) as Record<string, unknown>;
      const commentBody = typeof input.body === 'string' ? input.body : '';
      if (commentBody === '') return message(422, 'body is required');
      repo.commentSeq += 1;
      const comment = { id: repo.commentSeq, body: commentBody, createdSeq: ++store.seq };
      issue.comments.push(comment);
      return json(201, {
        id: comment.id,
        body: comment.body,
        user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
        created_at: '2025-01-01T00:00:00Z',
      });
    }
    return message(405, 'Method Not Allowed');
  }

  return notFound();
}

function routePulls(
  store: Store,
  repo: Repo,
  method: string,
  rest: string[],
  query: URLSearchParams,
  body: unknown,
  baseUrl: string,
  pathname: string,
): RestResult {
  // POST /pulls ; GET /pulls
  if (rest.length === 0) {
    if (method === 'POST') {
      const input = (body ?? {}) as Record<string, unknown>;
      const title = typeof input.title === 'string' ? input.title : '';
      const pullBody = typeof input.body === 'string' ? input.body : '';
      const head = typeof input.head === 'string' ? input.head : '';
      const base = typeof input.base === 'string' ? input.base : repo.defaultBranch;
      if (title === '' || head === '') return message(422, 'title and head are required');
      if (repo.refs.get(`refs/heads/${head}`) === undefined) return message(422, 'head branch does not exist');
      if (repo.refs.get(`refs/heads/${base}`) === undefined) return message(422, 'base branch does not exist');
      repo.pullSeq += 1;
      const pull: Pull = {
        number: repo.pullSeq,
        title,
        body: pullBody,
        state: 'open',
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        headRef: head,
        baseRef: base,
        createdSeq: ++store.seq,
      };
      repo.pulls.push(pull);
      return json(201, pullView(pull, repo));
    }
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      let list = repo.pulls.filter((pull) => state === 'all' || pull.state === state);
      list = [...list].sort((a, b) => b.createdSeq - a.createdSeq);
      const { page, link } = paginate(list.map((pull) => pullView(pull, repo)), query, baseUrl, pathname);
      return json(200, page, link === null ? undefined : { Link: link });
    }
    return message(405, 'Method Not Allowed');
  }

  const number = parseInt(rest[0] ?? '', 10);
  if (!Number.isInteger(number) || number < 1) return notFound();
  const pull = repo.pulls.find((entry) => entry.number === number);
  if (pull === undefined) return notFound();

  // /pulls/{n}
  if (rest.length === 1) {
    if (method === 'GET') return json(200, pullView(pull, repo));
    return message(405, 'Method Not Allowed');
  }

  // /pulls/{n}/files
  if (rest[1] === 'files' && rest.length === 2) {
    if (method !== 'GET') return message(405, 'Method Not Allowed');
    const files = store.pullFiles(repo, pull).map((file) => ({
      filename: file.filename,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      changes: file.changes,
    }));
    return json(200, files);
  }

  // /pulls/{n}/merge
  if (rest[1] === 'merge' && rest.length === 2) {
    if (method !== 'PUT') return message(405, 'Method Not Allowed');
    if (pull.state !== 'open') return message(405, 'Pull request is already closed');
    const merged = store.mergePull(repo, pull);
    if (!merged.ok) return message(405, 'Merge conflict');
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = new Date().toISOString();
    pull.mergeCommitSha = merged.commitSha;
    return json(200, {
      sha: merged.commitSha,
      merged: true,
      message: `Merge pull request #${pull.number} from ${pull.headRef}`,
    });
  }

  return notFound();
}

// Re-exported helpers for the GraphQL and MCP surfaces.
export { issueView, pullView, repoView };
