// A small GraphQL executor for exactly the documents gh and github-mcp-server send:
// viewer, repository fields, __type introspection, issue and pull-request reads,
// the five mutations, node(id:) and batched arrays. No library, no schema file —
// a hand-rolled tokenizer, parser and resolver over the in-memory store.

import {
  VIEWER_LOGIN,
  globalId,
  parseGlobalId,
  type Repo,
  type Issue,
  type Pull,
  type Store,
} from './store.ts';

// ---------------------------------------------------------------------------
// Tokenizer and parser (the subset the suite's documents use)
// ---------------------------------------------------------------------------

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string };

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && input.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}():![]=$'.includes(ch) || ch === '@') {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let value = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\' && j + 1 < input.length) {
          const esc = input[j + 1]!;
          value += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc === '"' ? '"' : esc === '\\' ? '\\' : esc;
          j += 2;
        } else {
          value += input[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < input.length && /[0-9]/.test(input[j]!)) j += 1;
      tokens.push({ kind: 'int', value: input.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < input.length && /[A-Za-z0-9_]/.test(input[j]!)) j += 1;
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return tokens;
}

export type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Record<string, ValueNode> };

export interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Record<string, ValueNode>;
  children: SelectionNode[] | null;
}

export interface FragmentNode {
  kind: 'fragment';
  typeCondition: string | null;
  children: SelectionNode[];
}

export type SelectionNode = FieldNode | FragmentNode;

export interface Operation {
  operation: 'query' | 'mutation';
  name: string | null;
  variableDefinitions: Array<{ name: string; defaultValue?: ValueNode }>;
  selectionSet: SelectionNode[];
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
    const token = this.tokens[this.pos];
    if (token === undefined) throw new Error('unexpected end of GraphQL document');
    this.pos += 1;
    return token;
  }
  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new Error(`expected ${JSON.stringify(value)} in GraphQL document, got ${JSON.stringify(token)}`);
    }
  }
  private expectName(value?: string): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`expected a name in GraphQL document, got ${JSON.stringify(token)}`);
    if (value !== undefined && token.value !== value) throw new Error(`expected ${value} in GraphQL document`);
    return token.value;
  }

  parseOperation(): Operation {
    let operation: 'query' | 'mutation' = 'query';
    let name: string | null = null;
    const first = this.peek();
    if (first?.kind === 'name' && (first.value === 'query' || first.value === 'mutation')) {
      operation = this.next().value as 'query' | 'mutation';
      const maybeName = this.peek();
      if (maybeName?.kind === 'name') name = this.next().value;
    }
    const variableDefinitions: Array<{ name: string; defaultValue?: ValueNode }> = [];
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') {
      this.next();
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ')')) {
        this.expectPunct('$');
        const varName = this.expectName();
        this.expectPunct(':');
        this.parseType();
        if (this.peek()?.kind === 'punct' && this.peek()?.value === '=') {
          this.next();
          variableDefinitions.push({ name: varName, defaultValue: this.parseValue() });
        } else {
          variableDefinitions.push({ name: varName });
        }
      }
      this.next();
    }
    const selectionSet = this.parseSelectionSet();
    return { operation, name, variableDefinitions, selectionSet };
  }

  private parseType(): void {
    const token = this.peek();
    if (token?.kind === 'punct' && token.value === '[') {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '!') this.next();
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!(this.peek()?.kind === 'punct' && this.peek()?.value === '}')) {
      selections.push(this.parseSelection());
    }
    this.next();
    return selections;
  }

  private parseSelection(): SelectionNode {
    const token = this.peek();
    if (token?.kind === 'punct' && token.value === '...') {
      this.next();
      let typeCondition: string | null = null;
      const next = this.peek();
      if (next?.kind === 'name' && next.value === 'on') {
        this.next();
        typeCondition = this.expectName();
      }
      const children = this.parseSelectionSet();
      return { kind: 'fragment', typeCondition, children };
    }
    const name = this.expectName();
    let alias: string | null = null;
    let fieldName = name;
    if (this.peek()?.kind === 'punct' && this.peek()?.value === ':') {
      this.next();
      alias = name;
      fieldName = this.expectName();
    }
    const args: Record<string, ValueNode> = {};
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') {
      this.next();
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args[argName] = this.parseValue();
      }
      this.next();
    }
    let children: SelectionNode[] | null = null;
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '{') {
      children = this.parseSelectionSet();
    }
    return { kind: 'field', alias, name: fieldName, args, children };
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      return { kind: 'variable', name: this.expectName() };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ']')) {
        values.push(this.parseValue());
      }
      this.next();
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Record<string, ValueNode> = {};
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === '}')) {
        const fieldName = this.expectName();
        this.expectPunct(':');
        fields[fieldName] = this.parseValue();
      }
      this.next();
      return { kind: 'object', fields };
    }
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: parseInt(token.value, 10) };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`unexpected value token ${JSON.stringify(token)} in GraphQL document`);
  }
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

