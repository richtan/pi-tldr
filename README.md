# pi-tldr

A [pi](https://pi.dev) extension that shows a small live `tldr` box above
the input bar while the agent works.

It writes a TLDR of what pi is currently doing and keeps the final TLDR visible
until the next prompt starts.

## What it does

During a prompt, pi displays a TLDR box like:

```text
╭ tldr ─────────────────────────────────────────────╮
│ Inspecting the extension package structure        │
╰───────────────────────────────────────────────────╯
```

The TLDR updates as pi works, including during tool calls and final responses.

## How it works

pi-tldr records each prompt, assistant update, tool call, tool result, and
final response as activity. For each activity, it asynchronously asks the
selected TLDR model for a generated status checkpoint.

Each checkpoint prompt includes recent generated TLDR checkpoints as compact
context plus the new raw activity that has not been summarized yet. Follow-up
prompts keep this generated context, so pi-tldr can summarize continuations
without starting from scratch.

The widget does not show local fallback summaries. It renders completed model
output when available, shows user-prompt and final-response checkpoints
immediately, and throttles ordinary activity updates to avoid flicker.

## Install

Install globally:

```bash
pi install npm:pi-tldr
```

Try it for one session:

```bash
pi -e npm:pi-tldr
```

Remove it:

```bash
pi remove npm:pi-tldr
```

## Requirements

- A recent version of pi with package/extension support.
- At least one configured API key for either your configured TLDR model or an
  automatic fallback model.

## TLDR model selection

By default, `auto` tries these fast models in order:

1. `openai-codex/gpt-5.4-mini`
2. `openai-codex/gpt-5.3-codex-spark`
3. `anthropic/claude-haiku-4-5`
4. `anthropic/claude-haiku-4-5-20251001`

If none has a configured API key, the extension shows `no tldr model authenticated`
above the editor instead of showing fake fallback text.

To prefer a specific TLDR model, set it in pi settings:

Global:

```json
{
  "tldr": {
    "model": "anthropic/claude-haiku-4-5"
  }
}
```

Save this in:

```text
~/.pi/agent/settings.json
```

Project settings override global settings. Save project settings in:

```text
.pi/settings.json
```

Set the model to `auto`, omit the setting, or provide an invalid model string
to use automatic model selection. If a configured provider/model cannot be
found or authenticated, pi-tldr falls back to `auto`.

## Commands

Show available pi-tldr commands:

```text
/tldr
/tldr help
```

| Command        | Description                                                    |
| -------------- | -------------------------------------------------------------- |
| `/tldr status` | Show selected and active model after auth/fallback resolution. |

### Inspect pi-tldr

Check which model is selected and which model is active after auth/fallback
resolution:

```text
/tldr status
```

Example:

```text
pi-tldr status
selected model: auto
active model: openai-codex/gpt-5.4-mini
```

If no supported model is available, the active model is `none` and pi-tldr shows
`no tldr model authenticated` above the editor. If auth cannot be checked, the
active model is `unknown (auth check failed)`.

## Privacy

pi-tldr sends short snippets from recent prompt, assistant, tool, and result
activity to the selected TLDR model provider. Requests may also include recent
generated TLDR checkpoint summaries from the current session. This activity is
generally already part of the pi agent context, but `auto` may send it to an
additional or different provider from your main pi model.

pi-tldr does not attempt to detect or redact secrets. It disables prompt caching
for TLDR requests and keeps snippets short, but this is not a security boundary.
Do not use pi-tldr where sending these snippets to the TLDR provider is
unacceptable.

## License

MIT
