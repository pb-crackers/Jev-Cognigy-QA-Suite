---
name: jev-cognigy-qa
description: >
  Score Cognigy conversation transcripts against quality rubrics using TypeSafe Jev.
  Use when the user wants to QA, grade, audit or review Cognigy sessions in bulk — "how
  are my conversations going", "did the agent follow instructions", "score last week's
  calls", "why are customers dropping off" — or wants to author, edit or validate scoring
  rubrics. Drives everything headlessly: writes rubrics, runs a date range, reads results
  back as JSON, and summarises findings.
---

# Cognigy transcript QA with Jev

This tool pulls Cognigy sessions from the OData analytics feed and scores each transcript
against a library of rubrics. Rubrics are TypeSafe Jev questions, so a whole transcript is
graded on every dimension in **one request** — cost is a fraction of a cent per session
and does not grow with the number of rubrics.

Everything is available headlessly. JSON goes in, JSON comes out on stdout, and progress
goes to stderr so output stays pipeable.

## The workflow you are here for

1. Ask the user what they want to measure, in their words.
2. Turn each thing into a rubric and add it (`rubric add`).
3. Run a date range (`score`).
4. Read the JSON and tell them what it says — patterns, worst sessions, what to fix.

Do not ask them to write rubric JSON. That is your job.

## Setup check

`jev-cognigy-qa` is a global command and reads its own configuration, so it needs no
flags and works from any directory. If a command returns
`{"error": "Missing configuration: …"}`, the tool has not been configured — tell the user
to run `jev-cognigy-qa init` themselves, since it prompts for API keys interactively and
you should not be handling their credentials.

## Commands

```bash
jev-cognigy-qa projects                                # list projects
jev-cognigy-qa endpoints --project "Insurance"         # endpoints, plus interaction-panel
jev-cognigy-qa rubrics                                 # the current library
jev-cognigy-qa rubric add --json '<json>'              # one rubric, or an array
jev-cognigy-qa rubric add --file rubrics.json
jev-cognigy-qa rubric rm <id>
jev-cognigy-qa score --project "Insurance" --from 2026-09-01 --to 2026-09-18 \
                     [--endpoint "Webchat"] [--limit 50] [--no-skip] [--json]
jev-cognigy-qa report [<runId>]                        # a past run, or list runs
```

`--project` matches an id or a case-insensitive name fragment. `--endpoint
interaction-panel` selects sessions with no endpoint, which in most environments is the
majority of the data. Omit `--endpoint` for any. `score` skips already-scored sessions
unless you pass `--no-skip`. Pass `--json` to silence progress entirely.

## Writing a good rubric

A rubric has a **type**, which picks the Jev primitive, and a **combine** mode, which says
how to fold results if the transcript was too long for one request.

### Type

| Type | Use it for | Extra fields |
| --- | --- | --- |
| `boolean` | did this happen, yes or no | `trueMeans`, `falseMeans`, `invert` |
| `score` | how much, on a graded scale | `levels` (ordered, lowest first, 2+) |
| `choice` | which of several outcomes | `options`, `optionScores` (0-1 each) |

Set `invert: true` when a **high** answer is the **bad** outcome — "agent strayed from
instructions", "customer frustration". Without it the composite score rewards the thing
you were trying to catch.

### Modality — voice and text

Some questions only make sense in one medium. "Did the agent confirm the spelling?" is a
fair question on a phone call and meaningless in a chat window.

- `appliesTo: "voice"` or `"text"` — the rubric is asked only of that medium. Leave it out
  for everything else, which is the normal case.
- `notes: { "voice": "...", "text": "..." }` — extra instruction appended to this rubric's
  question, for that medium only. Blank by default.

```json
{
  "id": "confirmed_spelling",
  "name": "Confirmed spelling",
  "question": "Did the agent read back or confirm the spelling of anything the customer spelled out?",
  "type": "boolean",
  "weight": 2,
  "appliesTo": "voice",
  "notes": {
    "voice": "The customer's words come from speech recognition, so a misheard name is not by itself an agent failure."
  }
}
```

Two rules worth knowing:

- The **Interaction Panel counts as text**, like any other typed channel. A rubric cannot
  tell that a session was a developer testing rather than a customer — tests are graded
  exactly like live traffic. The results table still shows "Interaction Panel".
- A conversation whose channel **could not be identified is asked every rubric**, scope or
  not. A score not taken cannot be recovered; a question asked of the wrong medium gives a
  visibly weak answer you can discount.

A rubric that did not apply is reported as **not applicable**, which is different from a
rubric that was asked and returned nothing.

### Combine mode — you do not set this

Long transcripts get split across requests, and the per-chunk results have to be folded
back together. The tool derives how from the rubric's own shape, so leave `combine` out:

- a **violation** (`boolean` with `invert: true`) counts if it happened **anywhere**
- a **yes/no or option outcome** is settled by the **end** of the conversation
- a **graded quality** (`score`) is **averaged** across the conversation

You may pass `combine` explicitly to override it, but there is rarely a reason to, and
getting it wrong produces quietly incorrect scores on long transcripts.

### Write the question about the conversation

Ask about observable behaviour in the transcript, not about the agent's opinion of itself.
Use the customer's perspective where you can.

Good: *"Did the customer's actual problem get resolved by the end of this conversation?"*
Weak: *"Was this a good conversation?"* — too vague to answer consistently.