class GraphQLError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GraphQLError';
  }
}

type Variables = Record<string, unknown>;

function resolveValue(node: ValueNode, variables: Variables): unknown {
  switch (node.kind) {
    case 'variable': {
      const value = variables[node.name];
      if (value === undefined) throw new GraphQLError(`Variable $${node.name} was not provided`);
      return value;
    }
    case 'string': return node.value;
    case 'int': return node.value;
    case 'boolean': return node.value;
    case 'null': return null;
    case 'enum': return node.value;
    case 'list': return node.values.map((v) => resolveValue(v, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(node.fields)) out[key] = resolveValue(value, variables);
      return out;
    }
  }
}

interface NodeValue {
  __typename: string;
  [key: string]: unknown;
}

function nodeValue(typename: string, fields: Record<string, unknown>): NodeValue {
  return { __typename: typename, ...fields };
}

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'author', 'createdAt', 'url', 'comments'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRef', 'baseRef', 'files', 'author', 'createdAt'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'isPrivate', 'createdAt'],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
};

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64url');
}

function numberFromCursor(cursor: string | null | undefined): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match === null ? null : parseInt(match[1]!, 10);
  } catch {
    return null;
  }
}

export class GraphQLExecutor {
  private readonly store: Store;
  constructor(store: Store) {
    this.store = store;
  }

  execute(document: string, variables: Variables): { data: Record<string, unknown>; errors?: Array<{ message: string; path?: (string | number)[] }> } {
    let operation: Operation;
    try {
      operation = new Parser(tokenize(document)).parseOperation();
    } catch (err) {
      return {
        data: {},
        errors: [{ message: err instanceof Error ? err.message : 'Syntax Error' }],
      };
    }
    const errors: Array<{ message: string; path?: (string | number)[] }> = [];
    const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
    const root = nodeValue(rootType, {});
    const data = this.executeSelectionSet(rootType, root, operation.selectionSet, variables, errors, []);
    const result: { data: Record<string, unknown>; errors?: Array<{ message: string; path?: (string | number)[] }> } = { data };
    if (errors.length > 0) result.errors = errors;
    return result;
  }

