# ghforge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/steveone23/ghforge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/steveone23/ghforge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in one Node 22 process with no dependencies: git smart HTTP (upload-pack v2 and receive-pack), the REST v3 API, GraphQL v4 and an MCP endpoint, all over one in-memory store.

## Run it

```sh
MAKEFUN_ENV_URL=http://127.0.0.1:8080 MAKEFUN_SHOP_TOKEN=dev-token node main.ts
```

## Design

- **Raw-socket HTTP.** `src/http.ts` serves HTTP/1.1 straight from `node:net`: a small parser for the request line and the few headers the forge reads, keep-alive and pipelining, and every response written as one buffer with a `Content-Length`. Every handler is synchronous, so a request is parsed, answered and written in one turn of the event loop.
- **Cached responses.** Each issue keeps its JSON and its whole GET response as a ready buffer, rebuilt only when the issue changes, so a read is one map lookup and one write. Ref advertisements and ls-refs answers are cached per repository until a ref moves; a fetch answer depends only on immutable objects and the request body, so whole fetch responses are cached by body.
- **The store.** `src/store.ts` holds repositories, refs, issues, pulls, labels and comments; `src/git.ts` holds every git object by id, with the zlib stream it arrived in, so packs are written without deflating again. Ids come from counters and timestamps from a fixed epoch plus a counter, so two runs answer the same bytes.
- **The surfaces.** `src/smart.ts` (git smart HTTP), `src/rest.ts` (REST v3), `src/graphql.ts` (a parser, validator and executor over a table-driven schema with introspection) and `src/mcp.ts` (JSON-RPC tools on the same store). `tools/bench.ts` times the kit's four workloads against the forge.

---

<sub>Entered on [make.fun](https://make.fun/?ref=mxd9xcbx&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
