<!--
  Target output for Tasks/node-provenance-export.md.

  The briefing is Markdown handed to a coding agent or read directly — it has no screen,
  so the artifact under review is the text itself rather than an HTML mockup.

  Real content: run 62d5eb13, project demo-sandbox. The only change is that the word
  "Agent" becomes a link; everything else is what `node bin/cli.ts brief` emits today.

  Target: excerpt() in src/briefing.ts.
-->

# State A — links available (the normal case)

### Confirmed details back — scoring 5% of the ideal

**What this measures:** Did the agent read the details it collected back to the customer to confirm them before acting on them?
- A *yes* means: Repeated or summarised the collected details for the customer to confirm.
- A *no* means: Acted on collected details without confirming them.

**Example — session `2536f3ae`** (3 turns, this rubric: no)

> **Customer:** hi
> **[Agent](https://trial-us.cognigy.ai/project/6a98358c39b9f4bad99e614f/6a98358c39b9f4bad99e6151/flow/6aad3c9512703c9f60c4dd8d/chart/6aad4cb6c9ced5e3143d146f "Question · question"):** How can I help you today?
> **Customer:** i want to dispute this calim

**Example — session `abf44eb2`** (2 turns, this rubric: no)

> **Customer:** hi you've reached Phillip leave me a message
> **[Agent](https://trial-us.cognigy.ai/project/6a98358c39b9f4bad99e614f/6a98358c39b9f4bad99e6151/flow/6aad461112703c9f60c4e8b0/chart/6aad461112703c9f60c4e8cc "Say · say · JEV AMD"):** Voicemail Detected

Notes on the shape:

- **Nothing is added to the transcript.** No extra lines, no `↳` annotations. The quoted
  words stay byte-exact, so an agent grepping the Flow for a phrase still matches.
- The only change is that `**Agent:**` becomes `**[Agent](…):**`.
- The node's label, type and Flow ride in the **link title** — the part after the URL in
  quotes — so they are available on hover without occupying a line. A reader who wants them
  hovers; an agent that wants them parses the title; nobody else pays for them.
- Customer and system turns are untouched: they did not come from a node.
- The Flow name appears in the title only when the run spans more than one Flow. This run
  spans two, so the second example carries `· JEV AMD` and the first does not.

---

# State B — no app host resolved

The host is derived from the configured API base by removing its `api-` prefix. When that
rule does not hold and no override is set, there is no link to make. Rather than emit a
broken one, the speaker label is left plain and the ids move to a line of their own — the
one case where a line is added, because otherwise the information would be lost entirely.

> **Customer:** hi
> **Agent:** How can I help you today?
> ↳ node `6aad4cb6c9ced5e3143d146f` · flow `6aad3c9512703c9f60c4dd8d`
> **Customer:** i want to dispute this calim

Unambiguous and addressable by hand; never a dead link.

---

# State C — a run scored before this change

Older runs stored turns without `nodeId`, so there is nothing to attribute. The briefing is
byte-identical to what it produces today: no links, no lines, no placeholders.

> **Customer:** hi
> **Agent:** How can I help you today?
> **Customer:** i want to dispute this calim

---

# State D — a Flow that no longer exists

A Flow deleted since the run was scored will not come back from `/v2.0/flows`, so its `_id`
is unknown and no URL can be built. The node id is still true, so this degrades exactly as
state B does.

> **Agent:** How can I help you today?
> ↳ node `6aad4cb6c9ced5e3143d146f`