  private executeSelectionSet(
    parentType: string,
    parent: NodeValue,
    selections: SelectionNode[],
    variables: Variables,
    errors: Array<{ message: string; path?: (string | number)[] }>,
    path: (string | number)[],
  ): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const selection of selections) {
      if (selection.kind === 'fragment') {
        if (selection.typeCondition !== null && selection.typeCondition !== parent.__typename) continue;
        Object.assign(out, this.executeSelectionSet(parentType, parent, selection.children, variables, errors, path));
        continue;
      }
      const key = selection.alias ?? selection.name;
      const fieldPath = [...path, key];
      try {
        const args: Record<string, unknown> = {};
        for (const [argName, argNode] of Object.entries(selection.args)) {
          args[argName] = resolveValue(argNode, variables);
        }
        const value = this.resolveField(parentType, parent, selection.name, args, selection.children, variables, errors, fieldPath);
        out[key] = value;
      } catch (err) {
        if (err instanceof GraphQLError) {
          errors.push({ message: err.message, path: fieldPath });
          out[key] = null;
        } else {
          throw err;
        }
      }
    }
    return out;
  }

  private resolveField(
    parentType: string,
    parent: NodeValue,
    field: string,
    args: Record<string, unknown>,
    children: SelectionNode[] | null,
    variables: Variables,
    errors: Array<{ message: string; path?: (string | number)[] }>,
    path: (string | number)[],
  ): unknown {
    // Introspection.
    if (field === '__type') {
      const name = args.name as string;
      const fields = TYPE_FIELDS[name];
      const enumValues = ENUM_VALUES[name];
      if (fields === undefined && enumValues === undefined) return null;
      const typeNode = nodeValue('__Type', { name, fields, enumValues });
      if (children === null) return typeNode;
      return this.executeSelectionSet('__Type', typeNode, children, variables, errors, path);
    }
    if (field === '__schema') {
      const schemaNode = nodeValue('__Schema', {});
      if (children === null) return schemaNode;
      return this.executeSelectionSet('__Schema', schemaNode, children, variables, errors, path);
    }

    switch (parentType) {
      case 'Query': return this.resolveQuery(parent, field, args, children, variables, errors, path);
      case 'Mutation': return this.resolveMutation(parent, field, args, children, variables, errors, path);
      case 'CreateIssuePayload':
      case 'CloseIssuePayload': {
        if (field === 'issue') {
          const node = parent.issue as NodeValue;
          return this.sub('Issue', node, children, variables, errors, path);
        }
        throw new GraphQLError(`Cannot query field "${field}" on type "${parentType}".`);
      }
      case 'CreatePullRequestPayload':
      case 'MergePullRequestPayload': {
        if (field === 'pullRequest') {
          const node = parent.pullRequest as NodeValue;
          return this.sub('PullRequest', node, children, variables, errors, path);
        }
        throw new GraphQLError(`Cannot query field "${field}" on type "${parentType}".`);
      }
      case 'AddCommentPayload': {
        if (field === 'commentEdge') {
          const node = parent.commentEdge as NodeValue;
          return this.sub('CommentEdge', node, children, variables, errors, path);
        }
        throw new GraphQLError(`Cannot query field "${field}" on type "${parentType}".`);
      }
      case 'Repository': return this.resolveRepository(parent, field, args, children, variables, errors, path);
      case 'Issue': return this.resolveIssue(parent, field, args, children, variables, errors, path);
      case 'PullRequest': return this.resolvePullRequest(parent, field, args, children, variables, errors, path);
      case 'User': return this.resolveUser(parent, field, args, children, variables, errors, path);
      case 'IssueConnection': return this.resolveIssueConnection(parent, field, args, children, variables, errors, path);
      case 'IssueCommentConnection': {
        if (field === 'nodes') {
          const nodes = parent.nodes as NodeValue[];
          return nodes.map((node) => this.sub('Comment', node, children, variables, errors, path));
        }
        throw new GraphQLError(`Cannot query field "${field}" on type "IssueCommentConnection".`);
      }
      case 'PullRequestConnection': return this.resolvePullRequestConnection(parent, field, args, children, variables, errors, path);
      case 'PullRequestChangedFileConnection': return this.resolveFileConnection(parent, field, args, children, variables, errors, path);
      case 'PullRequestChangedFile': {
        if (field === 'path') return parent.path as string;
        throw new GraphQLError(`Cannot query field "${field}" on type "PullRequestChangedFile".`);
      }
      case 'CommentEdge': return this.resolveCommentEdge(parent, field, args, children, variables, errors, path);
      case 'Comment': return this.resolveComment(parent, field, args, children, variables, errors, path);
      case '__Type': return this.resolveType(parent, field, args, children, variables, errors, path);
      case '__Field':
      case '__EnumValue': {
        if (field === 'name') return parent.name as string;
        throw new GraphQLError(`Cannot query field "${field}" on type "${parentType}".`);
      }
      case '__Schema': return this.resolveSchema(parent, field, args, children, variables, errors, path);
      case 'Ref': return this.resolveRef(parent, field, args, children, variables, errors, path);
      case 'PageInfo': return this.resolvePageInfo(parent, field, args, children, variables, errors, path);
      default: throw new GraphQLError(`Cannot query field "${field}" on type "${parentType}".`);
    }
  }

  private sub(parentType: string, parent: NodeValue, children: SelectionNode[] | null, variables: Variables, errors: Array<{ message: string; path?: (string | number)[] }>, path: (string | number)[]): unknown {
    if (children === null) return parent;
    return this.executeSelectionSet(parentType, parent, children, variables, errors, path);
  }

  // -- Query ---------------------------------------------------------------

  private resolveQuery(
    _parent: NodeValue,
    field: string,
    args: Record<string, unknown>,
    children: SelectionNode[] | null,
    variables: Variables,
    errors: Array<{ message: string; path?: (string | number)[] }>,
    path: (string | number)[],
  ): unknown {
    if (field === 'viewer') {
      const user = nodeValue('User', { login: VIEWER_LOGIN });
      return this.sub('User', user, children, variables, errors, path);
    }
    if (field === 'repository') {
      const owner = args.owner as string;
      const name = args.name as string;
      if (owner !== VIEWER_LOGIN) return null;
      const repo = this.store.getRepo(owner, name);
      if (repo === undefined) return null;
      const repoNode = nodeValue('Repository', { repo });
      return this.sub('Repository', repoNode, children, variables, errors, path);
    }
    if (field === 'node') {
      const id = args.id as string;
      const parsed = parseGlobalId(id);
      if (parsed === null) return null;
      const node = this.nodeById(parsed.kind, parsed.parts);
      if (node === null) return null;
      return this.sub(node.__typename, node, children, variables, errors, path);
    }
    throw new GraphQLError(`Cannot query field "${field}" on type "Query".`);
  }

  private nodeById(kind: string, parts: string[]): NodeValue | null {
    if (kind === 'repo' && parts.length === 2) {
      const repo = this.store.getRepo(parts[0]!, parts[1]!);
      if (repo === undefined) return null;
      return nodeValue('Repository', { repo });
    }
    if (kind === 'issue' && parts.length === 3) {
      const repo = this.store.getRepo(parts[0]!, parts[1]!);
      const issue = repo?.issues.find((entry) => entry.number === parseInt(parts[2]!, 10));
      if (repo === undefined || issue === undefined) return null;
      return nodeValue('Issue', { repo, issue });
    }
    if (kind === 'pr' && parts.length === 3) {
      const repo = this.store.getRepo(parts[0]!, parts[1]!);
      const pull = repo?.pulls.find((entry) => entry.number === parseInt(parts[2]!, 10));
      if (repo === undefined || pull === undefined) return null;
      return nodeValue('PullRequest', { repo, pull });
    }
    if (kind === 'comment' && parts.length === 4) {
      const repo = this.store.getRepo(parts[0]!, parts[1]!);
      const issue = repo?.issues.find((entry) => entry.number === parseInt(parts[2]!, 10));
      const comment = issue?.comments.find((entry) => entry.id === parseInt(parts[3]!, 10));
      if (repo === undefined || issue === undefined || comment === undefined) return null;
      return nodeValue('Comment', { repo, issue, comment });
    }
    return null;
  }

  // -- Mutation ------------------------------------------------------------

  private resolveMutation(
    _parent: NodeValue,
    field: string,
    args: Record<string, unknown>,
    children: SelectionNode[] | null,
    variables: Variables,
    errors: Array<{ message: string; path?: (string | number)[] }>,
    path: (string | number)[],
  ): unknown {
    const input = (args.input ?? {}) as Record<string, unknown>;
    if (field === 'createIssue') {
      const repo = this.repoByGlobalId(input.repositoryId as string);
      if (repo === null) throw new GraphQLError('createIssue: unknown repositoryId');
      const title = input.title as string;
      const body = (input.body as string | undefined) ?? '';
      if (typeof title !== 'string' || title === '') throw new GraphQLError('createIssue: title is required');
      repo.issueSeq += 1;
      const issue: Issue = {
        number: repo.issueSeq,
        title,
        body,
        state: 'open',
        labels: [],
        createdSeq: ++this.store.seq,
        comments: [],
      };
      repo.issues.push(issue);
      const payload = nodeValue('CreateIssuePayload', { issue: nodeValue('Issue', { repo, issue }) });
      return this.sub('CreateIssuePayload', payload, children, variables, errors, path);
    }
    if (field === 'closeIssue') {
      const parsed = parseGlobalId(input.issueId as string);
      const node = parsed === null ? null : this.nodeById(parsed.kind, parsed.parts);
      if (node === null || node.__typename !== 'Issue') throw new GraphQLError('closeIssue: unknown issueId');
      const issue = node.issue as Issue;
      issue.state = 'closed';
      const payload = nodeValue('CloseIssuePayload', { issue: nodeValue('Issue', { repo: node.repo as Repo, issue }) });
      return this.sub('CloseIssuePayload', payload, children, variables, errors, path);
    }
    if (field === 'createPullRequest') {
      const repo = this.repoByGlobalId(input.repositoryId as string);
      if (repo === null) throw new GraphQLError('createPullRequest: unknown repositoryId');
      const head = input.headRefName as string;
      const base = input.baseRefName as string;
      const title = input.title as string;
      if (repo.refs.get(`refs/heads/${head}`) === undefined) throw new GraphQLError('createPullRequest: head branch does not exist');
      if (repo.refs.get(`refs/heads/${base}`) === undefined) throw new GraphQLError('createPullRequest: base branch does not exist');
      repo.pullSeq += 1;
      const pull: Pull = {
        number: repo.pullSeq,
        title,
        body: (input.body as string | undefined) ?? '',
        state: 'open',
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        headRef: head,
        baseRef: base,
        createdSeq: ++this.store.seq,
      };
      repo.pulls.push(pull);
      const payload = nodeValue('CreatePullRequestPayload', { pullRequest: nodeValue('PullRequest', { repo, pull }) });
      return this.sub('CreatePullRequestPayload', payload, children, variables, errors, path);
    }
    if (field === 'mergePullRequest') {
      const parsed = parseGlobalId(input.pullRequestId as string);
      const node = parsed === null ? null : this.nodeById(parsed.kind, parsed.parts);
      if (node === null || node.__typename !== 'PullRequest') throw new GraphQLError('mergePullRequest: unknown pullRequestId');
      const repo = node.repo as Repo;
      const pull = node.pull as Pull;
      if (pull.state !== 'open') throw new GraphQLError('mergePullRequest: pull request is already closed');
      const merged = this.store.mergePull(repo, pull);
      if (!merged.ok) throw new GraphQLError('mergePullRequest: merge conflict');
      pull.state = 'closed';
      pull.merged = true;
      pull.mergedAt = new Date().toISOString();
      pull.mergeCommitSha = merged.commitSha;
      const payload = nodeValue('MergePullRequestPayload', { pullRequest: nodeValue('PullRequest', { repo, pull }) });
      return this.sub('MergePullRequestPayload', payload, children, variables, errors, path);
    }
    if (field === 'addComment') {
      const parsed = parseGlobalId(input.subjectId as string);
      const node = parsed === null ? null : this.nodeById(parsed.kind, parsed.parts);
      if (node === null || node.__typename !== 'Issue') throw new GraphQLError('addComment: unknown subjectId');
      const repo = node.repo as Repo;
      const issue = node.issue as Issue;
      const body = input.body as string;
      if (typeof body !== 'string' || body === '') throw new GraphQLError('addComment: body is required');
      repo.commentSeq += 1;
      const comment = { id: repo.commentSeq, body, createdSeq: ++this.store.seq };
      issue.comments.push(comment);
      const commentNode = nodeValue('Comment', { repo, issue, comment });
      const edge = nodeValue('CommentEdge', { node: commentNode });
      const payload = nodeValue('AddCommentPayload', { commentEdge: edge });
      return this.sub('AddCommentPayload', payload, children, variables, errors, path);
    }
    throw new GraphQLError(`Cannot query field "${field}" on type "Mutation".`);
  }

  private repoByGlobalId(id: unknown): Repo | null {
    if (typeof id !== 'string') return null;
    const parsed = parseGlobalId(id);
    if (parsed === null || parsed.kind !== 'repo' || parsed.parts.length !== 2) return null;
    return this.store.getRepo(parsed.parts[0]!, parsed.parts[1]!) ?? null;
  }

  // -- Repository ----------------------------------------------------------

  private resolveRepository(
    parent: NodeValue,
    field: string,
    args: Record<string, unknown>,
    children: SelectionNode[] | null,
    variables: Variables,
    errors: Array<{ message: string; path?: (string | number)[] }>,
    path: (string | number)[],
  ): unknown {
    const repo = parent.repo as Repo;
    switch (field) {
      case 'id': return globalId('repo', repo.owner, repo.name);
      case 'databaseId': return repo.dbId;
      case 'name': return repo.name;
      case 'nameWithOwner': return `${repo.owner}/${repo.name}`;
      case 'description': return repo.description;
      case 'isPrivate': return repo.isPrivate;
      case 'owner': {
        const user = nodeValue('User', { login: repo.owner });
        return this.sub('User', user, children, variables, errors, path);
      }
      case 'defaultBranchRef': {
        const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
        if (tip === undefined) return null;
        const ref = nodeValue('Ref', { name: repo.defaultBranch });
        return this.sub('Ref', ref, children, variables, errors, path);
      }
      case 'viewerPermission': return 'ADMIN';
      case 'hasIssuesEnabled': return true;
      case 'issue': {
        const number = args.number as number;
        const issue = repo.issues.find((entry) => entry.number === number);
        if (issue === undefined) return null;
        const issueNode = nodeValue('Issue', { repo, issue });
        return this.sub('Issue', issueNode, children, variables, errors, path);
      }
      case 'issues': {
        const connection = this.issueConnection(repo, args);
        return this.sub('IssueConnection', connection, children, variables, errors, path);
      }
      case 'pullRequests': {
        const first = args.first as number | undefined;
        let pulls = [...repo.pulls].filter((pull) => pull.state === 'open');
        pulls.sort((a, b) => b.createdSeq - a.createdSeq);
        if (first !== undefined) pulls = pulls.slice(0, first);
        const connection = nodeValue('PullRequestConnection', {
          nodes: pulls.map((pull) => nodeValue('PullRequest', { repo, pull })),
        });
        return this.sub('PullRequestConnection', connection, children, variables, errors, path);
      }
      case 'pullRequest': {
        const number = args.number as number;
        const pull = repo.pulls.find((entry) => entry.number === number);
        if (pull === undefined) return null;
        const pullNode = nodeValue('PullRequest', { repo, pull });
        return this.sub('PullRequest', pullNode, children, variables, errors, path);
      }
      default: throw new GraphQLError(`Cannot query field "${field}" on type "Repository".`);
    }
  }

  private issueConnection(repo: Repo, args: Record<string, unknown>): NodeValue {
    const first = args.first as number | undefined;
    const states = (args.states as string[] | undefined) ?? undefined;
    const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
    const after = args.after as string | null | undefined;
    const afterNumber = numberFromCursor(after);
    let issues = [...repo.issues];
    if (states !== undefined) {
      const wanted = new Set(states.map((s) => s.toLowerCase()));
      issues = issues.filter((issue) => wanted.has(issue.state));
    }
    if (afterNumber !== null) issues = issues.filter((issue) => issue.number > afterNumber);
    const direction = (orderBy.direction as string | undefined) ?? 'ASC';
    const field = (orderBy.field as string | undefined) ?? 'CREATED_AT';
    void field;
    issues.sort((a, b) => (direction === 'DESC' ? b.createdSeq - a.createdSeq : a.createdSeq - b.createdSeq));
    const total = issues.length;
    const page = first === undefined ? issues : issues.slice(0, first);
    const hasNextPage = page.length < total;
    const endCursor = page.length === 0 ? null : cursorFor(page[page.length - 1]!.number);
    const pageInfo = nodeValue('PageInfo', { hasNextPage, endCursor });
    return nodeValue('IssueConnection', {
      nodes: page.map((issue) => nodeValue('Issue', { repo, issue })),
      pageInfo,
      totalCount: total,
    });
  }

  // -- Issue ---------------------------------------------------------------

  private resolveIssue(
    parent: NodeValue,
    field: string,
    args: Record<string, unknown>,
    children: SelectionNode[] | null,
    variables: Variables,
    errors: Array<{ message: string; path?: (string | number)[] }>,
    path: (string | number)[],
  ): unknown {
    const repo = parent.repo as Repo;
    const issue = parent.issue as Issue;
    switch (field) {
      case 'id': return globalId('issue', repo.owner, repo.name, String(issue.number));
      case 'number': return issue.number;
      case 'title': return issue.title;
      case 'state': return issue.state.toUpperCase();
      case 'body': return issue.body;
      case 'author': {
        const user = nodeValue('User', { login: VIEWER_LOGIN });
        return this.sub('User', user, children, variables, errors, path);
      }
      case 'createdAt': return '2025-01-01T00:00:00Z';
      case 'url': return `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`;
      case 'comments': {
        const connection = nodeValue('IssueCommentConnection', {
          nodes: issue.comments.map((comment) => nodeValue('Comment', { repo, issue, comment })),
        });
        return this.sub('IssueCommentConnection', connection, children, variables, errors, path);
      }
      default: throw new GraphQLError(`Cannot query field "${field}" on type "Issue".`);
    }
  }

  // -- PullRequest ---------------------------------------------------------

  private resolvePullRequest(
    parent: NodeValue,
    field: string,
    args: Record<string, unknown>,
    children: SelectionNode[] | null,
    variables: Variables,
    errors: Array<{ message: string; path?: (string | number)[] }>,
    path: (string | number)[],
  ): unknown {
    const repo = parent.repo as Repo;
    const pull = parent.pull as Pull;
    switch (field) {
      case 'id': return globalId('pr', repo.owner, repo.name, String(pull.number));
      case 'number': return pull.number;
      case 'title': return pull.title;
      case 'body': return pull.body;
      case 'state': return pull.merged ? 'MERGED' : pull.state.toUpperCase();
      case 'merged': return pull.merged;
      case 'mergeable': return this.store.pullMergeable(repo, pull);
      case 'headRefName': return pull.headRef;
      case 'baseRefName': return pull.baseRef;
      case 'headRef': {
        const ref = nodeValue('Ref', { name: pull.headRef });
        return this.sub('Ref', ref, children, variables, errors, path);
      }
      case 'baseRef': {
        const ref = nodeValue('Ref', { name: pull.baseRef });
        return this.sub('Ref', ref, children, variables, errors, path);
      }
      case 'files': {
        const first = args.first as number | undefined;
        let files = this.store.pullFiles(repo, pull);
        if (first !== undefined) files = files.slice(0, first);
        const connection = nodeValue('PullRequestChangedFileConnection', {
          nodes: files.map((file) => nodeValue('PullRequestChangedFile', { path: file.filename })),
        });
        return this.sub('PullRequestChangedFileConnection', connection, children, variables, errors, path);
      }
      case 'author': {
        const user = nodeValue('User', { login: VIEWER_LOGIN });
        return this.sub('User', user, children, variables, errors, path);
      }
      case 'createdAt': return '2025-01-01T00:00:00Z';
      default: throw new GraphQLError(`Cannot query field "${field}" on type "PullRequest".`);
    }
  }

  // -- Small types ---------------------------------------------------------

  private resolveUser(
    parent: NodeValue,
    field: string,
    _args: Record<string, unknown>,
    _children: SelectionNode[] | null,
    _variables: Variables,
    _errors: Array<{ message: string; path?: (string | number)[] }>,
    _path: (string | number)[],
  ): unknown {
    if (field === 'login') return parent.login as string;
    if (field === 'id') return globalId('user', parent.login as string);
    throw new GraphQLError(`Cannot query field "${field}" on type "User".`);
  }

  private resolveIssueConnection(
    parent: NodeValue,
    field: string,
    args: Record<string, unknown>,
    children: SelectionNode[] | null,
    variables: Variables,
    errors: Array<{ message: string; path?: (string | number)[] }>,
    path: (string | number)[],
  ): unknown {
    if (field === 'nodes') {
      const nodes = parent.nodes as NodeValue[];
      return nodes.map((node) => this.sub('Issue', node, children, variables, errors, path));
    }
    if (field === 'pageInfo') {
      const pageInfo = parent.pageInfo as NodeValue;
      return this.sub('PageInfo', pageInfo, children, variables, errors, path);
    }
    if (field === 'totalCount') return parent.totalCount as number;
    throw new GraphQLError(`Cannot query field "${field}" on type "IssueConnection".`);
  }

  private resolvePullRequestConnection(
    parent: NodeValue,
    field: string,
    args: Record<string, unknown>,
    children: SelectionNode[] | null,
    variables: Variables,
    errors: Array<{ message: string; path?: (string | number)[] }>,
    path: (string | number)[],
  ): unknown {
    if (field === 'nodes') {
      const nodes = parent.nodes as NodeValue[];
      return nodes.map((node) => this.sub('PullRequest', node, children, variables, errors, path));
    }
    if (field === 'totalCount') return (parent.nodes as NodeValue[]).length;
    throw new GraphQLError(`Cannot query field "${field}" on type "PullRequestConnection".`);
  }

  private resolveFileConnection(
    parent: NodeValue,
    field: string,
    args: Record<string, unknown>,
    children: SelectionNode[] | null,
    variables: Variables,
    errors: Array<{ message: string; path?: (string | number)[] }>,
    path: (string | number)[],
  ): unknown {
    if (field === 'nodes') {
      const nodes = parent.nodes as NodeValue[];
      return nodes.map((node) => this.sub('PullRequestChangedFile', node, children, variables, errors, path));
    }
    throw new GraphQLError(`Cannot query field "${field}" on type "PullRequestChangedFileConnection".`);
  }

  private resolveCommentEdge(
    parent: NodeValue,
    field: string,
    args: Record<string, unknown>,
    children: SelectionNode[] | null,
    variables: Variables,
    errors: Array<{ message: string; path?: (string | number)[] }>,
    path: (string | number)[],
  ): unknown {
    if (field === 'node') {
      const node = parent.node as NodeValue;
      return this.sub('Comment', node, children, variables, errors, path);
    }
    throw new GraphQLError(`Cannot query field "${field}" on type "CommentEdge".`);
  }

  private resolveComment(
    parent: NodeValue,
    field: string,
    _args: Record<string, unknown>,
    _children: SelectionNode[] | null,
    _variables: Variables,
    _errors: Array<{ message: string; path?: (string | number)[] }>,
    _path: (string | number)[],
  ): unknown {
    const repo = parent.repo as Repo;
    const issue = parent.issue as Issue;
    const comment = parent.comment as { id: number; body: string };
    if (field === 'id') return globalId('comment', repo.owner, repo.name, String(issue.number), String(comment.id));
    if (field === 'body') return comment.body;
    throw new GraphQLError(`Cannot query field "${field}" on type "Comment".`);
  }

  private resolveType(
    parent: NodeValue,
    field: string,
    args: Record<string, unknown>,
    children: SelectionNode[] | null,
    variables: Variables,
    errors: Array<{ message: string; path?: (string | number)[] }>,
    path: (string | number)[],
  ): unknown {
    if (field === 'name') return parent.name as string;
    if (field === 'fields') {
      const fields = (parent.fields as string[] | undefined) ?? [];
      return fields.map((name) => {
        const fieldNode = nodeValue('__Field', { name });
        return children === null ? fieldNode : this.executeSelectionSet('__Field', fieldNode, children, variables, errors, path);
      });
    }
    if (field === 'enumValues') {
      const values = (parent.enumValues as string[] | undefined) ?? [];
      return values.map((name) => {
        const valueNode = nodeValue('__EnumValue', { name });
        return children === null ? valueNode : this.executeSelectionSet('__EnumValue', valueNode, children, variables, errors, path);
      });
    }
    throw new GraphQLError(`Cannot query field "${field}" on type "__Type".`);
  }

  private resolveSchema(
    _parent: NodeValue,
    field: string,
    _args: Record<string, unknown>,
    _children: SelectionNode[] | null,
    _variables: Variables,
    _errors: Array<{ message: string; path?: (string | number)[] }>,
    _path: (string | number)[],
  ): unknown {
    throw new GraphQLError(`Cannot query field "${field}" on type "__Schema".`);
  }

  private resolveRef(
    parent: NodeValue,
    field: string,
    _args: Record<string, unknown>,
    _children: SelectionNode[] | null,
    _variables: Variables,
    _errors: Array<{ message: string; path?: (string | number)[] }>,
    _path: (string | number)[],
  ): unknown {
    if (field === 'name') return parent.name as string;
    throw new GraphQLError(`Cannot query field "${field}" on type "Ref".`);
  }

  private resolvePageInfo(
    parent: NodeValue,
    field: string,
    _args: Record<string, unknown>,
    _children: SelectionNode[] | null,
    _variables: Variables,
    _errors: Array<{ message: string; path?: (string | number)[] }>,
    _path: (string | number)[],
  ): unknown {
    if (field === 'hasNextPage') return parent.hasNextPage as boolean;
    if (field === 'endCursor') return parent.endCursor as string | null;
    throw new GraphQLError(`Cannot query field "${field}" on type "PageInfo".`);
  }
}
