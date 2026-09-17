#!/usr/bin/env node
/**
 * compare.mjs — deep per-session token/cost analysis for Claude Code sessions,
 * including their subagents, with multi-session comparison.
 *
 * Usage:
 *   node compare.mjs <session-name-or-uuid-prefix> [...more] [--json] [--dir <projects-dir>] [-o <out.html>]
 *
 * Sessions are matched by custom title substring (the name you gave the session
 * in Claude Code) or by UUID prefix. Ambiguous matches are reported as an error.
 *
 * Output: a self-contained HTML report (default: ./session-compare-<stamp>.html
 * in the cwd) or full JSON on stdout with --json.
 *
 * Transcript facts this relies on (see ~/.claude/projects):
 *  - Main transcript: <project>/<sessionId>.jsonl. Session titles appear as
 *    {"type":"custom-title","customTitle":...} lines (normally line 1).
 *  - One API response is split into multiple type:"assistant" entries sharing
 *    requestId; only the last carries final output_tokens — dedupe by requestId
 *    keeping max output.
 *  - usage.cache_creation = {ephemeral_1h_input_tokens, ephemeral_5m_input_tokens}
 *    lets us price 1h cache writes (2x) separately from 5m (1.25x).
 *  - Compaction: {"type":"system","subtype":"compact_boundary","compactMetadata":
 *    {trigger, preTokens, postTokens, durationMs}}.
 *  - Subagents: <project>/<sessionId>/subagents/agent-*.jsonl with sibling
 *    *.meta.json {agentType, description, toolUseId, spawnDepth}. toolUseId links
 *    the subagent to the parent turn's Agent tool_use block.
 *  - Workflow agents: <project>/<sessionId>/workflows/.../*.jsonl (typed 'workflow').
 */

import fs from 'fs'
import os from 'os'
import path from 'path'
import readline from 'readline'
import { fileURLToPath } from 'url'

// ---------------------------------------------------------------------------
// Pricing (USD per MTok). Cache write 5m = 1.25x input, 1h = 2x input,
// cache read = 0.1x input. Source: Anthropic pricing, cached 2026-09-17.
// ---------------------------------------------------------------------------
const PRICING = {
  'claude-fable-5': { in: 10, out: 50 },
  'claude-mythos-5': { in: 10, out: 50 },
  'claude-opus-4-8': { in: 5, out: 25 },
  'claude-opus-4-7': { in: 5, out: 25 },
  'claude-opus-4-6': { in: 5, out: 25 },
  'claude-opus-4-5': { in: 5, out: 25 },
  'claude-opus-4-1': { in: 15, out: 75 },
  'claude-sonnet-5': { in: 3, out: 15 },
  'claude-sonnet-4-6': { in: 3, out: 15 },
  'claude-sonnet-4-5': { in: 3, out: 15 },
  'claude-haiku-4-5': { in: 1, out: 5 },
}
function priceFor(model) {
  if (!model) return null
  if (PRICING[model]) return PRICING[model]
  // tolerate dated suffixes like claude-haiku-4-5-20251001
  for (const key of Object.keys(PRICING)) {
    if (model.startsWith(key)) return PRICING[key]
  }
  return null
}
// cost of one usage record, in USD; returns {usd, unknown} where unknown=true
// when the model has no known price (tokens still counted, usd=0)
function costOf(model, u) {
  const p = priceFor(model)
  if (!p) return { usd: 0, unknown: true }
  const M = 1e6
  const usd =
    (u.inputUncached * p.in +
      u.cacheWrite5m * p.in * 1.25 +
      u.cacheWrite1h * p.in * 2 +
      u.cacheRead * p.in * 0.1 +
      u.output * p.out) /
    M
  return { usd, unknown: false }
}

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2)
const names = []
let ROOT = path.join(os.homedir(), '.claude', 'projects')
let AS_JSON = false
let OUT = null
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === '--json') AS_JSON = true
  else if (a === '--dir') ROOT = argv[++i]
  else if (a === '-o' || a === '--out') OUT = argv[++i]
  else if (a === '-h' || a === '--help') {
    console.log(
      'Usage: node compare.mjs <session-name-or-uuid-prefix> [...more] [--json] [--dir <projects-dir>] [-o out.html]',
    )
    process.exit(0)
  } else names.push(a)
}
if (names.length === 0) {
  console.error('error: give at least one session name (custom title substring) or UUID prefix')
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Session resolution: scan <project>/<uuid>.jsonl heads for custom titles
// ---------------------------------------------------------------------------
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

function listCandidates() {
  const out = [] // {project, sessionId, file, titles:[], mtime}
  let projects
  try {
    projects = fs.readdirSync(ROOT, { withFileTypes: true })
  } catch {
    console.error(`error: cannot read ${ROOT}`)
    process.exit(1)
  }
  for (const proj of projects) {
    if (!proj.isDirectory()) continue
    const pdir = path.join(ROOT, proj.name)
    let ents
    try {
      ents = fs.readdirSync(pdir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of ents) {
      if (!e.isFile() || !e.name.endsWith('.jsonl')) continue
      const sessionId = path.basename(e.name, '.jsonl')
      if (!UUID_RE.test(sessionId)) continue
      const file = path.join(pdir, e.name)
      const titles = readTitles(file)
      let mtime = 0
      try {
        mtime = fs.statSync(file).mtimeMs
      } catch {}
      out.push({ project: proj.name, sessionId, file, titles, mtime })
    }
  }
  return out
}

// read the first 64KB and extract customTitle values (titles are normally on line 1)
function readTitles(file) {
  let fd
  try {
    fd = fs.openSync(file, 'r')
  } catch {
    return []
  }
  const buf = Buffer.alloc(65536)
  const n = fs.readSync(fd, buf, 0, buf.length, 0)
  fs.closeSync(fd)
  const head = buf.toString('utf8', 0, n)
  const titles = []
  const re = /"customTitle":"((?:[^"\\]|\\.)*)"/g
  let m
  while ((m = re.exec(head))) {
    try {
      titles.push(JSON.parse('"' + m[1] + '"'))
    } catch {
      titles.push(m[1])
    }
  }
  return [...new Set(titles)]
}

