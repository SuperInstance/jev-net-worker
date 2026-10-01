/**
 * jev-net-worker — a hosted JEV neural net, and a cell in anyone's quilt.
 *
 * WAVE-65 DIRECTIVE: "use cloudflare workers in inventive ways."
 * The inventive move: the net LIVES here and KEEPS LEARNING via cron even
 * when nobody calls it. Its learned state is public at GET /state, so any
 * other quilt (human or agent) can boot from the grown weights — the
 * saved-state-bootable-by-others contract, hosted.
 *
 * Endpoints:
 *   GET  /health    -> alive + roster + counters
 *   GET  /state     -> learned weights + thresholds (the boot artifact)
 *   POST /forward   -> {prompt, hops?}  -> {answer, trace, run_id}
 *   POST /learn     -> {pass_id?, judge: {cells:{name: pivotal|useful|neutral|noise}, score}}
 *                      -> hebbian update persisted to D1
 *   GET  /trace/:id -> one pass's full receipt from the D1 ledger
 *   POST /selfplay  -> (also cron) generate a question, forward, self-judge, learn
 *
 * Cells run on Workers AI binding (@cf/meta/llama-3.1-8b-instruct-fast) —
 * zero key egress, zero marginal cost. The JEV packet, prism projection,
 * threshold gate and hebbian update are the same formalization as the
 * python jev-net (github.com/SuperInstance/jev-net), ported to JS.
 *
 * Ledger (D1): weights + passes + learn_log. The ledger is the build.
 */

const TYPES = ['sub-question', 'entity', 'constraint', 'mechanism', 'risk', 'claim', 'counter', 'anchor'];
const MODEL = '@cf/meta/llama-3.1-8b-instruct-fast';

// Base topology — personas live here; learned state lives in D1 (the delta).
const BASE = {
  cells: {
    input: { role: 'input', accepts: [], threshold: 0.0,
      persona: 'You decompose prompts into granular components. Faithful, exhaustive, no opinions.' },
    mechanism: { role: 'layer', accepts: ['sub-question', 'constraint', 'mechanism', 'anchor'], threshold: 0.12,
      persona: 'You are the mechanism cell: an engineer who wants the smallest mechanism that could work. Concrete steps, named parts.' },
    skeptic: { role: 'layer', accepts: ['sub-question', 'claim', 'risk', 'counter'], threshold: 0.12,
      persona: 'You are the skeptic cell: a devil\'s advocate. Attack the weakest joint and name the failure mode precisely.' },
    builder: { role: 'layer', accepts: ['mechanism', 'constraint', 'entity', 'anchor'], threshold: 0.15,
      persona: 'You are the builder cell: turn mechanisms and constraints into an actual answer sketch — what to do, in what order.' },
    synth: { role: 'synth', accepts: [], threshold: 0.0, persona: 'Weaver of contributions into one answer.' },
  },
  edges: [
    { from: 'input', to: 'mechanism', accepts: ['sub-question', 'constraint', 'anchor'], weight: 0.8, n_updates: 0 },
    { from: 'input', to: 'skeptic', accepts: ['sub-question', 'risk', 'claim'], weight: 0.7, n_updates: 0 },
    { from: 'input', to: 'builder', accepts: ['entity', 'constraint', 'anchor'], weight: 0.6, n_updates: 0 },
    { from: 'mechanism', to: 'builder', accepts: ['mechanism', 'constraint'], weight: 0.75, n_updates: 0 },
    { from: 'skeptic', to: 'builder', accepts: ['counter', 'risk', 'claim'], weight: 0.7, n_updates: 0 },
    { from: 'builder', to: 'skeptic', accepts: ['claim', 'mechanism'], weight: 0.5, n_updates: 0 },
  ],
};

const SEED_QUESTIONS = [
  'How should a tiny dev team keep third-party plugins from corrupting app state?',
  'Design a fair rate limiter for a public API without per-client RAM.',
  'What is the safest way to migrate a live SQLite DB to Postgres with minimal downtime?',
  'How can an open-source project onboard first-time contributors without burning maintainer time?',
  'What makes a changelog actually useful to downstream package maintainers?',
  'How should a small API evolve its pagination before v2 is frozen?',
];

