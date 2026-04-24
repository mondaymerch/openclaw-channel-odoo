# Configuration Guide

Everything you need to wire `openclaw-channel-odoo` into your stack: the Odoo-side addon you must supply, how Odoo XML-RPC maps to Python calls, how routes work, what the variable namespace is, and how to target different Odoo methods per model.

If you just want a one-paragraph overview, see the [README](../README.md).

---

## Table of Contents

- [Odoo-side setup](#odoo-side-setup)
- [Odoo XML-RPC in 60 seconds](#odoo-xml-rpc-in-60-seconds)
- [Routes](#routes)
- [The `reply` spec](#the-reply-spec)
- [Variables and refs](#variables-and-refs)
- [`args` vs `kwargs`](#args-vs-kwargs--which-do-i-use)
- [Worked examples](#worked-examples)
- [Validation errors](#validation-errors)
- [Not supported yet](#not-supported-yet)

---

## Odoo-side setup

The plugin is **only one half** of the integration. You also need, on Odoo's side:

1. An **HTTP controller** that your UI / buttons / crons call. It POSTs the trigger (model, res_id, user message, …) to the plugin's `webhookPath`, using `Authorization: Bearer <webhookSecret>`.
2. A **reply method** on an Odoo model, callable via XML-RPC. This is whatever the plugin's matched route tells it to call back — it can be a built-in like `message_post`, or a custom method you write.

Below is a minimum working addon you can drop in. It uses Odoo's built-in `message_post` as the reply (so no custom model/method needed) and a trivial controller that forwards UI requests to the plugin.

### Minimal addon layout

```
my_openclaw_bridge/
├── __init__.py
├── __manifest__.py
└── controllers/
    ├── __init__.py
    └── main.py
```

### `__manifest__.py`

```python
{
    'name': 'My OpenClaw Bridge',
    'version': '15.0.1.0.0',
    'depends': ['base', 'mail'],
    'license': 'LGPL-3',
}
```

### `__init__.py` / `controllers/__init__.py`

```python
# __init__.py
from . import controllers

# controllers/__init__.py
from . import main
```

### `controllers/main.py`

```python
import time
import threading

import requests as http_requests
from odoo import http
from odoo.http import request


class OpenclawBridgeController(http.Controller):

    @http.route('/my_openclaw/ask', type='json', auth='user', methods=['POST'])
    def ask(self, model, res_id, body):
        """Forward a user message to the OpenClaw gateway.

        Call this from your own UI (button, modal, chat panel, whatever).
        The gateway will route the message to an agent per its route config,
        and call back into Odoo via the configured reply method.
        """
        res_id = int(res_id)
        record = request.env[model].browse(res_id)
        record.check_access_rights('read')
        record.check_access_rule('read')

        ICP = request.env['ir.config_parameter'].sudo()
        url = ICP.get_param('openclaw.gateway_url')       # e.g. http://10.0.0.1:18789/openclaw/inbound
        token = ICP.get_param('openclaw.webhook_token')   # shared secret (== webhookSecret in openclaw.json)

        if not url or not token:
            return {'ok': False, 'error': 'openclaw not configured'}

        # message_id: any positive int, unique per call. Millisecond epoch
        # is fine for a simple setup; the gateway uses it for dedup and to
        # carry through as requestMessageId into the reply.
        message_id = int(time.time() * 1000)

        payload = {
            'model': model,
            'res_id': res_id,
            'body': body,
            'message_id': message_id,
            'user_name': request.env.user.name,
            'partner_id': request.env.user.partner_id.id,
        }

        # Fire-and-forget so the user gets an immediate response.
        threading.Thread(
            target=lambda: http_requests.post(
                url,
                json=payload,
                headers={'Authorization': f'Bearer {token}'},
                timeout=5,
            ),
            daemon=True,
        ).start()

        return {'ok': True, 'message_id': message_id}
```

### System parameters to set

In Odoo Settings → Technical → System Parameters:

| Key | Value |
|---|---|
| `openclaw.gateway_url` | Full URL to the plugin's webhook, e.g. `http://10.0.0.1:18789/openclaw/inbound` |
| `openclaw.webhook_token` | Shared secret — must match `webhookSecret` in your `openclaw.json` |

### Plugin config for this setup

```jsonc
{
  "channels": {
    "odoo": {
      "url": "https://myodoo.com",
      "db": "mydb",
      "uid": 2,
      "password": "<api-key>",
      "webhookSecret": "<same-as-openclaw.webhook_token>",
      "webhookPath": "/openclaw/inbound",

      "routes": [
        {
          "match": "*",
          "reply": {
            "method": "message_post",
            "kwargs": {
              "body":         "$body",
              "message_type": "comment",
              "subtype_xmlid": "mail.mt_comment"
            }
          }
        }
      ]
    }
  }
}
```

### End-to-end on first run

1. User triggers something in your UI (e.g. clicks a "Ask AI" button on a CRM lead)
2. UI calls `/my_openclaw/ask` with `{ model: "crm.lead", res_id: 1234, body: "Summarise this lead" }`
3. Controller POSTs to the plugin at `http://<gateway>/openclaw/inbound`
4. Plugin auth-checks, dedups, dispatches to the agent
5. Agent produces a reply
6. Plugin calls `env["crm.lead"].browse([1234]).message_post(body=<reply>, message_type="comment", subtype_xmlid="mail.mt_comment")` via XML-RPC
7. The reply shows up in the lead's standard chatter

Once this works, you can add routes that call custom methods, per-model agents, persistence models for request/reply tracking, custom notification schemes, etc. — see [Worked examples](#worked-examples) for inspiration.

---

## Odoo XML-RPC in 60 seconds

If you already know how `execute_kw` works, skip this section.

Odoo exposes an external API over XML-RPC at `/xmlrpc/2/object`. Every call has this shape:

```
execute_kw(db, uid, password, model, method, args, kwargs)
```

- `db`, `uid`, `password` — authentication
- `model` — the Odoo model name (`"crm.lead"`, `"sale.order"`, etc.)
- `method` — the method name as a string
- `args` — a **JSON array** of positional arguments
- `kwargs` — a **JSON object** of keyword arguments

On Odoo's side this is dispatched to Python. For **recordset methods** (the common case), the first element of `args` is always the list of record ids, and the remaining elements become the method's positional arguments:

```
# on the wire
args   = [[1234], "hello", 17]
kwargs = { "subject": "Update" }

# on Odoo's side
records = env["crm.lead"].browse([1234])
records.some_method("hello", 17, subject="Update")
```

The three equivalent ways to call `records.some_method(body="hello", request_message_id=17)`:

| Wire `args` | Wire `kwargs` |
|---|---|
| `[[1234], "hello", 17]` | `{}` |
| `[[1234], "hello"]` | `{"request_message_id": 17}` |
| `[[1234]]` | `{"body": "hello", "request_message_id": 17}` |

Whether you pass things positionally or as kwargs depends on the Python method's signature. Some methods (notably `mail.thread.message_post`) are keyword-only (`def message_post(self, *, body='', ...)`), so you **must** use `kwargs`. Simpler methods accept either.

That's all the XML-RPC you need to know to configure this plugin.

---

## Routes

`routes` is an ordered list of per-model rules. When an inbound message arrives on `crm.lead:1234`, the plugin walks the list top-down and **uses the first rule whose `match` accepts `"crm.lead"`**.

```jsonc
"routes": [
  { "match": { "model": "crm.lead" },   "reply": { "method": "summarise_lead",  "args": ["body"] } },
  { "match": { "model": "helpdesk.*" }, "reply": { "method": "post_ai_note",    "args": ["body"] } },
  { "match": "*",                        "reply": { "method": "message_post",    "kwargs": { "body": "$body", "message_type": "comment" } } }
]
```

### Match syntax

- `"*"` — catchall, matches anything
- `{ "model": "<pattern>" }` — model name or glob. The only glob metacharacter is `*` (no `?`, no regex, no brace expansion)

Glob examples:
- `"crm.lead"` — exact match
- `"helpdesk.*"` — anything starting with `helpdesk.`
- `"*.lead"` — anything ending with `.lead`
- `"sale.order.*"` — anything starting with `sale.order.`
- `"*"` — catchall (equivalent to `match: "*"`)

### Rules

- `routes` is required and non-empty
- The **last entry** must be `match: "*"` (catchall) — enforced at config load. No silent drops if nothing matches
- First match wins. A later, more-specific rule will never fire if an earlier broader one captures the model first — order your list specific → general

### Per-route agent override (optional)

Add `agentId` to a route to route messages on that model to a specific OpenClaw agent (overrides the SDK's binding-based routing for that peer):

```jsonc
{
  "match": { "model": "crm.lead" },
  "agentId": "sales-assistant",
  "reply": { ... }
}
```

The agent must exist in your `agents.list` elsewhere in the OpenClaw config. If you don't set `agentId`, the SDK's default binding resolution applies.

---

## The `reply` spec

Every route has a required `reply` block that tells the plugin how to call Odoo when the agent produces a reply.

```ts
"reply": {
  "method": "<odoo method name>",   // required
  "args":   ["<var1>", "<var2>"],   // optional, positional
  "kwargs": { ... }                 // optional, keyword
}
```

- `method` — the Odoo method name as a string
- `args` — ordered list of **variable names**. Each entry is always a reference (never a literal). The resolved values become positional XML-RPC args **after** the implicit recordset `[resId]`
- `kwargs` — keyword args. Each value is either a reference (prefix with `$`) or a literal (anything else). See [Variables and refs](#variables-and-refs)

At least one of `args` / `kwargs` can be omitted if the target Odoo method takes no further arguments beyond the recordset.

### The implicit `[resId]`

The first positional arg of every XML-RPC call is always `[resId]` — the recordset ids. You never configure it; it's derived from the inbound message's target record. This is Odoo's convention for calling methods on a recordset.

So for a config like `"args": ["body"]` on record `1234`, the wire-level positional args become:

```
args = [[1234], <body value>]
```

And Python sees:

```python
env["crm.lead"].browse([1234]).<method>(<body value>)
```

---

## Variables and refs

When the agent replies, the plugin builds a fixed namespace of **four variables**, called the `argMap`:

| Variable | Value |
|---|---|
| `body` | The agent's reply text (a string) |
| `requestMessageId` | The id of the inbound message that triggered this reply (integer — the `message_id` your controller sent in the webhook payload) |
| `model` | The Odoo model the reply is going to (e.g. `"crm.lead"`) |
| `resId` | The record id (e.g. `1234`) |

References in `args` and `kwargs` resolve against this namespace at call time.

### `args`: always references

Every entry in `args` is a variable name. No `$` prefix:

```jsonc
"args": ["body", "requestMessageId"]
```

Any name that isn't one of the four above fails at config load.

### `kwargs`: refs vs literals, disambiguated by `$`

In `kwargs`, a value is one of:

| Value | Classification | Resolved value |
|---|---|---|
| String starting with `$` (e.g. `"$body"`) | **Reference** | `argMap[body]` at call time |
| String starting with `$$` (e.g. `"$$foo"`) | **Escaped literal** | The string `"$foo"` (strip leading `$$` → `$`) |
| Any other string (e.g. `"comment"`) | **Literal string** | Passed as-is |
| Number, boolean, array, object, null | **Literal** | Passed as-is (typed correctly on the XML-RPC wire) |

Example:

```jsonc
"kwargs": {
  "body":         "$body",         // ref → agent's reply text
  "message_type": "comment",       // literal string
  "partner_ids":  [5, 7],          // literal array
  "validity_days": 14,             // literal number
  "auto_confirm": false,           // literal bool
  "note":         "$$urgent"       // literal string "$urgent"
}
```

Ref names in `kwargs` are validated against the same four-variable allowlist at config load. `"$foo"` where `foo` isn't known → config error.

### Three-stage transform

It's useful to see what your config becomes at each stage:

**Stage 1 — what you write in `openclaw.json`:**
```jsonc
"kwargs": { "body": "$body", "message_type": "comment", "priority": 3 }
```

**Stage 2 — compiled at startup, stored on the route:**
```ts
{
  body:         { kind: "ref",     name:  "body" },
  message_type: { kind: "literal", value: "comment" },
  priority:     { kind: "literal", value: 3 }
}
```

**Stage 3 — resolved at call time, sent to Odoo:**
```ts
{ body: "I'll create a quote…", message_type: "comment", priority: 3 }
```

The `kind` tags are internal scaffolding — Odoo never sees them.

---

## `args` vs `kwargs` — which do I use?

Depends on the Python signature of the Odoo method you're calling.

**Use `args` (positional)** when the method accepts positional arguments:

```python
def handle_ai_reply(self, body, request_message_id=None):
    ...
```

```jsonc
"reply": { "method": "handle_ai_reply", "args": ["body", "requestMessageId"] }
```

**Use `kwargs`** when the method is keyword-only or you want to pass things by name:

```python
def message_post(self, *, body='', subject=None, message_type='notification', ...):
    ...
```

```jsonc
"reply": {
  "method": "message_post",
  "kwargs": { "body": "$body", "message_type": "comment" }
}
```

**Mix both** if the method has required positional + optional keyword:

```python
def custom_reply(self, body, message_type='comment', sender_id=None):
    ...
```

```jsonc
"reply": {
  "method": "custom_reply",
  "args":   ["body"],
  "kwargs": { "message_type": "comment" }
}
```

---

## Worked examples

### 1. Post agent reply to standard chatter

No custom Odoo method required. Agent's reply lands in the triggering record's standard chatter as a regular message — visible to anyone following the record. Combine with the minimal controller from [Odoo-side setup](#odoo-side-setup) for a complete end-to-end integration.

```jsonc
"routes": [
  {
    "match": "*",
    "reply": {
      "method": "message_post",
      "kwargs": {
        "body":          "$body",
        "message_type":  "comment",
        "subtype_xmlid": "mail.mt_comment"
      }
    }
  }
]
```

Python call on Odoo:
```python
env["crm.lead"].browse([1234]).message_post(
    body="<agent reply>",
    message_type="comment",
    subtype_xmlid="mail.mt_comment",
)
```

### 2. Custom reply method with tracking

If you want to track AI requests and replies as their own records (e.g. to build a chat UI or audit), define a model + a method. The plugin passes the `requestMessageId` so you can correlate replies with the originating request.

Odoo side:

```python
class AiConversationLine(models.Model):
    _name = 'my_app.ai_conversation_line'
    _description = 'AI conversation line'

    body = fields.Text(required=True)
    model = fields.Char(required=True, index=True)
    res_id = fields.Integer(required=True, index=True)
    direction = fields.Selection([('request', 'Request'), ('reply', 'Reply')])
    request_message_id = fields.Integer(index=True)


class MailThread(models.AbstractModel):
    _inherit = 'mail.thread'

    def handle_ai_reply(self, body, request_message_id=None):
        """Called by the OpenClaw plugin via XML-RPC."""
        self.ensure_one()
        reply = self.env['my_app.ai_conversation_line'].sudo().create({
            'body': body,
            'model': self._name,
            'res_id': self.id,
            'direction': 'reply',
            'request_message_id': request_message_id,
        })
        self.message_post(body=body, message_type='comment')
        return reply.id
```

Plugin config:

```jsonc
"routes": [
  {
    "match": "*",
    "reply": {
      "method": "handle_ai_reply",
      "args":   ["body", "requestMessageId"]
    }
  }
]
```

### 3. Trigger a workflow — agent creates a quote from a CRM lead

The reply doesn't have to be a chatter message. It can kick off any logic. Here, a button in the CRM lead UI ("Generate quote from conversation") calls the controller from [Odoo-side setup](#odoo-side-setup); the agent reads the lead, decides on terms, and the reply method creates a `sale.order` with per-route-configurable flags.

Odoo side:

```python
class CrmLead(models.Model):
    _inherit = 'crm.lead'

    def create_quote(self, body, validity_days=30, auto_confirm=False):
        self.ensure_one()
        order = self.env['sale.order'].create({
            'partner_id': self.partner_id.id,
            'opportunity_id': self.id,
            # ... more fields
        })
        self.message_post(body=body, message_type='comment')
        if auto_confirm:
            order.action_confirm()
        return order.id
```

Plugin config — different flags per model, same method:

```jsonc
"routes": [
  {
    "match": { "model": "crm.lead" },
    "agentId": "sales-assistant",
    "reply": {
      "method": "create_quote",
      "args":   ["body"],
      "kwargs": { "validity_days": 14, "auto_confirm": false }
    }
  },
  {
    "match": "*",
    "reply": {
      "method": "message_post",
      "kwargs": { "body": "$body", "message_type": "comment" }
    }
  }
]
```

### 4. Different agents for different models

Route CRM leads to a sales agent, helpdesk tickets to a support agent, everything else to a default:

```jsonc
"routes": [
  {
    "match": { "model": "crm.lead" },
    "agentId": "sales-assistant",
    "reply": { "method": "message_post", "kwargs": { "body": "$body", "message_type": "comment" } }
  },
  {
    "match": { "model": "helpdesk.*" },
    "agentId": "support-assistant",
    "reply": { "method": "message_post", "kwargs": { "body": "$body", "message_type": "comment" } }
  },
  {
    "match": "*",
    "reply": { "method": "message_post", "kwargs": { "body": "$body", "message_type": "comment" } }
  }
]
```

The system prompts for `sales-assistant` and `support-assistant` live on the respective agent configs (`agents.list[*].systemPromptOverride`), not on the plugin.

---

## Validation errors

Config is validated at startup. All errors are fail-fast with a path pointing at the offending entry.

| Error | Meaning | Fix |
|---|---|---|
| `odoo: url, db, uid, and password are required in channels.odoo` | Missing core connection info | Add all four |
| `odoo: webhookSecret is required in channels.odoo` | No Bearer secret configured | Set `webhookSecret` (same value as your Odoo-side `ir.config_parameter` `openclaw.webhook_token`) |
| `odoo: replyMethod/replyArgs are removed — configure channels.odoo.routes instead` | Using deprecated top-level config | Move to `routes` (see [examples](#worked-examples)) |
| `odoo: routes: required non-empty array in channels.odoo` | `routes` missing or empty | Add at least one route, with catchall last |
| `odoo: routes: last entry must be { match: "*" } (catchall) — got routes[N]` | No catchall at end of list | Append `{ "match": "*", "reply": {...} }` |
| `odoo: routes[N].match: must be "*" or { model: "<glob>" }` | Invalid match shape | Check syntax |
| `odoo: routes[N].reply.method: required non-empty string` | Missing/empty method name | Fix the method field |
| `odoo: routes[N].reply.args[M]: unknown variable "<name>"` | Typo in a variable ref | Must be one of `body`, `requestMessageId`, `model`, `resId` |
| `odoo: routes[N].reply.kwargs.<key>: unknown variable "$<name>"` | Typo in a `$`-prefixed kwarg ref | Same allowlist as above. If you wanted a literal `$foo`, escape with `$$foo` |

---

## Not supported yet

These are deliberate deferrals — the config shape is designed to accept them later without breaking existing routes:

- **`systemPrompt` per route** — inject a per-model system prompt snippet. For now, use per-agent `systemPromptOverride` combined with `agentId` routing
- **`parseOutput: "json"` per reply** — parse the agent's text as JSON and expose its fields as additional variables for `args`/`kwargs` to reference. Lets the agent itself drive kwarg values
- **`target: "record" | "model"`** — call `@api.model` (model-level) methods that don't prefix `[resId]`. Currently every method is called with the recordset convention
- **Multiple accounts** — the plugin exposes a single `default` account. Multi-instance Odoo connections need work in this plugin and in the channel-core SDK
