# Contributing

## Development Setup

```bash
git clone https://github.com/mondaymerch/openclaw-channel-odoo.git
cd openclaw-channel-odoo
npm install
npm run build
```

## Project Structure

```
src/
  index.ts     — Plugin entry point (webhook registration)
  channel.ts   — Channel config, security, outbound adapter
  client.ts    — Odoo XML-RPC client
```

## Building

```bash
npm run build      # Compile TypeScript → dist/
npm run dev        # Watch mode
npm run lint       # Type check without emitting
```

## Testing with OpenClaw

1. Build the plugin: `npm run build`
2. Install in your OpenClaw instance: `openclaw plugins install /path/to/openclaw-channel-odoo`
3. Add `channels.odoo` config to `openclaw.json`
4. Restart the gateway

## Submitting Changes

1. Fork the repo
2. Create a feature branch: `git checkout -b my-feature`
3. Make your changes
4. Run `npm run lint` to check for type errors
5. Commit and push
6. Open a PR against `main`
