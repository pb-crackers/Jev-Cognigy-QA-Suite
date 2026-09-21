# Jev Cognigy QA

Score **every** Cognigy conversation against rubrics you write, instead of hand-reviewing
1–3% of them and extrapolating.

It pulls sessions from the Cognigy OData feed, reassembles each into a readable transcript,
and asks [TypeSafe Jev](https://typesafe.ai) a set of typed questions about it. Jev is a
classifier rather than a language model: it reads the transcript once and answers every
question in parallel, so **a library of thirty rubrics costs the same single request as
one**.

Measured against a live environment: **57 sessions, 9 rubrics, $0.0025, 314ms per session.**

An illustrated walkthrough of the architecture lives in `docs/overview.html` — clone the
repo and open it in a browser, since GitHub shows HTML files as source rather than
rendering them.

## Use it with your coding agent

Paste this to Claude Code, Codex, or whatever you use:

> Clone `https://github.com/pb-crackers/Jev-Cognigy-QA-Suite`, follow its AGENTS.md to set it
> up, then help me QA my Cognigy conversations.

Your agent installs the tool and a skill that teaches it how to drive it, then hands the
credentials step back to you — it should never handle your API keys. After that you just
talk to it:

> *"Check whether our agents are confirming details back to customers before acting.
> Score last week."*

It writes the rubric, runs the date range, and reads the findings back to you.

## Or set it up yourself

```bash
npm run setup          # installs, links the CLI, installs the agent skill
jev-cognigy-qa init    # prompts for your API keys and verifies each one
jev-cognigy-qa         # opens the web UI on localhost:4174
```

You will need a TypeSafe API key, a Cognigy API key, and the `odata` global role on your
Cognigy user — that last one is granted separately from the key itself.

## Commands

| Command | Does |
| --- | --- |
| *(no argument)* | Open the web UI |
| `init` | Configure credentials, verifying each one |
| `projects` | List Cognigy projects |
| `endpoints --project <name>` | List endpoints, plus the Interaction Panel |
| `rubrics` | Read the rubric library |
| `rubric add --json <json>` | Add or update rubrics |
| `rubric rm <id>` | Delete one |
| `score --project <name> --from <date> --to <date>` | Score a date range |
| `report [<runId>]` | A past run as JSON, or list runs |
| `brief [<runId>]` | Synthesised findings as markdown |

JSON goes to stdout, progress to stderr.

## How a rubric works

A question, an answer type, and a weight. The three types map onto what Jev returns:

| Type | For | Returns |
| --- | --- | --- |
| `boolean` | Did this happen? | A probability, 0–1 |
| `score` | How much, on a scale you define | A level, plus confidence |
| `choice` | Which of several outcomes | An option, plus confidence |

Weights are applied when you read results, not when they are scored — so changing what
matters re-ranks an entire history instantly, with no request and no cost.

**Low confidence is not a bad score.** It usually means the transcript did not contain
enough to judge, and that session is flagged for a person to read. A rubric that comes back
low-confidence almost everywhere is usually the rubric's fault, not the agent's.

## Requirements

Node 22.6 or newer — the CLI is TypeScript run directly, with no build step. The only
runtime dependency is the TypeSafe SDK.

You will also need, on the Cognigy side:

- an API key from your profile;
- the **`odata`** global role on that user, granted separately in Admin Center;
- the OData host that matches your API host — `api-trial-us` pairs with `odata-trial-us`.
  A mismatch returns `401` with a perfectly good key, which is the most common setup
  failure. `init` suggests the right one.

## Licence

MIT.
