// Model Context Protocol endpoint: the 2026-07-28 modern era (`server/discover`,
// no handshake, no session) with the legacy `initialize` handshake as a fallback.
// Six tools, named after github-mcp-server, over the same store the REST surface
// uses — so a tool's effect is visible over REST (rest-parity).

import {
  VIEWER_LOGIN,
  globalId,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';

const SERVER_NAME = 'github-core-clone';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, Record<string, unknown>>;
    required: string[];
  };
}

export const MCP_TOOLS: McpToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
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
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'open, closed or all.', enum: ['open', 'closed', 'all'] },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch onto a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
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
    description: 'Merge a pull request (squash) onto its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

export interface McpResult {
  status: number;
  body: unknown;
}

function rpcResult(id: unknown, result: unknown): McpResult {
  return { status: 200, body: { jsonrpc: '2.0', id: id ?? null, result } };
}

function rpcError(id: unknown, code: number, message: string, status = 200): McpResult {
  return { status, body: { jsonrpc: '2.0', id: id ?? null, error: { code, message } } };
}

function toolText(payload: unknown): { content: Array<{ type: string; text: string }>; structuredContent: unknown; isError?: boolean } {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

function toolError(message: string): { content: Array<{ type: string; text: string }>; isError: boolean } {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function repoView(repo: Repo): Record<string, unknown> {
  return {
    id: repo.dbId,
    node_id: globalId('repo', repo.owner, repo.name),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
  };
}

function issueView(issue: Issue, repo: Repo): Record<string, unknown> {
  return {
    id: globalId('issue', repo.owner, repo.name, String(issue.number)),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((label) => ({ name: label.name, color: label.color })),
  };
}

function pullView(pull: Pull, repo: Repo): Record<string, unknown> {
  return {
    id: globalId('pr', repo.owner, repo.name, String(pull.number)),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    head: { ref: pull.headRef, sha: repo.refs.get(`refs/heads/${pull.headRef}`) ?? null },
    base: { ref: pull.baseRef, sha: repo.refs.get(`refs/heads/${pull.baseRef}`) ?? null },
  };
}

function callTool(store: Store, name: string, args: Record<string, unknown>): { content: Array<{ type: string; text: string }>; structuredContent?: unknown; isError?: boolean } {
  const missing = (required: string[]): string | null => {
    for (const key of required) {
      if (args[key] === undefined || args[key] === null || args[key] === '') return key;
    }
    return null;
  };
  const repoOf = (args: Record<string, unknown>): Repo | null => {
    const owner = args.owner as string;
    const repoName = args.repo as string;
    if (owner !== VIEWER_LOGIN) return null;
    return store.getRepo(owner, repoName) ?? null;
  };

  switch (name) {
    case 'create_repo': {
      const miss = missing(['name']);
      if (miss !== null) return toolError(`Missing required argument: ${miss}`);
      const repoName = args.name as string;
      if (store.getRepo(VIEWER_LOGIN, repoName) !== undefined) return toolError('Repository already exists');
      const repo = store.createRepo(
        VIEWER_LOGIN,
        repoName,
        args.private === true,
        typeof args.description === 'string' ? args.description : '',
      );
      return toolText(repoView(repo));
    }
    case 'get_repo': {
      const miss = missing(['owner', 'repo']);
      if (miss !== null) return toolError(`Missing required argument: ${miss}`);
      const repo = repoOf(args);
      if (repo === null) return toolError('Repository not found');
      return toolText(repoView(repo));
    }
    case 'create_issue': {
      const miss = missing(['owner', 'repo', 'title']);
      if (miss !== null) return toolError(`Missing required argument: ${miss}`);
      const repo = repoOf(args);
      if (repo === null) return toolError('Repository not found');
      repo.issueSeq += 1;
      const issue: Issue = {
        number: repo.issueSeq,
        title: args.title as string,
        body: (args.body as string | undefined) ?? '',
        state: 'open',
        labels: [],
        createdSeq: ++store.seq,
        comments: [],
      };
      repo.issues.push(issue);
      return toolText(issueView(issue, repo));
    }
    case 'list_issues': {
      const miss = missing(['owner', 'repo']);
      if (miss !== null) return toolError(`Missing required argument: ${miss}`);
      const repo = repoOf(args);
      if (repo === null) return toolError('Repository not found');
      const state = (args.state as string | undefined) ?? 'open';
      const issues = repo.issues
        .filter((issue) => state === 'all' || issue.state === state)
        .sort((a, b) => b.createdSeq - a.createdSeq);
      return toolText(issues.map((issue) => issueView(issue, repo)));
    }
    case 'create_pull_request': {
      const miss = missing(['owner', 'repo', 'title', 'head', 'base']);
      if (miss !== null) return toolError(`Missing required argument: ${miss}`);
      const repo = repoOf(args);
      if (repo === null) return toolError('Repository not found');
      const head = args.head as string;
      const base = args.base as string;
      if (repo.refs.get(`refs/heads/${head}`) === undefined) return toolError('head branch does not exist');
      if (repo.refs.get(`refs/heads/${base}`) === undefined) return toolError('base branch does not exist');
      repo.pullSeq += 1;
      const pull: Pull = {
        number: repo.pullSeq,
        title: args.title as string,
        body: (args.body as string | undefined) ?? '',
        state: 'open',
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        headRef: head,
        baseRef: base,
        createdSeq: ++store.seq,
      };
      repo.pulls.push(pull);
      return toolText(pullView(pull, repo));
    }
    case 'merge_pull_request': {
      const miss = missing(['owner', 'repo', 'pull_number']);
      if (miss !== null) return toolError(`Missing required argument: ${miss}`);
      const repo = repoOf(args);
      if (repo === null) return toolError('Repository not found');
      const number = args.pull_number as number;
      const pull = repo.pulls.find((entry) => entry.number === number);
      if (pull === undefined) return toolError('Pull request not found');
      if (pull.state !== 'open') return toolError('Pull request is already closed');
      const merged = store.mergePull(repo, pull);
      if (!merged.ok) return toolError('Merge conflict');
      pull.state = 'closed';
      pull.merged = true;
      pull.mergedAt = new Date().toISOString();
      pull.mergeCommitSha = merged.commitSha;
      return toolText({ ...pullView(pull, repo), merged: true, sha: merged.commitSha });
    }
    default:
      return toolError(`Unknown tool: ${name}`);
  }
}

/**
 * Handle one JSON-RPC request object. `authenticated` is false when no valid
 * bearer token was presented (auth is the app's job); an unauthenticated
 * tools/call is a 401, as the suite requires.
 */
export function handleMcp(store: Store, request: unknown, authenticated: boolean): McpResult {
  if (request === null || typeof request !== 'object' || Array.isArray(request)) {
    return rpcError(null, -32600, 'Invalid Request');
  }
  const req = request as Record<string, unknown>;
  const id = req.id ?? null;
  const method = req.method as string | undefined;
  const params = (req.params ?? {}) as Record<string, unknown>;

  // A notification (no id) gets no response body.
  if (typeof method === 'string' && method.startsWith('notifications/')) {
    return { status: 202, body: null };
  }
  if (typeof method !== 'string') return rpcError(id, -32600, 'Invalid Request');

  if (method === 'server/discover') {
    return rpcResult(id, {
      resultType: 'discover',
      supportedVersions: SUPPORTED_VERSIONS,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
    });
  }

  if (method === 'initialize') {
    const requested = (params.protocolVersion as string | undefined) ?? '2026-07-28';
    const negotiated = SUPPORTED_VERSIONS.includes(requested) ? requested : '2026-07-28';
    return rpcResult(id, {
      protocolVersion: negotiated,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }

  if (method === 'ping') {
    return rpcResult(id, {});
  }

  if (method === 'tools/list') {
    if (!authenticated) return rpcError(id, -32001, 'Unauthorized', 401);
    return rpcResult(id, { tools: MCP_TOOLS });
  }

  if (method === 'tools/call') {
    if (!authenticated) return rpcError(id, -32001, 'Unauthorized', 401);
    const name = params.name as string | undefined;
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    if (typeof name !== 'string' || name === '') return rpcError(id, -32602, 'Invalid params: tool name is required');
    const known = MCP_TOOLS.some((tool) => tool.name === name);
    if (!known) return rpcError(id, -32601, `Method not found: ${name}`);
    const result = callTool(store, name, args);
    return rpcResult(id, result);
  }

  return rpcError(id, -32601, `Method not found: ${method}`);
}