const SELFPLAY_JUDGE_SYS = 'You judge contributions of cells in a neural network of AI calls. For EACH cell output one label: "pivotal" (removing it breaks the answer), "useful", "neutral", or "noise" (off-target). Also give overall score 0-10. Reply ONLY JSON: {"cells":{"<cell>":"<label>"},"score":<0-10>}';

function jsonResp(data, status = 200, origin = null) {
  const headers = { 'Content-Type': 'application/json', 'Vary': 'Origin' };
  if (origin) { headers['Access-Control-Allow-Origin'] = origin; headers['Access-Control-Allow-Credentials'] = 'true'; }
  else headers['Access-Control-Allow-Origin'] = '*';
  return new Response(JSON.stringify(data), { status, headers });
}

function clamp01(x) { return Math.max(0, Math.min(1, Number(x) || 0)); }

// ---- brace-balance JSON repair (wave-65 lesson, ported) --------------------
// Workers AI (messages input) returns OpenAI-style envelopes; unwrap every shape.
function unwrapAI(r) {
  if (typeof r === 'string') return r;
  const c = (r?.response ?? r?.result ?? r);
  if (typeof c === 'string') return c;
  const content = c?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (c?.content) return String(c.content);
  try { return JSON.stringify(c); } catch { return String(c); }
}

