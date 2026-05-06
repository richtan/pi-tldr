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

Only these confirmed-working models are supported for TLDR generation and direct selection:

1. `anthropic/claude-haiku-4-5`
2. `anthropic/claude-haiku-4-5-20251001`
3. `openai-codex/gpt-5.4-mini`
4. `openai-codex/gpt-5.3-codex-spark`

`auto` tries the supported models in this order. If none has a configured API key, the extension stays quiet instead of showing fake fallback text.

## Commands

Show available pi-tldr commands:

```text
/tldr
/tldr help
```

| Command               | Description                                                                       |
| --------------------- | --------------------------------------------------------------------------------- |
| `/tldr status`        | Show enablement, selected model, and active model after auth/fallback resolution. |
| `/tldr stats`         | Show session-local TLDR latency stats.                                            |
| `/tldr on`            | Enable TLDRs for the current session.                                             |
| `/tldr off`           | Disable TLDRs for the current session.                                            |
| `/tldr toggle`        | Toggle TLDRs for the current session.                                             |
| `/tldr model`         | Open pi's searchable TLDR model selector UI.                                      |
| `/tldr model <model>` | Save a supported TLDR model.                                                      |
| `/tldr model auto`    | Use automatic model selection.                                                    |
| `/tldr model reset`   | Return to automatic selection and remove the saved preference.                    |

### Choose a TLDR model

Prefer a specific model when starting pi:

```bash
pi --tldr-model anthropic/claude-haiku-4-5
```

Or choose from pi's searchable model selector UI:

```text
/tldr model
```

The selector includes `auto` plus the supported TLDR models available with your configured API keys.

Set a model directly:

```text
/tldr model anthropic/claude-haiku-4-5
```

Use automatic model selection:

```text
/tldr model auto
```

Reset also returns to automatic model selection and removes the saved preference:

```text
/tldr model reset
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

If the selected model is unavailable, pi-tldr falls back to `auto`. `/tldr model reset` removes the saved preference.

### Enable, disable, and inspect pi-tldr

Temporarily enable, disable, or toggle pi-tldr for the current session only:

```text
/tldr on
/tldr off
/tldr toggle
```

This does not change the saved model preference and is reset when a new pi session starts.

Check whether pi-tldr is enabled, which model is selected, and which model is active after auth/fallback resolution:

```text
/tldr status
```

Example:

```text
pi-tldr status
enabled: yes
selected model: auto
active model: anthropic/claude-haiku-4-5
```

If no supported model is available, the active model is `none`. If auth cannot be checked, the active model is `unknown (auth check failed)`.

Show the average time from a TLDR being triggered to an accepted TLDR widget update being submitted:

```text
/tldr stats
```

Example:

```text
pi-tldr stats
avg latency: 420ms
samples: 5
```

Before any TLDR update has been accepted in the current session, average latency is `n/a` and samples is `0`.

Use this as a practical responsiveness metric for pi-tldr updates.

Upgrade note: older pi-tldr versions used `/tldr-model` and `/tldr-status`. Use `/tldr model ...` and `/tldr status` instead.

## Privacy

pi-tldr sends short snippets from recent prompt, assistant, tool, and result activity to the selected TLDR model provider. This activity is generally already part of the pi agent context, but `auto` may send it to an additional or different provider from your main pi model.

pi-tldr does not attempt to detect or redact secrets. It disables prompt caching for TLDR requests and keeps snippets short, but this is not a security boundary. Do not use pi-tldr where sending these snippets to the TLDR provider is unacceptable. Use `/tldr off` to stop TLDR requests for the current session.

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
