# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html) (pre-1.0: minor bumps may contain breaking changes).

## [0.3.1] — 2026-04-28

### Added

- **Inbound prompt header on `BodyForAgent`.** Every dispatched message is now prefixed with a single-line header carrying the Odoo channel id, record reference, and (when supplied by the inbound webhook) the user's name and partner id. Format: `[odoo] model=<model> res_id=<id> user="<name>" partner_id=<id>`. Lets agent system prompts deterministically detect Odoo inbounds and address the user by name. Header touches only `BodyForAgent` — `Body` / `RawBody` / `CommandBody` stay raw to keep dedup/command logic unaffected.
- **`promptHeader` route field.** Optional boolean per route, default `true`. Set `false` to skip the inbound header for routes that don't need it (e.g. one-shot button-triggered actions or routes that supply their own prompt context).

## [0.3.0] — 2026-04-24

### Breaking

- **Config shape**: top-level `replyMethod` and `replyArgs` are removed. Define per-model routing via `routes` instead. See the [configuration guide](docs/configuration.md) for the full shape; migration is a direct lift into a single catchall route. Config loader throws a pointed error if the old fields are still present.

### Added

- **Per-model routing (`routes`)** — ordered list of match-rules, first match wins, catchall required at the end. Match on exact model or simple `*`-glob (e.g. `helpdesk.*`, `*.lead`).
- **Per-route agent override (`agentId`)** — a route can bind inbound messages for its models to a specific OpenClaw agent, using the same override pattern as the Telegram plugin (`buildAgentSessionKey` + `buildAgentMainSessionKey` + `deriveLastRoutePolicy`).
- **`reply.kwargs`** — XML-RPC keyword arguments are now configurable per route, with:
  - `$name` prefix for references into the variable namespace (`body`, `requestMessageId`, `model`, `resId`)
  - `$$name` for escaped literal strings starting with `$`
  - Any other string/number/boolean/array/object as literal values passed straight through
  - Existing `context: { bot_session_id }` is shallow-merged on top of user-supplied kwargs
- **Robust record-address parsing** in outbound `sendText` — handles both `model:resId` and `odoo:record:model:resId`, including models with dots (e.g. `sale.order.line`).
- **Fail-fast config validation** at startup: every malformed route surfaces with a `routes[N].<path>: <reason>` error, no silent drops.
- **Documentation**: new [configuration guide](docs/configuration.md) with Odoo-side setup, XML-RPC primer, worked examples, and a validation-errors reference table.

### Fixed

- **`webhookSecret` is strictly enforced.** Previously the handler only rejected unauthenticated requests if the secret was set, despite the schema marking it required — meaning a dropped/missing secret silently allowed all inbound. Now: `resolveAccount` throws if the secret is absent at startup, and the handler returns `503` defensively if it becomes missing via hot reload.
- **Reply-message-id round-trip.** Inbound context now sets `ReplyToId: String(last.message_id)`, which flows to `ctx.replyToId` in `attachedResults.sendText`. Without this, the outbound XML-RPC call received `requestMessageId: 0`, which caused the Odoo-side tracking flip + bus notification to be skipped — the reply was sent but the user's panel never refreshed until manual reload.

## [0.2.1] — 2026-03-?? and earlier

Initial public release. See git history.
