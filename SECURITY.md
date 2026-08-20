# Security Policy

## Supported versions

Dagents is pre-1.0. Security fixes land on `main` and ship with the next
release tag; there are no backport branches yet.

| Version | Supported |
|---|---|
| `main` / latest tag | ✅ |
| older tags | ❌ |

## Reporting a vulnerability

**Please do not open public issues for security problems.**

- Prefer GitHub's [private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-reviewing/privately-reporting-a-security-vulnerability)
  on this repository (Settings → Security → "Report a vulnerability").
- Alternatively, contact a maintainer directly via GitHub private message.

We aim to acknowledge reports within **7 working days**. Please include
reproduction steps, affected routes/components, and your assessment of impact.
Responsible disclosure is appreciated — we're happy to credit reporters in the
advisory.

## Scope

In scope:

- Authentication / authorization bypasses on the gateway (`GATEWAY_API_KEY`
  mode, SSO session mode, daemon register tokens)
- SSRF or secret exfiltration via the LLM provider proxy or HTTP nodes
- Injection through the dispatch ↔ daemon protocol
- Path traversal in directory / skill / agent-library file handling
- Secret leakage in logs, traces, or error responses

Out of scope (documented design trade-offs, see `docs/workflow-engine.md`
「现状与限制」):

- `CustomFunction` / tool / loop-condition JS runs via `new Function` — **not a
  hard sandbox**. Flows are authored by the machine owner, not by anonymous
  end users. Do not expose flow authoring to untrusted parties.
- LLM provider fetches currently have no timeout/cancellation.
- Ordinary `LLM` nodes are single-shot; `PlatformAgent` nodes do run tool
  loops with the privileges of the configured CLI agent.

## Privacy

- **No telemetry, no analytics, no accounts, no callbacks home.** The only
  outbound network calls are to LLM providers you configure and to CLI agents
  you run.
- All state lives in your local Postgres.
- LLM API keys are encrypted at rest with AES-256-GCM when `ENCRYPTION_KEY` is
  set (without it they are only Base64-encoded — the gateway logs a warning).

## Deployment hardening

The gateway binds `127.0.0.1` by default. Before exposing it beyond localhost,
read the security section in `README.md` (`GATEWAY_API_KEY`,
`DAEMON_REGISTER_TOKEN`, `ENCRYPTION_KEY`, `SSO_*`).

## History note

The full git history was audited for leaked secrets before the repository was
made public (2026-08-20); no real credentials were found.
