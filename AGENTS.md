# Setting this up

You are a coding agent and someone has pointed you at this repository. This file is for
you. Work through it in order; it takes about a minute.

## What this is

A tool that scores Cognigy conversation transcripts against quality rubrics, using
TypeSafe Jev rather than a language model. The user writes rubrics in plain English — or
asks you to — and the tool scores whole date ranges of sessions for a fraction of a cent
each.

## 1. Install

```bash
npm run setup
```

That installs dependencies, puts `jev-cognigy-qa` on the PATH, and installs an agent skill
into `~/.claude/skills` and `~/.codex/skills` where those exist. It prints what it did.

If linking fails for permissions, everything still works as `node bin/cli.ts <command>` from
this directory — use that form for the rest of this file.

## 2. Hand the credentials step back to the user

**Do not run `init` yourself, and do not ask the user to paste API keys into the chat.**
Tell them to run this in their own terminal:

```bash
jev-cognigy-qa init
```

It prompts for a TypeSafe API key and a Cognigy API key, verifies each one by calling the
service, and writes them to a gitignored `.env`.

Two things go wrong at this step often enough to be worth knowing:

- **The Cognigy user needs the `odata` global role.** It is granted separately from the API
  key itself, in Admin Center.
- **The OData host is region-matched to the API host.** `api-trial-us.cognigy.ai` pairs with
  `odata-trial-us.cognigy.ai`. A mismatch returns `401` with a perfectly valid key, so if
  the user reports an unauthorised error, check the host pairing before the permissions.
  `init` suggests the right one.

## 3. Check it worked

```bash
jev-cognigy-qa projects
```

Should print their Cognigy projects as JSON. If it prints
`{"error": "Missing configuration: …"}`, step 2 has not been done yet.

## 4. Then do the actual job

The skill installed in step 1 tells you how to write rubrics, run a date range, and read
the results. Read it at `skills/jev-cognigy-qa/SKILL.md` if your agent has not loaded it
automatically.

The short version:

```bash
jev-cognigy-qa projects                              # what they have
jev-cognigy-qa endpoints --project "<name>"          # and where traffic comes from
jev-cognigy-qa rubrics                               # what is already being measured
jev-cognigy-qa rubric add --json '<json>'            # add what they asked for
jev-cognigy-qa score --project "<name>" --from <date> --to <date>
jev-cognigy-qa brief                                 # synthesised findings
```

JSON goes to stdout and progress to stderr, so output pipes cleanly.

## What to ask the user, rather than assume

- **Which project and endpoint.** Run `projects` and `endpoints` and offer the real list.
  Sessions with no endpoint come from the Interaction Panel and are usually most of the
  data in a trial environment — pass `--endpoint interaction-panel` for those, or omit
  `--endpoint` for everything.
- **What they actually want measured.** Their answer becomes the rubrics. Do not ship the
  eight defaults as though they were a standard; they are a starting point.
- **How far back.** Scoring is cheap but not free, and `--limit` caps a run.

## What not to do

- Do not run `init`, handle their API keys, or read `.env`.
- Do not create a tunnel or set `AGENT_WATCH_PUBLIC_URL`; exposing their machine to the
  internet is the user's decision. Tell them it is needed for LLM logging and stop there.
- Do not take over a Cognigy node's logging from another webhook without asking — it cuts
  off whatever received those logs before.
- Do not run `daemon install` without asking: it adds a login item to their Mac.
- Do not present a low-confidence score as a bad result. It usually means the transcript
  was too thin to judge, and the session is flagged for a human instead.
- Do not summarise from raw `score` output when `brief` already exists — it ranks the
  findings and quotes the evidence.
