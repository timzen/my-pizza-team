# Models and failover

Which model each teammate and the assistant runs, and what happens when that model is
being throttled or failing. MPT never picks a model on its own: model ids are whatever
your harness reports it can use (for Pi, `<provider>/<model>`), and the harness checks
each one when asked to switch.

## Which model an agent runs

For each run, the first of these that applies wins:

1. **A [pin](glossary.md#pin)** — a model you chose for that one teammate or the
   assistant.
2. **The persona's model** — a persona that names a model (usually an
   [alias](#aliases) such as `strong` or `fast`) uses it for the work items it runs.
3. **The [team default model](glossary.md#team-default-model)** — Config → Models.
4. **The harness's own default.**

While a [failover](glossary.md#failover) is in effect, whichever of those is a model
that's failing is replaced by the team's fallback; the rest are left alone.

A switch always happens between runs, never in the middle of one.

## Picking a model

- **A teammate:** the **model chip** in the header of its page (`/teammates/:id`).
  Pick a model to pin it; **Clear pin** goes back to the persona's model or the
  default. See [Choosing its model](03-teammates.md#choosing-its-model).
- **The assistant:** the **Model** picker beside its persona on
  [Config → General → Assistant](08-configuration.md#the-assistant).
- **Everyone:** the **Default Model** on Config → Models, with **Apply to all
  teammates now** for the ones already running (pinned agents keep their pin). See
  [Models](08-configuration.md#models).

A harness that can't switch models shows "not supported by this harness" there.

## Aliases

Personas name a *kind* of model — `strong`, `fast` — and **Model Aliases** on
Config → Models map each name to a model id per harness. Change the mapping once and
every persona that names it follows. An alias can also be an entry in the failover
chain. See [Model aliases](06-personas.md#model-aliases).

## The failover policy

Throttling is usually per account (or per capacity pool), so failover switches **the
whole team** at once, not one teammate. You set it up in the **Failover** card on
Config → Models — it's off until you turn it on:

- a **chain** of models, your usual one (the **primary**) first — pick fallbacks
  served from a different capacity pool or provider, or they'll be throttled together;
- which failures count (throttled and server errors; credentials and context-window
  errors never switch models);
- how many failures, within how many minutes, switch the team;
- how long to wait before one work item (the **probe**) tries the primary again — if
  it works, everyone switches back on their own.

The fields and their defaults are in [Failover](08-configuration.md#failover).

## What you'll see

- **The Team tab** shows a small banner while a failover is in effect —
  "Failover: *primary* → *fallback* since *time* (*throttle*)" — linking to
  Config → Models, with **End now** to switch everyone back at once. Nothing changes on
  the teammates' rows; a teammate's own page shows an amber **failover** mark on its
  model chip while it runs the fallback.
- **On your phone** the Team tab has the same line at the top (ending it is the full
  UI's).
- **The thread** of a work item retried on the fallback gets one comment:
  `[failover] retried on <fallback> after <kind> on <model>`. When the probe works, its
  thread says the team is back on the primary.
- **The Inbox** gets one note per failover episode — not one per teammate — with a
  line when it started, each time it moved further down the chain, if the chain ran
  out, and when it ended. A new line marks it unread again; it counts toward the
  Inbox badge like an unread run. **Mark read** clears it.
- **`mpt status`** prints a `Failover: …` line while one is in effect.
- Each failed attempt's `[retry]` comment names its [error kind](glossary.md#error-kind).
