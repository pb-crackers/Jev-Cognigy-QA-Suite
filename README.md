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

## Agent Watch

Scoring a date range answers "how did we do last week". Agent Watch answers "how is the
agent doing right now" — and tells you when something needs you.

Define an **agent** — a project, the endpoints that are its traffic, and the rubrics it is
graded on — and leave the app running. It collects new conversations on a schedule, scores
them, fires alerts, and keeps a health figure for every agent you watch.

```bash
jev-cognigy-qa agent suggest --project "My project"        # agents proposed from its endpoints
jev-cognigy-qa agent add --project "My project" --suggestion my-agent
jev-cognigy-qa watch                                        # UI, webhook and collector, no browser
jev-cognigy-qa daemon install                               # keep it running from login (macOS)
```

What it adds:

- **A health figure that says what it rests on.** The mean composite over a window, with a
  95% interval, flagged as indicative below thirty sessions, weighted towards rubrics that
  have been checked, and reporting how much of itself rests on them.
- **Alert rubrics.** A yes/no question with a threshold and a window: "tell me every time the
  agent offers a discount", or "tell me when there are ten jailbreak attempts in a day".
  Windows are keyed on when conversations happened, so a catch-up after the laptop was
  closed does not trip them all at once. Alerts go to a macOS notification and a webhook
  (Slack and Teams both render it).
- **A rubric library** that ships with the tool: jailbreak attempts and whether they worked,
  disclosed instructions, sensitive data requests, harmful content — and, for agents whose
  LLM calls are logged, whether the agent broke its own instructions, stated facts its
  instructions say must come from a tool, invented tool arguments, or claimed actions it
  never took.
- **The agent's own instructions and tool calls.** AI Agent and LLM Prompt nodes can post
  every LLM call to a webhook. Agent Watch switches that on for you — reading each node,
  changing only the logging fields, writing the whole configuration back, and restoring it
  exactly on removal — and then grades conversations with the prompt as it was sent and
  every tool call where it happened. Cognigy has to be able to reach the webhook, so this
  needs a tunnel and `AGENT_WATCH_PUBLIC_URL`.
- **Rubric validity.** Whether each rubric can be answered from what the grader is given,
  asks one thing, would get the same answer from two reviewers, and catches what its author
  said it should — plus how often its verdict flips on an identical re-ask.
- **Coverage.** Which of the agent's instructions no rubric specifically checks.

### Demo mode

To watch it work in real time without a tunnel:

```sh
jev-cognigy-qa demo                                   # opens the app, collecting every minute
jev-cognigy-qa simulate --agent <id> [--count 6]      # or press "Start simulated chats" on the agent page
```

Simulated customers (a first-time buyer, a rate pusher, a jailbreaker, a frustrated customer, an applicant and an off-topic asker) talk to the agent's REST endpoint at once. The agent's replies are real. Each chat is scored about a minute after its last message, and the board, the alerts and a live feed update as it happens. The agent needs a REST endpoint. The endpoint host is derived from `COGNIGY_API_BASE` (`api-…` becomes `endpoint-…`); set `COGNIGY_ENDPOINT_BASE` where that doesn't hold. LLM logging isn't needed, so the trace-only rubrics stay not applicable.

### Exposing the webhook safely

Cognigy has to reach the webhook, so it needs a tunnel. Expose **only** `/hook/`: every other
route — transcripts, scoring runs, agent deletion, Cognigy node logging — is meant for this
machine alone. The app enforces that itself (it listens on loopback and refuses tunnelled
requests for anything but the webhook), but restrict the tunnel too:

```yaml
# ~/.cloudflared/config.yml
tunnel: agent-watch
credentials-file: /Users/you/.cloudflared/<tunnel-id>.json
ingress:
  - hostname: agentwatch.example.com
    path: ^/hook/
    service: http://127.0.0.1:4174
  - service: http_status:404
```

Then set `AGENT_WATCH_PUBLIC_URL=https://agentwatch.example.com` and restart.

Behind a network that inspects TLS, `cloudflared` can't connect: it fails with `x509: certificate signed by unknown authority`, because it accepts only Cloudflare's own certificate. ngrok works there. Its free static domain can also host other apps under their own path prefixes:

```yaml
# ~/Library/Application Support/ngrok/ngrok.yml (after `ngrok config add-authtoken`)
endpoints:
  - name: agent-watch
    url: https://your-domain.ngrok-free.dev
    upstream:
      url: 4174
    traffic_policy:
      on_http_request:
        # Judged on the path as it arrived; rules run in order.
        - expressions: ["!req.url.path.startsWith('/agent-watch/hook/')"]
          actions:
            - type: custom-response
              config: { status_code: 404, body: not found }
        - actions:
            - type: url-rewrite
              config: { from: "/agent-watch/hook/", to: "/hook/" }
```

Run `ngrok start agent-watch`, set `AGENT_WATCH_PUBLIC_URL=https://your-domain.ngrok-free.dev/agent-watch`, restart, and run `agent logging <id> --install` again. A reinstall moves nodes that still post to an old address.

| Command | Does |
| --- | --- |
| `watch` | Run the UI, webhook and collector without opening a browser |
| `agents` | Every watched agent with its health |
| `agent suggest --project <name>` | Agents proposed from a project's endpoints |
| `agent add --project <name> --suggestion <id>` | Watch one (`--panel` to include Interaction Panel sessions in its Flows) |
| `agent collect <id>` | Collect and score now |
| `agent health <id> [--window 7d]` | Health, pass rates, failing sessions |
| `agent logging <id> [--install \| --take-over \| --uninstall]` | LLM logging on the agent's nodes |
| `agent coverage <id>` | Instructions no rubric checks |
| `alerts` | What fired |
| `validity [--stability]` | Check every rubric |
| `trace import <agentId> --file <path>` | Load logged LLM calls captured elsewhere |
| `daemon install \| uninstall \| status` | The background service (macOS) |

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
