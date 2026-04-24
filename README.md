<h1 align="center">Odoo - Openclaw</h1>

<p align="center">
  <b>The bridge between Odoo and OpenClaw agents — for conversations, actions, and workflows.</b>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/openclaw-channel-odoo"><img src="https://img.shields.io/npm/v/openclaw-channel-odoo.svg" alt="npm"></a>
  <img src="https://img.shields.io/badge/odoo-15%2B-875A7B" alt="odoo 15+">
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT">
</p>

---

An [OpenClaw](https://openclaw.dev) channel plugin that wires OpenClaw agents into Odoo. Any Odoo event — a button click, a chat input, a cron — can hand off to an agent, and the agent's output can flow back into Odoo as a chatter message, a newly created record, a field update, or anything else callable via XML-RPC.

- 🪝 **Inbound**: any Odoo trigger → agent (auth'd, deduped, debounced)
- 📤 **Outbound**: agent output → any Odoo method, configurable per model
- 🔍 **Tool**: `odoo_search_read` — the agent reads Odoo data on demand
- 🎯 **Per-model routing**: different methods, agents, prompts per Odoo record type

> **Heads up** — the plugin is one half of the integration. You also need a small Odoo-side addon (an HTTP controller that POSTs to the webhook, and the method(s) the plugin calls back into). See the [Odoo-side setup](docs/configuration.md#odoo-side-setup) section of the configuration guide for a copy-paste minimal example.

---

## Quick start

Install via OpenClaw:

```bash
openclaw plugins install openclaw-channel-odoo
```

Minimal `openclaw.json`:

```jsonc
{
  "channels": {
    "odoo": {
      "url": "https://myodoo.com",
      "db": "mydb",
      "uid": 2,
      "password": "<api-key>",
      "webhookSecret": "<shared-bearer-token>",
      "webhookPath": "/openclaw/inbound",

      "routes": [
        {
          "match": "*",
          "reply": {
            "method": "message_post",
            "kwargs": {
              "body": "$body",
              "message_type": "comment"
            }
          }
        }
      ]
    }
  }
}
```

With the minimal Odoo-side controller (shown in the [configuration guide](docs/configuration.md#odoo-side-setup)), this config routes every inbound message through your agent and posts the reply back to the triggering record's chatter. No custom Odoo methods needed — `message_post` is built in.

For per-model routing, agent overrides, custom reply methods, and the variable system — see the [configuration guide](docs/configuration.md).

---

## How it works

```
┌──────────────┐   webhook   ┌─────────┐   dispatch   ┌───────┐
│  Odoo action │ ──────────► │  Plugin │ ───────────► │ Agent │
└──────────────┘             └─────────┘              └───────┘
       ▲                          │
       │    XML-RPC execute_kw    │
       └──────────────────────────┘
```

1. Something happens in Odoo — a button press, a chat input, a workflow event
2. Your Odoo-side controller POSTs the trigger to the plugin's webhook (Bearer-auth'd)
3. Plugin routes the message to an agent (optionally per-model)
4. Agent does its thing and produces output; plugin calls back into Odoo via the method configured for that model

---

## Documentation

- 📖 **[Configuration guide](docs/configuration.md)** — Odoo-side setup, routes, matching, the variable system, worked examples, validation errors
- 🐛 **[Issues](https://github.com/mondaymerch/openclaw-channel-odoo/issues)** — bug reports and feature requests
- 📋 **[Changelog](CHANGELOG.md)** — version history

---

## License

[MIT](LICENSE) · © Monday Merch B.V.
