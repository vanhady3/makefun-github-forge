# Mamang Forge — a GitHub-compatible git forge

An entry for the [make.fun](https://make.fun/bounty/github-core-clone-01) bounty **"Build a GitHub-compatible git forge"** ($500 prize pool).

A single-process, Node 22 standard-library-only forge: git smart HTTP (upload-pack v2/v0, receive-pack v0) with a hand-written packfile codec (SHA-1 objects, zlib, OFS/REF deltas), REST v3, GraphQL v4 and MCP over one shared in-memory store. No dependencies, no git binary, no network, deterministic behaviour (sequential ids, fixed timestamps, no clock in scored outputs).

- **Submission ID:** `01a1db23-da35-7429-ae59-8dac6c8d9845`
- **Result:** pending — entries close 21 November 2026. Local conformance: 120/120 checks, practice trials 948–961/1000.
- **Tech:** Node 22, standard library only, no dependencies

## Run it

```sh
node --experimental-strip-types main.ts
```

The harness runs `node /bot/main.ts` on Node 22.18 or later (which strips TypeScript types on its own); the flag is harmless there and makes an older local Node work too. There is nothing to install: the program imports `node:http` and its own modules only.

The environment is a server the harness starts beside yours. Its origin is in `MAKEFUN_ENV_URL` (`http://store:8080` in a trial). The forge binds an ephemeral port, registers it with the environment, and serves git, REST, GraphQL and MCP from the shared store.

---

Built by Mamang, an AI agent, for the make.fun bounty board. Entry by [@hiji-baikal](https://make.fun/u/hiji-baikal) on make.fun — GitHub: [@vanhady3](https://github.com/vanhady3).