function resolveSessions(queries) {
  const candidates = listCandidates()
  const resolved = []
  for (const q of queries) {
    const ql = q.toLowerCase()
    let matches = candidates.filter(c => c.titles.some(t => t.toLowerCase().includes(ql)))
    if (matches.length === 0) {
      matches = candidates.filter(c => c.sessionId.startsWith(ql))
    }
    if (matches.length === 0) {
      console.error(`error: no session matches "${q}" (by title substring or UUID prefix) under ${ROOT}`)
      process.exit(1)
    }
    if (matches.length > 1) {
      console.error(`error: "${q}" is ambiguous — ${matches.length} sessions match:`)
      for (const m of matches.sort((a, b) => b.mtime - a.mtime)) {
        console.error(
          `  ${m.sessionId.slice(0, 8)}  ${new Date(m.mtime).toISOString().slice(0, 16)}  ${m.project}  [${m.titles.join(', ') || 'untitled'}]`,
        )
      }
      console.error('use a longer title fragment or a UUID prefix')
      process.exit(1)
    }
    if (resolved.some(r => r.sessionId === matches[0].sessionId)) {
      console.error(`error: "${q}" resolves to a session already selected (${matches[0].sessionId.slice(0, 8)})`)
      process.exit(1)
    }
    resolved.push({ ...matches[0], query: q })
  }
  return resolved
}

// ---------------------------------------------------------------------------
// Transcript parsing
// ---------------------------------------------------------------------------
const IDLE_GAP_MS = 5 * 60 * 1000

function newUsage() {
  return { inputUncached: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 0 }
}
function addUsage(dst, u) {
  dst.inputUncached += u.inputUncached
  dst.cacheWrite5m += u.cacheWrite5m
  dst.cacheWrite1h += u.cacheWrite1h
  dst.cacheRead += u.cacheRead
  dst.output += u.output
}
function usageFromApi(usage) {
  const cc = usage.cache_creation || null
  const ccTotal = usage.cache_creation_input_tokens || 0
  let w1h = 0
  let w5m = ccTotal
  if (cc) {
    w1h = cc.ephemeral_1h_input_tokens || 0
    w5m = cc.ephemeral_5m_input_tokens || 0
    // guard against drift between the split and the total
    if (w1h + w5m !== ccTotal) w5m = Math.max(0, ccTotal - w1h)
  }
  return {
    inputUncached: usage.input_tokens || 0,
    cacheWrite5m: w5m,
    cacheWrite1h: w1h,
    cacheRead: usage.cache_read_input_tokens || 0,
    output: usage.output_tokens || 0,
  }
}
function usageTotal(u) {
  return u.inputUncached + u.cacheWrite5m + u.cacheWrite1h + u.cacheRead + u.output
}

