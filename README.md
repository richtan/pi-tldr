# pi-tldr

A [pi](https://pi.dev) extension that shows a small live `tldr` box above the input bar while the agent works.

It summarizes what pi is currently doing and keeps a final result summary visible until the next prompt starts.

## Install

Install globally for all pi projects:

```bash
pi install npm:pi-tldr
```

Then restart pi, or run this inside an active pi session:

```text
/reload
```

Try it for one run without adding it to your settings:

```bash
pi -e npm:pi-tldr
```

Remove it:

```bash
pi remove npm:pi-tldr
```

## Requirements

- A recent version of pi with package/extension support.
- At least one configured API key for a supported TLDR model.

## Supported TLDR models

Only these confirmed-working, non-deprecated models are supported for TLDR generation and direct selection:

1. `anthropic/claude-haiku-4-5`
2. `anthropic/claude-haiku-4-5-20251001`
3. `anthropic/claude-sonnet-4-5`
4. `anthropic/claude-sonnet-4-5-20250929`
5. `anthropic/claude-sonnet-4-6`
6. `anthropic/claude-opus-4-1`
7. `anthropic/claude-opus-4-1-20250805`
8. `anthropic/claude-opus-4-5`
9. `anthropic/claude-opus-4-5-20251101`
10. `anthropic/claude-opus-4-6`
11. `anthropic/claude-opus-4-7`

`auto` tries the supported models in this order, with Haiku first to prefer fast, inexpensive TLDR generation. If none has a configured API key, the extension stays quiet instead of showing fake fallback text.

## Choose a TLDR model

Prefer a specific model when starting pi:

```bash
pi --tldr-model anthropic/claude-haiku-4-5
```

Or choose from pi's searchable model selector UI:

```text
/tldr-model
```

The selector includes `auto` plus the supported TLDR models available with your configured API keys.

Set a model directly:

```text
/tldr-model anthropic/claude-haiku-4-5
```

Use automatic model selection:

```text
/tldr-model auto
```

Reset also returns to automatic model selection and removes the saved preference:

```text
/tldr-model reset
```

The selected model is saved across sessions in an extension-owned config file:

```text
~/.pi/agent/pi-tldr.json
```

If `PI_CODING_AGENT_DIR` is set, the file is saved there instead.

Precedence:

1. `--tldr-model` for the current pi run
2. saved `pi-tldr.json` preference
3. `auto`, which uses the supported model list above

If the selected model is unavailable, pi-tldr falls back to `auto`. `/tldr-model reset` removes the saved preference.

## What it does

During a prompt, pi displays a compact box like:

```text
╭ tldr ─────────────────────────────────────────────╮
│ Inspecting the extension package structure        │
╰───────────────────────────────────────────────────╯
```

The TLDR updates as pi works, including during tool calls and final responses.

## License

MIT