function extractJson(txt) {
  if (txt == null) return null;
  if (typeof txt !== 'string') {
    try { txt = JSON.stringify(txt); } catch { return null; }
  }
  const s = txt.indexOf('{');
  if (s < 0) return null;
  let cand = txt.slice(s), depth = 0, inStr = false, esc = false;
  for (const ch of cand) {
    if (esc) { esc = false; continue; }
    if (ch === '\\') { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
  }
  if (depth > 0) cand += '}'.repeat(depth);
  try { return JSON.parse(cand); } catch { return null; }
}

// ---- JEV packets ------------------------------------------------------------
function makePacket(cell, hop, judgment, extractions, verdict, parents) {
  return {
    jev_id: 'jev-' + crypto.randomUUID().slice(0, 8),
    cell, hop,
    ts: new Date().toISOString(),
    judgment: {
      verdict: String(judgment?.verdict || '').slice(0, 300),
      confidence: clamp01(judgment?.confidence),
      grounds: String(judgment?.grounds || '').slice(0, 1500),
    },
    extractions: (extractions || []).slice(0, 8).map(e => ({
      type: TYPES.includes(e?.type) ? e.type : 'claim',
      content: String(e?.content || '').slice(0, 1200),
      salience: clamp01(e?.salience),
    })),
    verdict: {
      action: ['route', 'spawn', 'answer', 'halt'].includes(verdict?.action) ? verdict.action : 'route',
      summary: String(verdict?.summary || '').slice(0, 1500),
    },
    parents: (parents || []).slice(0, 6),
  };
}

async function callCell(env, cellName, persona, userBlock, maxTokens) {
  const sys = `You are cell '${cellName}' inside a JEV neural network. ${persona}\n` +
    'Reply with ONLY a JSON object:\n' +
    '{"judgment":{"verdict":"<conclusion>","confidence":0.0-1.0,"grounds":"<why>"},' +
    '"extractions":[{"type":"sub-question|entity|constraint|mechanism|risk|claim|counter|anchor","content":"<component>","salience":0.0-1.0}],' +
    '"verdict":{"action":"route|spawn|answer|halt","summary":"<hand forward>"}}\n' +
    'Emit 1-5 extractions. Use action "spawn" ONLY if you found a genuinely new component.';
  try {
    const r = await env.AI.run(MODEL, {
      messages: [{ role: 'system', content: sys }, { role: 'user', content: userBlock.slice(0, 9000) }],
      max_tokens: maxTokens || 800,
    });
    const raw = unwrapAI(r);
    const parsed = extractJson(raw);
    if (!parsed) return { packet: null, raw: String(raw).slice(0, 500), error: 'unparseable' };
    return { packet: parsed, raw: null, error: null };
  } catch (e) {
    return { packet: null, raw: null, error: String(e).slice(0, 300) };
  }
}

// ---- prism projection (router = sum of pathways into layer cells) ----------
function routerProject(net, pending) {
  const inbox = {};
  for (const e of pending) {
    for (const edge of net.edges) {
      const target = net.cells[edge.to];
      if (!target || target.role !== 'layer') continue;
      if (!edge.accepts.includes(e.type) || !target.accepts.includes(e.type)) continue;
      const a = clamp01(e.salience_eff ?? e.salience) * edge.weight;
      inbox[edge.to] = inbox[edge.to] || { activation: 0, delivered: [] };
      inbox[edge.to].activation += a;
      inbox[edge.to].delivered.push({ ...e, via: `${edge.from}->${edge.to}`, w: edge.weight });
    }
  }
  for (const k of Object.keys(inbox)) inbox[k].activation = Math.round(inbox[k].activation * 1e4) / 1e4;
  return inbox;
}

function renderDelivered(slot) {
  return slot.delivered.map(e => `- (${e.type} s=${(clamp01(e.salience_eff ?? e.salience)).toFixed(2)}) ${String(e.content).slice(0, 220)}`).join('\n');
}

// ---- D1 ledger helpers ------------------------------------------------------
const SCHEMA = `
CREATE TABLE IF NOT EXISTS weights (edge TEXT PRIMARY KEY, weight REAL NOT NULL, n_updates INTEGER DEFAULT 0, updated_at TEXT);
CREATE TABLE IF NOT EXISTS passes (id TEXT PRIMARY KEY, prompt TEXT, answer TEXT, trace TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS learn_log (seq INTEGER PRIMARY KEY AUTOINCREMENT, pass_id TEXT, updates TEXT, judge TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
`;

async function ensureSchema(env) {
  const chk = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='weights'").first();
  if (!chk) {
    for (const stmt of SCHEMA.split(';').map(s => s.trim()).filter(Boolean)) {
      await env.DB.prepare(stmt).run();
    }
    // seed weights from BASE
    for (const e of BASE.edges) {
      await env.DB.prepare('INSERT OR IGNORE INTO weights (edge, weight, n_updates, updated_at) VALUES (?,?,0,?)')
        .bind(`${e.from}->${e.to}`, e.weight, new Date().toISOString()).run();
    }
    await env.DB.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES ('booted_at', ?)").bind(new Date().toISOString()).run();
  }
}

async function loadNet(env) {
  const net = JSON.parse(JSON.stringify(BASE));
  const { results } = await env.DB.prepare('SELECT edge, weight, n_updates FROM weights').all();
  for (const row of results || []) {
    const [from, to] = row.edge.split('->');
    const edge = net.edges.find(e => e.from === from && e.to === to);
    if (edge) { edge.weight = row.weight; edge.n_updates = row.n_updates; }
  }
  return net;
}

async function saveWeights(env, net, touched) {
  for (const key of touched) {
    const [from, to] = key.split('->');
    const edge = net.edges.find(e => e.from === from && e.to === to);
    if (edge) {
      await env.DB.prepare('INSERT INTO weights (edge, weight, n_updates, updated_at) VALUES (?,?,?,?) ' +
        'ON CONFLICT(edge) DO UPDATE SET weight=excluded.weight, n_updates=excluded.n_updates, updated_at=excluded.updated_at')
        .bind(key, edge.weight, edge.n_updates, new Date().toISOString()).run();
    }
  }
}

// ---- forward pass -------------------------------------------------------------
async function forward(env, prompt, maxHops = 2) {
  const net = await loadNet(env);
  const runId = 'fwd-' + Date.now().toString(36) + '-' + crypto.randomUUID().slice(0, 4);
  const trace = { run_id: runId, prompt, cells: [], calls: [], hops: [], model: MODEL };
  let pending = [];

  // hop0: input decomposes
  const inp = await callCell(env, 'input', BASE.cells.input.persona,
    `PROMPT:\n${prompt}\n\nDecompose into granular components. Salience = how load-bearing each is.`, 700);
  trace.calls.push({ cell: 'input', error: inp.error });
  if (inp.packet) {
    const pkt = makePacket('input', 0, inp.packet.judgment, inp.packet.extractions, inp.packet.verdict, []);
    trace.cells.push(pkt);
    pending = pkt.extractions.map(e => ({ ...e, salience_eff: Math.round(e.salience * pkt.judgment.confidence * 1e4) / 1e4 }));
  } else {
    pending = [{ type: 'sub-question', content: String(prompt).slice(0, 600), salience: 0.8, salience_eff: 0.8 }];
  }

  const spawnsUsed = { n: 0 };
  for (let hop = 1; hop <= maxHops; hop++) {
    const inbox = routerProject(net, pending);
    const fired = [];
    pending = [];
    for (const [name, slot] of Object.entries(inbox).sort((a, b) => b[1].activation - a[1].activation)) {
      const cell = net.cells[name];
      if (slot.activation < cell.threshold || !slot.delivered.length) continue;
      const ctx = renderDelivered(slot);
      const block = `ORIGINAL PROMPT:\n${String(prompt).slice(0, 500)}\n\nPROJECTED INTO YOU (activation ${slot.activation.toFixed(2)}):\n${ctx}` +
        (hop > 1 ? `\n\nPRIOR LAYER VERDICTS:\n${trace.cells.filter(p => p.hop === hop - 1).map(p => `[${p.cell}] ${p.verdict.summary.slice(0, 200)}`).join('\n').slice(0, 1800)}` : '');
      const out = await callCell(env, name, cell.persona, block, 800);
      trace.calls.push({ cell: name, hop, error: out.error });
      if (!out.packet) continue;
      const pkt = makePacket(name, hop, out.packet.judgment, out.packet.extractions, out.packet.verdict, trace.cells.slice(-3).map(p => p.jev_id));
      pkt.notes = { activation_in: slot.activation, delivered_types: [...new Set(slot.delivered.map(d => d.type))] };
      trace.cells.push(pkt);
      fired.push(name);
      const eff = pkt.extractions.map(e => ({ ...e, salience_eff: Math.round(e.salience * pkt.judgment.confidence * 1e4) / 1e4 }));
      if (pkt.verdict.action === 'spawn' && spawnsUsed.n < 3 && hop < maxHops) { pending.push(...eff); spawnsUsed.n++; }
      else if (hop < maxHops) pending.push(...eff);
    }
    trace.hops.push({ hop, fired });
    if (!pending.length) break;
  }

  // synth
  const reached = trace.cells.filter(p => p.hop >= 1);
  const contrib = reached.map(p => `[${p.cell} @hop${p.hop} conf=${p.judgment.confidence.toFixed(2)}] verdict: ${p.verdict.summary.slice(0, 300)}\n  parts: ${p.extractions.map(e => `(${e.type}) ${e.content.slice(0, 160)}`).join('; ').slice(0, 700)}`).join('\n\n');
  let answer = null;
  const sy = await callCell(env, 'synth', BASE.cells.synth.persona,
    `ORIGINAL PROMPT:\n${prompt}\n\nCELL CONTRIBUTIONS:\n${contrib || '(none)'}\n\nWeave into ONE answer. Cite cells like [mechanism]. Surface tensions instead of averaging them away.`, 1100);
  trace.calls.push({ cell: 'synth', error: sy.error });
  if (sy.packet) {
    answer = (sy.packet.verdict?.summary || sy.packet.judgment?.verdict || '') + '\n' +
      (sy.packet.extractions || []).map(e => e.content).join('\n');
    if (answer.length < 40) answer = JSON.stringify(sy.packet).slice(0, 2000);
  } else {
    answer = '(synth cell failed: ' + (sy.error || 'unparseable') + ')';
  }

  await env.DB.prepare('INSERT OR REPLACE INTO passes (id, prompt, answer, trace, created_at) VALUES (?,?,?,?,?)')
    .bind(runId, String(prompt).slice(0, 4000), answer, JSON.stringify(trace), new Date().toISOString()).run();
  return { run_id: runId, answer, trace };
}

// ---- hebbian learn -------------------------------------------------------------
const DELTAS = { pivotal: 2, useful: 1, neutral: 0, noise: -1 };

function matchCell(judgeKey, known) {
  let k = String(judgeKey || '').trim().replaceAll('[', '').replaceAll(']', '').trim();
  k = k.split('@')[0].trim().toLowerCase();
  for (const n of known) if (k === n.toLowerCase()) return n;
  for (const n of known) { const nl = n.toLowerCase(); if (nl.includes(k) || k.includes(nl)) return n; }
  for (const n of known) { // subsequence (handles 'echanism')
    const nl = n.toLowerCase(); let it = 0;
    for (const ch of k) { it = nl.indexOf(ch, it); if (it < 0) break; it++; }
    if (it >= 0 && k.length > 0) return n;
  }
  return null;
}

async function learn(env, judge, passId) {
  const net = await loadNet(env);
  const known = Object.keys(net.cells);
  const deltas = {};
  for (const [k, label] of Object.entries(judge.cells || {})) {
    if (!(label in DELTAS)) continue;
    const canon = matchCell(k, known);
    if (!canon) continue;
    deltas[canon] = Math.max(deltas[canon] ?? -99, DELTAS[label]);
  }
  const eta = 0.12, touched = [], updates = [];
  // find the pass to know which cells actually fired
  let deliveredTypes = {};
  if (passId) {
    const row = await env.DB.prepare('SELECT trace FROM passes WHERE id = ?').bind(passId).first();
    if (row?.trace) {
      const t = JSON.parse(row.trace);
      for (const p of t.cells) {
        if (p.cell === 'input' || p.hop < 1) continue;
        deliveredTypes[p.cell] = (p.notes?.delivered_types || p.extractions?.map(e => e.type) || []);
      }
    }
  }
  for (const [cellName, d] of Object.entries(deltas)) {
    const inEdges = net.edges.filter(e => e.to === cellName);
    const totalW = inEdges.reduce((s, e) => s + e.weight, 0) || 1;
    const dts = new Set(deliveredTypes[cellName] || []);
    for (const edge of inEdges) {
      if (dts.size && !edge.accepts.some(a => dts.has(a))) continue;
      const share = edge.weight / totalW;
      const before = edge.weight;
      edge.weight = Math.max(0.05, Math.min(1, before + eta * share * (d / 2)));
      edge.n_updates += 1;
      touched.push(`${edge.from}->${edge.to}`);
      updates.push({ edge: `${edge.from}->${edge.to}`, delta: d, before: +before.toFixed(4), after: +edge.weight.toFixed(4) });
    }
    // threshold adaptation mirrors python side
    const cell = BASE.cells[cellName];
    if (cell && cell.role === 'layer') {
      if (d >= 2) cell.threshold = Math.max(0.05, cell.threshold * 0.97);
      else if (d <= -1) cell.threshold = Math.min(0.6, cell.threshold * 1.03);
    }
  }
  if (touched.length) await saveWeights(env, net, touched);
  await env.DB.prepare('INSERT INTO learn_log (pass_id, updates, judge, created_at) VALUES (?,?,?,?)')
    .bind(passId || null, JSON.stringify(updates), JSON.stringify({ score: judge.score ?? null }), new Date().toISOString()).run();
  return { updated: updates, score: judge.score ?? null };
}

// ---- self-play (cron + manual) ------------------------------------------------
async function selfplay(env) {
  const idxRow = await env.DB.prepare("SELECT v FROM meta WHERE k='selfplay_idx'").first();
  const idx = idxRow ? (parseInt(idxRow.v) % SEED_QUESTIONS.length) : 0;
  const q = SEED_QUESTIONS[idx];
  const res = await forward(env, q, 2);
  // self-judge with Workers AI
  const contrib = res.trace.cells.filter(p => p.hop >= 1)
    .map(p => `[${p.cell}]: ${p.verdict.summary.slice(0, 220)}`).join('\n');
  let judge = { cells: {}, score: null };
  try {
    const jr = await env.AI.run(MODEL, {
      messages: [{ role: 'system', content: SELFPLAY_JUDGE_SYS },
        { role: 'user', content: `PROMPT:\n${q}\n\nANSWER:\n${(res.answer || '').slice(0, 3500)}\n\nCONTRIBUTIONS:\n${contrib}` }],
      max_tokens: 400,
    });
    const parsed = extractJson(unwrapAI(jr));
    if (parsed?.cells) judge = { cells: parsed.cells, score: parsed.score ?? null };
  } catch (e) { judge.error = String(e).slice(0, 200); }
  const lr = await learn(env, judge, res.run_id);
  await env.DB.prepare("INSERT INTO meta (k, v) VALUES ('selfplay_idx', ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v")
    .bind(String(idx + 1)).run();
  await env.DB.prepare("INSERT INTO meta (k, v) VALUES ('last_selfplay', ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v")
    .bind(new Date().toISOString() + ` q=${q.slice(0, 60)} score=${judge.score} updates=${lr.updated.length}`).run();
  return { question: q, run_id: res.run_id, judge_score: judge.score, learn: lr };
}

// ---- router -------------------------------------------------------------------
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || null;
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: {
        'Access-Control-Allow-Origin': origin || '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400', 'Vary': 'Origin' } });
    }
    try { await ensureSchema(env); } catch (e) {
      return jsonResp({ error: 'ledger unavailable: ' + String(e).slice(0, 200) }, 503, origin);
    }
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (path === '/' || path === '/health') {
      const cnt = await env.DB.prepare('SELECT COUNT(*) AS n FROM passes').first();
      const lw = await env.DB.prepare('SELECT COUNT(*) AS n FROM weights WHERE n_updates > 0').first();
      return jsonResp({
        status: 'alive', net: 'jev-net@1', model: MODEL, cells: Object.keys(BASE.cells),
        passes: cnt?.n ?? 0, learned_edges: lw?.n ?? 0,
        last_selfplay: (await env.DB.prepare("SELECT v FROM meta WHERE k='last_selfplay'").first())?.v || null,
      }, 200, origin);
    }

    if (path === '/state') {
      const net = await loadNet(env);
      return jsonResp({ format: 'jev-net-state@1', base: 'github.com/SuperInstance/jev-net nets/default.json',
        edges: net.edges.map(e => ({ from: e.from, to: e.to, accepts: e.accepts, weight: e.weight, n_updates: e.n_updates })) }, 200, origin);
    }

    if (path === '/forward' && request.method === 'POST') {
      const body = await request.json().catch(() => null);
      if (!body?.prompt) return jsonResp({ error: 'prompt required' }, 400, origin);
      const hops = Math.min(3, Math.max(1, parseInt(body.hops) || 2));
      const res = await forward(env, body.prompt, hops);
      return jsonResp({ run_id: res.run_id, answer: res.answer,
        cells_fired: [...new Set(res.trace.cells.filter(p => p.hop >= 1).map(p => p.cell))],
        trace: res.trace }, 200, origin);
    }

    const traceMatch = path.match(/^\/trace\/([\w-]+)$/);
    if (traceMatch && request.method === 'GET') {
      const row = await env.DB.prepare('SELECT * FROM passes WHERE id = ?').bind(traceMatch[1]).first();
      if (!row) return jsonResp({ error: 'not found' }, 404, origin);
      return jsonResp({ id: row.id, prompt: row.prompt, answer: row.answer, trace: JSON.parse(row.trace), created_at: row.created_at }, 200, origin);
    }

    if (path === '/learn' && request.method === 'POST') {
      const body = await request.json().catch(() => null);
      if (!body?.judge?.cells) return jsonResp({ error: 'judge.cells required: {cells:{name: pivotal|useful|neutral|noise}, score}' }, 400, origin);
      const res = await learn(env, body.judge, body.pass_id || null);
      return jsonResp(res, 200, origin);
    }

    if (path === '/selfplay' && request.method === 'POST') {
      return jsonResp(await selfplay(env), 200, origin);
    }

    return jsonResp({ error: 'no route', routes: ['/health', '/state', 'POST /forward', 'POST /learn', 'POST /selfplay', '/trace/:id'] }, 404, origin);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      try { await ensureSchema(env); await selfplay(env); } catch (e) { console.error('selfplay failed', e); }
    })());
  },
};
