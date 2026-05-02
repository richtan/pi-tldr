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
- At least one configured API key for a supported fast model provider.

The extension tries these models in order:

1. `google/gemini-2.5-flash-lite`
2. `google/gemini-2.5-flash`
3. `google/gemini-2.0-flash-lite`
4. `google/gemini-2.0-flash`
5. `openai/gpt-5.4-mini`
6. `openai/gpt-5-mini`
7. `openai/gpt-4.1-mini`
8. `openai/gpt-4o-mini`
9. `anthropic/claude-haiku-4-5`
10. `anthropic/claude-haiku-4-5-20251001`

If no supported model/API key is available, the extension stays quiet instead of showing fake fallback text.

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