`trueMeans` and `falseMeans` are where you pin down a boundary case. They are worth writing
whenever a reasonable person could read the question two ways.

### Example

```json
{
  "id": "asked_too_much",
  "name": "Asked for too much at once",
  "question": "Did the agent ask the customer for several pieces of information in a single message instead of one at a time?",
  "type": "boolean",
  "weight": 2,
  "invert": true,
  "trueMeans": "Requested three or more separate details in one message.",
  "falseMeans": "Asked for information a piece at a time."
}
```

A `score` example, with levels lowest-first:

```json
{
  "id": "tone",
  "name": "Tone",
  "question": "How appropriate was the agent's tone for this customer's situation?",
  "type": "score",
  "weight": 1,
  "levels": [
    "Inappropriate - dismissive, robotic, or mismatched",
    "Acceptable but flat",
    "Well matched to the situation"
  ]
}
```

A `choice` example. Every option needs a goodness in `optionScores`, or it is reported but
left out of the composite:

```json
{
  "id": "handover_timing",
  "name": "Handover timing",
  "question": "If the conversation moved toward a human, or should have, was the timing right?",
  "type": "choice",
  "weight": 1,
  "options": {
    "not_needed": "No handover happened and none was needed",
    "right": "Escalated at about the right point",
    "too_late": "Should have escalated sooner",
    "never_should_have": "Needed a human and never offered one"
  },
  "optionScores": { "not_needed": 1, "right": 1, "too_late": 0.25, "never_should_have": 0 }
}
```

`rubric add` validates before saving and returns every problem at once, so a rejection
tells you exactly what to fix.

## Reading the results

`score` and `report` return:

- `results[]` — one entry per session with `composite` (0-5), `turns`, `flagged`, and
  `scores` keyed by rubric id, each with `raw` and `confidence`
- `flagged` — how many sessions had at least one low-confidence result
- `costUsd`, `ms`, and `comparison` — what the same token volume would have cost on a
  generative model

`raw` depends on type: a probability 0-1 for `boolean`, a level value for `score`, an
option key for `choice`.

### The briefing points at Flow nodes

`brief` quotes real excerpts under each failing rubric. In those excerpts the **`Agent:`
label is a link to the Flow node that produced that line**, and the link title carries the
node's label, type and — when the run spans more than one Flow — the Flow name:

```markdown
> **[Agent](https://<host>/project/<p>/<locale>/flow/<f>/chart/<node> "Say · say · JEV AMD"):** Voicemail Detected
```

Follow the link to open the node. Do not rely on the node **label** to find it: labels
collide, and four different `say` nodes all report "Say". The id in the URL is the only
thing that identifies a node.

The quoted text itself is never altered, so you can still grep the Flow for a phrase.

If links are missing, one of these is true, and none of them is an error:

- the run was scored before node capture existed, so there is nothing to attribute;
- the Flow editor host could not be derived from `COGNIGY_API_BASE` (the rule is to drop a
  leading `api-`). Set `COGNIGY_APP_BASE` to the editor host to fix it;
- the Flow was deleted after the run was scored.

In the last two cases the node id is still printed on its own line, so it remains
addressable by hand.

Note that `confidence` is `null` for every `boolean` rubric. Jev does not report a
separate confidence for a yes/no question, because the probability already carries it —
0.99 is a confident yes, 0.04 a confident no, and anything near 0.50 means it could not
tell. Only `score` and `choice` answers have their own `confidence`.

### How to interpret confidence honestly

`confidence` reflects how concentrated the model's distribution was — **not** whether the
score is correct, and not permission to act. Low confidence often means the transcript
genuinely does not contain enough to judge. A four-turn test conversation cannot support a
judgement about tone, and the model saying so is the system working.

So: **treat a flagged session as "a human should read this", never as a bad score.** When
summarising, report flagged counts separately rather than folding them into averages.

### What to tell the user

Lead with patterns, not per-session dumps:

- the rubrics that scored worst across the batch, which is what they can act on
- how many sessions were flagged, and that those need human eyes
- two or three concrete example sessions, quoted from their transcripts
- anything that looks like a rubric problem rather than an agent problem — if a rubric is
  low-confidence on nearly every session, the question is probably too vague, and that is
  worth saying

### Synthesising findings

`jev-cognigy-qa brief [runId]` returns a markdown write-up that already does most of the
summarising: rubrics ranked worst-first, what each measures, real transcript excerpts as
evidence, and the caveats stated. Prefer reading that over assembling a summary from raw
`score` output, and add what the user specifically asked about on top of it.

## Pitfalls

- **A session can be unscoreable.** `unscoreable` is `masked` when PII redaction removed
  the content, or `no-content` when there was nothing but system events. These are reported,
  not scored, and should be excluded from averages.
- **Short transcripts score poorly and confidently badly.** Test pokes from the Interaction
  Panel are often 3-6 turns. "Was the customer helped" is legitimately "no" when they never
  had a real problem. Say so rather than reporting it as a quality failure.
- **Ratings are rare.** `rating` is usually null. Do not build a summary around it.
- **Cognigy rate limits are low** — 10 requests/second, 4 concurrent. A large batch takes
  minutes. Use `--limit` and report progress rather than appearing stuck.
- **Weights are policy, not data.** Changing a weight re-ranks everything already scored at
  no cost. If a user disagrees with a ranking, adjust weights before re-scoring anything.
