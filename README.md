# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/yogigill31/github-core-clone/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/yogigill31/github-core-clone/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge, built for make.fun's
[Build a GitHub-compatible git forge](https://make.fun/bounty/github-core-clone-01)
bounty ($500 in USDC).

One process, Node 22 standard library only (`node:http`, `node:crypto`,
`node:zlib`), in-memory state, no dependencies, no network, no model calls.

## What it serves

- **Git smart HTTP** (`/<owner>/<repo>.git/...`): protocol v2 (`ls-refs`,
  `fetch` with `shallow`/`filter`/`deepen`) and v0 (`upload-pack`,
  `receive-pack` with `report-status` in sideband band 1). Real SHA-1 objects,
  packfiles (version 2, no deltas), pkt-line framing, fast-forward enforcement
  with the exact `non-fast-forward` refusal, branch and tag create/delete.
- **REST v3** (`/api/v3/...`): repositories, branches, commits, contents
  (create/update/delete with sha checks), labels, issues, comments and pull
  requests with squash merge and three-way conflict detection. Bearer token
  auth, JSON everywhere, `X-GitHub-Request-Id` on every reply, Link
  pagination.
- **GraphQL v4** (`POST /api/graphql`): `viewer`, `repository`, `node(id:)`,
  `__type` introspection, issue and pull-request connections with cursor
  pagination, the five mutations (`createIssue`, `closeIssue`,
  `createPullRequest`, `mergePullRequest`, `addComment`), and batched
  operation arrays.
- **MCP** (`POST /mcp`): the 2026-07-28 era (`server/discover`) with the
  legacy `initialize` handshake as a fallback, and the six github-mcp-server
  tools (`create_repo`, `get_repo`, `create_issue`, `list_issues`,
  `create_pull_request`, `merge_pull_request`) over the same store the REST
  surface reads.

## Run it

```sh
node main.ts
```

`main.ts` is the lifecycle the harness drives: bind an ephemeral port,
register it with `MAKEFUN_ENV_URL`, poll `/done` until the trial ends. The
forge itself is `app.ts` (routing and auth), `store.ts` (the model and the git
object primitives), `git.ts` (smart HTTP), `rest.ts` (REST v3), `graphql.ts`
(GraphQL v4) and `mcp.ts` (MCP).

## Notes

- The token owner's login is the scenario's viewer, fixed by the contest's one
  seed; the entry derives it with the same PRNG the env uses (`store.ts`).
- State is in-memory: every trial starts from an empty forge, as the suite
  expects, and each check seeds what it needs through the entry's own API.

---

<sub>Entered on [make.fun](https://make.fun/?ref=7ch7x9gh&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
