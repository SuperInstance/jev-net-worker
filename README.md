# jev-net-worker

**A hosted JEV neural net that keeps learning while nobody calls it — and a
cell in anyone's quilt.**

Live: https://jev-net-worker.casey-digennaro.workers.dev

This is the Cloudflare incarnation of [jev-net](https://github.com/SuperInstance/jev-net)
(same formalization: JEV packets as activation carriers, prism projection as
synaptic transfer, hebbian weights). The inventive move: the net LIVES on the
edge, learns from every call, and self-plays nightly — its learned state is
public so any other quilt can boot from the grown weights.

## The two contexts (drop-into-cell contract)

**Standalone** — the worker is a complete micro-net: input → mechanism/skeptic
/builder layers with threshold gates → synthesis. Every cell runs on Workers AI
(`@cf/meta/llama-3.1-8b-instruct-fast`): zero key egress, zero marginal cost.
The D1 ledger stores weights + every pass's JEV transcript. A cron trigger
self-plays nightly: generate question → forward → self-judge → hebbian update.

**As a cell in YOUR quilt** — wire the HTTP surface like any other cell:

| Port | Call | Feeds your cell with |
|------|------|---------------------|
| ask  | `POST /forward {"prompt", "hops"}` | `{run_id, answer, cells_fired, trace}` — the trace IS a JEV transcript: per-cell judgment/extractions/verdict with parent links |
| read | `GET /trace/:run_id` | the full receipt from the ledger |
| boot | `GET /state` | `jev-net-state@1` learned weight delta — boot your local copy of jev-net from it (`graph.load_with_state`) |
| teach| `POST /learn {"pass_id", "judge": {"cells": {...}, "score"}}` | your judge's labels update the hosted weights (hebbian, share ∝ weight) |

Inputs it drinks: any prompt string. Outputs it emits: a cited answer plus a
parent-linked JEV DAG — downstream cells can consume individual extractions.

## API

```
GET  /health    alive + roster + pass count + last selfplay
GET  /state     learned weights (the boot artifact, jev-net-state@1)
POST /forward   {"prompt": "...", "hops": 1-3}  -> answer + JEV trace
GET  /trace/:id one pass's full receipt
POST /learn     {"pass_id", "judge":{"cells":{"<cell>":"pivotal|useful|neutral|noise"},"score"}}
POST /selfplay  one round of: generate question -> forward -> self-judge -> learn
```

## The learned-state boot contract

`/state` returns ONLY the delta (weights, thresholds, update counts). Personas
and topology stay in the base repo. This is deliberate: state travels, the
definition of the net stays canonical. `default.json + state.json == the grown
net, anywhere` — the saved-state-bootable-by-others shape.

## Wave-65 receipts (things that broke and how they're fixed)

1. Workers AI `messages` input returns an OpenAI-style envelope
   (`choices[0].message.content`), not a string — `unwrapAI()` handles every
   observed shape (string / envelope / result).
2. `extractJson` must accept non-strings (envelope objects) — coerce or fail.
3. Input cell occasionally unparseable → fail-open bootstrap (the prompt
   itself becomes a 0.8-salience sub-question) — the pass continues, receipted.
4. Credentialed CORS (wave-64 lesson): explicit origin echo + credentials +
   `Vary: Origin` on every JSON response.

## Ledger schema (D1)

- `weights(edge, weight, n_updates, updated_at)` — the learned delta
- `passes(id, prompt, answer, trace, created_at)` — JEV transcripts
- `learn_log(seq, pass_id, updates, judge, created_at)` — every learning event
- `meta(k, v)` — selfplay index + last heartbeat

The ledger is the build.