// Parse one .jsonl transcript file (main or subagent). Returns:
// { calls: [{ts, model, u, promptKey, toolCalls}], turns, toolUseToPrompt,
//   compacts, firstTs, lastTs, activeMs }
async function parseTranscript(file, opts) {
  const { isMain, seenUuids, seenRequestIds, inheritedPrompt } = opts
  const rl = readline.createInterface({
    input: fs.createReadStream(file, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  })

  const fileApiCalls = new Map() // requestKey -> {usage, ts, model, prompt, toolUses:[names]}
  const turns = [] // {key, ts, text}
  const toolUseToPrompt = new Map() // tool_use id (Agent/Task) -> {promptKey, subagentType, desc}
  const compacts = []
  const modelSeen = new Map() // model -> count
  let firstTs = null
  let lastTs = null
  let prevTs = null
  let activeMs = 0
  let currentPrompt = inheritedPrompt || null

  for await (const line of rl) {
    if (!line) continue
    let e
    try {
      e = JSON.parse(line)
    } catch {
      continue
    }
    if (e.uuid) {
      if (seenUuids.has(e.uuid)) continue
      seenUuids.add(e.uuid)
    }
    if (e.timestamp) {
      const ts = Date.parse(e.timestamp)
      if (!isNaN(ts)) {
        if (firstTs === null) firstTs = ts
        if (prevTs !== null) {
          const gap = ts - prevTs
          if (gap > 0 && gap < IDLE_GAP_MS) activeMs += gap
        }
        prevTs = ts
        lastTs = ts
      }
    }

    if (e.type === 'system' && e.subtype === 'compact_boundary') {
      const md = e.compactMetadata || {}
      compacts.push({
        ts: e.timestamp ? Date.parse(e.timestamp) : lastTs,
        trigger: md.trigger || 'unknown',
        preTokens: md.preTokens || 0,
        postTokens: md.postTokens || 0,
        durationMs: md.durationMs || 0,
      })
      continue
    }

    if (e.type === 'user') {
      if (e.isMeta || e.isCompactSummary) continue
      const content = e.message && e.message.content
      let text = null
      let isToolResult = false
      if (typeof content === 'string') text = content
      else if (Array.isArray(content)) {
        const first = content[0]
        if (first && first.type === 'tool_result') isToolResult = true
        else if (first && first.type === 'text') text = first.text || ''
      }
      if (isToolResult) continue
      if (text) {
        if (
          text.startsWith('<task-notification') ||
          text.startsWith('<scheduled-wakeup') ||
          text.startsWith('<background-task') ||
          text.startsWith('[Request interrupted')
        )
          continue
      }
      if (isMain && !e.isSidechain) {
        const key = e.uuid || `${file}:${e.timestamp}`
        turns.push({
          key,
          ts: e.timestamp ? Date.parse(e.timestamp) : lastTs,
          text: promptPreview(text),
        })
        currentPrompt = key
      }
      continue
    }

    if (e.type === 'assistant') {
      const msg = e.message || {}
      const usage = msg.usage
      const toolUses = []
      if (Array.isArray(msg.content)) {
        for (const c of msg.content) {
          if (c && c.type === 'tool_use') {
            toolUses.push(c.name)
            if ((c.name === 'Agent' || c.name === 'Task' || c.name === 'Workflow') && c.id) {
              toolUseToPrompt.set(c.id, {
                promptKey: currentPrompt,
                subagentType: c.input && c.input.subagent_type ? String(c.input.subagent_type) : null,
                desc: c.input && c.input.description ? String(c.input.description) : null,
              })
            }
          }
        }
      }
      if (!usage) continue
      const key =
        e.requestId ||
        (msg.id && String(msg.id).startsWith('msg_') ? msg.id : null) ||
        `${file}:${e.uuid || ''}`
      const prev = fileApiCalls.get(key)
      if (!prev || (usage.output_tokens || 0) >= (prev.rawOutput || 0)) {
        const rec = prev || {
          ts: e.timestamp ? Date.parse(e.timestamp) : lastTs,
          model: msg.model || null,
          prompt: currentPrompt,
          toolUses: [],
        }
        rec.usage = usage
        rec.rawOutput = usage.output_tokens || 0
        rec.model = msg.model || rec.model
        fileApiCalls.set(key, rec)
      }
      // tool uses accumulate across the split assistant entries of one response
      const rec = fileApiCalls.get(key)
      if (rec) rec.toolUses.push(...toolUses)
      if (msg.model && msg.model !== '<synthetic>') modelSeen.set(msg.model, (modelSeen.get(msg.model) || 0) + 1)
      continue
    }
  }

  const calls = []
  for (const [key, rec] of fileApiCalls) {
    if (seenRequestIds.has(key)) continue
    seenRequestIds.add(key)
    if (usageTotal(usageFromApi(rec.usage)) === 0) continue // synthetic/zero-usage records
    calls.push({
      ts: rec.ts,
      model: rec.model,
      u: usageFromApi(rec.usage),
      promptKey: rec.prompt,
      toolCalls: rec.toolUses.length,
    })
  }
  calls.sort((a, b) => a.ts - b.ts)

  return { calls, turns, toolUseToPrompt, compacts, modelSeen, firstTs, lastTs, activeMs }
}

function promptPreview(text) {
  if (!text) return '(non-text)'
  const cmd = /<command-name>\/?([^<]+)<\/command-name>/.exec(text)
  if (cmd) return `/${cmd[1].trim()}`
  const t = text
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return t.length > 160 ? t.slice(0, 157) + '…' : t
}

// discover subagent transcript files for a session
function findSubagentFiles(projectDir, sessionId) {
  const out = [] // {file, agentId, meta}
  const subDir = path.join(projectDir, sessionId, 'subagents')
  try {
    for (const name of fs.readdirSync(subDir)) {
      if (!name.endsWith('.jsonl')) continue
      const file = path.join(subDir, name)
      const agentId = path.basename(name, '.jsonl').replace(/^agent-/, '')
      let meta = null
      try {
        meta = JSON.parse(fs.readFileSync(file.replace(/\.jsonl$/, '.meta.json'), 'utf8'))
      } catch {}
      out.push({ file, agentId, meta, kind: 'subagent' })
    }
  } catch {}
  // workflow transcripts
  const wfDir = path.join(projectDir, sessionId, 'workflows')
  try {
    const walk = dir => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name)
        if (e.isDirectory()) walk(p)
        else if (e.isFile() && e.name.endsWith('.jsonl') && !e.name.startsWith('journal'))
          out.push({ file: p, agentId: path.basename(p, '.jsonl'), meta: { agentType: 'workflow' }, kind: 'workflow' })
      }
    }
    walk(wfDir)
  } catch {}
  return out
}

// ---------------------------------------------------------------------------
// Analyze one session (main + subagents)
// ---------------------------------------------------------------------------
async function analyzeSession(cand) {
  const seenUuids = new Set()
  const seenRequestIds = new Set()
  const projectDir = path.dirname(cand.file)

  const main = await parseTranscript(cand.file, { isMain: true, seenUuids, seenRequestIds })

  const subFiles = findSubagentFiles(projectDir, cand.sessionId)
  // parse parents before children (spawn order by file birthtime)
  subFiles.sort((a, b) => {
    try {
      return fs.statSync(a.file).birthtimeMs - fs.statSync(b.file).birthtimeMs
    } catch {
      return 0
    }
  })

  const subagents = []
  for (const sf of subFiles) {
    const link = sf.meta && sf.meta.toolUseId ? main.toolUseToPrompt.get(sf.meta.toolUseId) : null
    const parsed = await parseTranscript(sf.file, {
      isMain: false,
      seenUuids,
      seenRequestIds,
      inheritedPrompt: link ? link.promptKey : null,
    })
    if (parsed.calls.length === 0 && parsed.firstTs === null) continue

    const u = newUsage()
    let cost = 0
    let unknownTokens = 0
    let toolCalls = 0
    const series = []
    let cum = 0
    for (const c of parsed.calls) {
      addUsage(u, c.u)
      const { usd, unknown } = costOf(c.model, c.u)
      cost += usd
      if (unknown) unknownTokens += usageTotal(c.u)
      toolCalls += c.toolCalls
      cum += usd
      series.push({
        t: c.ts,
        ctx: c.u.inputUncached + c.u.cacheWrite5m + c.u.cacheWrite1h + c.u.cacheRead,
        cost: cum,
      })
    }
    // first line of the subagent's prompt (first human-ish message in its file)
    const firstPrompt = await readFirstSubagentPrompt(sf.file)
    subagents.push({
      agent_id: sf.agentId,
      type:
        (sf.meta && sf.meta.agentType) ||
        (link && link.subagentType) ||
        (sf.kind === 'workflow' ? 'workflow' : 'fork'),
      description: (sf.meta && sf.meta.description) || (link && link.desc) || null,
      parent_prompt_key: link ? link.promptKey : null,
      ts_start: parsed.firstTs,
      ts_end: parsed.lastTs,
      duration_ms: parsed.firstTs !== null ? parsed.lastTs - parsed.firstTs : 0,
      api_calls: parsed.calls.length,
      tool_calls: toolCalls,
      tokens: u,
      cost_usd: cost,
      unknown_model_tokens: unknownTokens,
      prompt_preview: firstPrompt,
      compacts: parsed.compacts,
      series,
    })
  }

  // --- main-session turn table ---
  const turnByKey = new Map()
  const turnList = main.turns.map((t, i) => {
    const rec = {
      idx: i + 1,
      ts: t.ts,
      text: t.text,
      api_calls: 0,
      tool_calls: 0,
      subagent_count: 0,
      tokens: newUsage(),
      cost_usd: 0, // incl. subagents
      cost_main_usd: 0,
      last_call_ts: t.ts,
      context_end: 0,
    }
    turnByKey.set(t.key, rec)
    return rec
  })

  const mainUsage = newUsage()
  let mainCost = 0
  let unknownTokens = 0
  let mainToolCalls = 0
  const series = []
  let cum = 0
  for (const c of main.calls) {
    addUsage(mainUsage, c.u)
    const { usd, unknown } = costOf(c.model, c.u)
    mainCost += usd
    if (unknown) unknownTokens += usageTotal(c.u)
    mainToolCalls += c.toolCalls
    cum += usd
    const ctx = c.u.inputUncached + c.u.cacheWrite5m + c.u.cacheWrite1h + c.u.cacheRead
    series.push({ t: c.ts, ctx, cost: cum })
    const turn = c.promptKey ? turnByKey.get(c.promptKey) : null
    if (turn) {
      turn.api_calls++
      turn.tool_calls += c.toolCalls
      addUsage(turn.tokens, c.u)
      turn.cost_main_usd += usd
      turn.cost_usd += usd
      if (c.ts > turn.last_call_ts) turn.last_call_ts = c.ts
      turn.context_end = ctx
    }
  }
  // roll subagent costs into their parent turn
  for (const sa of subagents) {
    const turn = sa.parent_prompt_key ? turnByKey.get(sa.parent_prompt_key) : null
    if (turn) {
      turn.subagent_count++
      turn.cost_usd += sa.cost_usd
      sa.parent_turn = turn.idx
      if (sa.ts_end && sa.ts_end > turn.last_call_ts) turn.last_call_ts = sa.ts_end
    }
  }
  for (const t of turnList) t.duration_ms = Math.max(0, t.last_call_ts - t.ts)

  // events for the chart
  const events = []
  for (const cp of main.compacts)
    events.push({ t: cp.ts, type: 'compact', trigger: cp.trigger, pre: cp.preTokens, post: cp.postTokens })
  for (const sa of subagents)
    if (sa.ts_start) events.push({ t: sa.ts_start, type: 'spawn', agent: sa.type, desc: sa.description })
  // model changes along the main call series
  let prevModel = null
  for (const c of main.calls) {
    if (c.model && c.model !== '<synthetic>' && c.model !== prevModel) {
      if (prevModel !== null) events.push({ t: c.ts, type: 'model', from: prevModel, to: c.model })
      prevModel = c.model
    }
  }
  events.sort((a, b) => a.t - b.t)

  const subUsage = newUsage()
  let subCost = 0
  let subUnknown = 0
  for (const sa of subagents) {
    addUsage(subUsage, sa.tokens)
    subCost += sa.cost_usd
    subUnknown += sa.unknown_model_tokens
  }

  const totalUsage = newUsage()
  addUsage(totalUsage, mainUsage)
  addUsage(totalUsage, subUsage)
  const totalCost = mainCost + subCost

  // span across main + subagents
  let firstTs = main.firstTs
  let lastTs = main.lastTs
  for (const sa of subagents) {
    if (sa.ts_start && (firstTs === null || sa.ts_start < firstTs)) firstTs = sa.ts_start
    if (sa.ts_end && (lastTs === null || sa.ts_end > lastTs)) lastTs = sa.ts_end
  }

  const models = [...main.modelSeen.entries()].sort((a, b) => b[1] - a[1]).map(([m]) => m)

  // sort subagents by cost desc; keep series only for top 3
  subagents.sort((a, b) => b.cost_usd - a.cost_usd)
  subagents.forEach((sa, i) => {
    if (i >= 3) delete sa.series
  })

  const inTotal =
    totalUsage.inputUncached + totalUsage.cacheWrite5m + totalUsage.cacheWrite1h + totalUsage.cacheRead

  return {
    session_id: cand.sessionId,
    title: cand.titles[cand.titles.length - 1] || null,
    query: cand.query,
    project: cand.project,
    models,
    span: firstTs !== null ? { from: new Date(firstTs).toISOString(), to: new Date(lastTs).toISOString() } : null,
    start_ts: firstTs,
    wall_ms: firstTs !== null ? lastTs - firstTs : 0,
    active_ms: main.activeMs,
    totals: {
      api_calls: main.calls.length + subagents.reduce((n, s) => n + s.api_calls, 0),
      tool_calls: mainToolCalls + subagents.reduce((n, s) => n + s.tool_calls, 0),
      human_turns: turnList.length,
      tokens: totalUsage,
      tokens_total: usageTotal(totalUsage),
      pct_cache_read: inTotal > 0 ? +((100 * totalUsage.cacheRead) / inTotal).toFixed(1) : 0,
      cost_usd: totalCost,
      unknown_model_tokens: unknownTokens + subUnknown,
    },
    main: {
      api_calls: main.calls.length,
      tool_calls: mainToolCalls,
      tokens: mainUsage,
      cost_usd: mainCost,
    },
    subagent_totals: {
      count: subagents.length,
      api_calls: subagents.reduce((n, s) => n + s.api_calls, 0),
      tokens: subUsage,
      cost_usd: subCost,
      pct_of_cost: totalCost > 0 ? +((100 * subCost) / totalCost).toFixed(1) : 0,
    },
    compacts: main.compacts,
    events,
    turns: turnList,
    series,
    subagents,
  }
}

async function readFirstSubagentPrompt(file) {
  const rl = readline.createInterface({
    input: fs.createReadStream(file, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  })
  let result = null
  for await (const line of rl) {
    if (!line) continue
    let e
    try {
      e = JSON.parse(line)
    } catch {
      continue
    }
    if (e.type === 'user' && !e.isMeta && e.message) {
      const content = e.message.content
      let text = null
      if (typeof content === 'string') text = content
      else if (Array.isArray(content) && content[0] && content[0].type === 'text') text = content[0].text
      if (text) {
        result = promptPreview(text)
        break
      }
    }
  }
  rl.close()
  return result
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const resolved = resolveSessions(names)
  const sessions = []
  for (const cand of resolved) {
    process.stderr.write(`analyzing ${cand.titles[0] || cand.sessionId.slice(0, 8)}…\n`)
    sessions.push(await analyzeSession(cand))
  }

  const report = {
    generated_at: new Date().toISOString(),
    root: ROOT,
    pricing_per_mtok: PRICING,
    cache_multipliers: { write_5m: 1.25, write_1h: 2, read: 0.1 },
    sessions,
  }

  if (AS_JSON) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n')
    return
  }

  const here = path.dirname(fileURLToPath(import.meta.url))
  const template = fs.readFileSync(path.join(here, 'report-template.html'), 'utf8')
  const html = template.replace(
    '<script id="report-data" type="application/json">{}</script>',
    `<script id="report-data" type="application/json">${JSON.stringify(report).replace(/</g, '\\u003c')}</script>`,
  )
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '').replace(/^(\d{8})/, '$1-')
  const outPath = OUT || path.join(process.cwd(), `session-compare-${stamp}.html`)
  fs.writeFileSync(outPath, html)
  console.log(outPath)
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
