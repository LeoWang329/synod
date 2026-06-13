// synod/src/session-manager.mjs — Session collection + event wiring.
//
// Encapsulates: session open/close/enqueue/list, per-session line buffers,
// send queues, and event wiring (delta → feed, error → stderr, status → flush).
// Injected via createSessionManager({ openBackend, stdout, stderr, report, cwd, defaults, onIdle, errorLeadingNewline }).

import { enabled, color, labelColor } from "./ui/ansi.mjs";
import { turnBoundary } from "./ui/decorations.mjs";
import { renderSessionsTable } from "./ui/sessions-table.mjs";

// ── Line buffer ───────────────────────────────────────────────────────
function createLineBuffer(label, stdout = process.stdout, { colorize } = {}) {
  const prefix = colorize ? colorize(`[${label}]`) : `[${label}]`;
  let buf = "";
  return {
    feed(chunk) {
      buf += chunk;
      const lines = buf.split("\n");
      buf = /** @type {string} */ (lines.pop());
      for (const line of lines) {
        stdout.write(`${prefix} ${line}\n`);
      }
    },
    flush() {
      if (buf.length > 0) {
        stdout.write(`${prefix} ${buf}\n`);
        buf = "";
      }
    },
  };
}

// ── Output multiplexer (label-once ↔ per-line prefix) ─────────────────
//
// createLineBuffer above prefixes EVERY line with `[label]` — including blank
// lines.  In a multi-agent context that is essential: it both attributes each
// line to its session AND, by emitting whole `[label] ...\n` units atomically,
// keeps two sessions' content from interleaving on one physical line (the
// "no cross-talk" invariant A2/A6 acceptance assert).  But in the common
// single-agent REPL it is pure noise — the label has nothing to disambiguate
// and repeats on every line.
//
// The mux picks the rendering by how many sessions are OPEN (not by streaming
// timing — that keeps the mode stable across a turn and immune to whether two
// agents happen to stream at the same instant):
//   - 1 open session  → SOLO: print `[label]` once at the turn's start, then
//     stream the body verbatim (the model's own newlines preserved), no
//     per-line prefix.  Deltas are written the instant they arrive, so sub-line
//     fragments still accumulate live on one physical line.
//   - ≥2 open sessions → SHARED: identical to createLineBuffer — every line
//     prefixed, whole-line-atomic, so concurrent sessions stay attributable
//     and never interleave mid-line.
//
// Opening a 2nd session switches everyone to SHARED; we close any dangling solo
// line first so the next prefixed line starts clean.
function createOutputMux(stdout) {
  const channels = new Set();
  const isSolo = () => channels.size <= 1;

  function closeOpenLine(ch) {
    if (ch.lineOpen) { stdout.write("\n"); ch.lineOpen = false; }
  }

  // SOLO: header once per turn, then body verbatim.  Leading newlines of the
  // very first content are trimmed so there is no blank gap under the header.
  function writeSolo(ch, chunk) {
    let s = chunk;
    if (ch.trimLeading) {
      s = s.replace(/^\n+/, "");
      if (s !== "") ch.trimLeading = false;
    }
    if (s === "") return;
    if (!ch.headerWritten) { stdout.write(`${ch.prefix}\n`); ch.headerWritten = true; }
    stdout.write(s);
    ch.lineOpen = !s.endsWith("\n");
  }

  // SHARED: buffer to "\n", emit whole prefixed lines (no interleave).
  function writeShared(ch, chunk) {
    closeOpenLine(ch);                       // close a stray solo line first
    ch.pending += chunk;
    const lines = ch.pending.split("\n");
    ch.pending = lines.pop();
    for (const line of lines) stdout.write(`${ch.prefix} ${line}\n`);
  }

  function flushChannel(ch) {
    closeOpenLine(ch);
    if (ch.pending.length > 0) { stdout.write(`${ch.prefix} ${ch.pending}\n`); ch.pending = ""; }
  }

  return {
    register(label, { colorize } = {}) {
      const prefix = colorize ? colorize(`[${label}]`) : `[${label}]`;
      const ch = { prefix, pending: "", lineOpen: false, headerWritten: false, trimLeading: true };
      channels.add(ch);
      // 1→2 sessions: switch to SHARED; close any dangling solo line so the
      // first prefixed line of the new regime starts clean.
      if (channels.size >= 2) for (const c of channels) closeOpenLine(c);
      return {
        feed(chunk) { (isSolo() ? writeSolo : writeShared)(ch, chunk); },
        flush() { flushChannel(ch); },
        /** Turn start: reset per-turn SOLO state (fresh header + leading trim). */
        startTurn() { ch.headerWritten = false; ch.trimLeading = true; },
        /** Turn end: flush trailing content / close the open body line. */
        endTurn() { flushChannel(ch); },
        /** Permanent removal (session closed). */
        dispose() { flushChannel(ch); channels.delete(ch); },
      };
    },
    get _sessionCount() { return channels.size; },
  };
}

// ── Send queue ────────────────────────────────────────────────────────
function createSendQueue(session, label, onTurnComplete) {
  let chain = Promise.resolve();
  let _enqueued = 0;
  return {
    enqueue(msg) {
      _enqueued++;
      const task = chain.then(() => session.send(msg, { wait: true }));
      chain = task.catch(() => {});
      if (onTurnComplete) {
        task.then((result) => onTurnComplete(label, result), () => {});
      }
      return task;
    },
    drain() { return chain; },
    /** Number of enqueue() calls — used by drainAll for quiescence detection. */
    get enqueuedCount() { return _enqueued; },
  };
}

/** No session / No current session 错误的「下一步」建议行(§3.3)。 */
export const NO_SESSION_HINT = "  hint: /sessions 查看活跃会话;/open 新开一个\n";

// ── Doctor gate ──────────────────────────────────────────────────────
function checkAgentAvailable(agent, report, stderr = process.stderr) {
  const entry = report[agent];
  if (!entry) {
    stderr.write(
      `synod: unknown agent "${agent}". Available: ${Object.keys(report).join(", ") || "(none)"}.\n`,
    );
    return false;
  }
  if (entry.available) return true;
  const hint = agent === "omp" ? "OMP_BIN" : agent === "codex" ? "CODEX_BIN" : null;
  stderr.write(
    [
      `synod: agent "${agent}" is not available.`,
      hint
        ? `  - probed: ${process.env[hint] || agent}\n  - install it, or point ${hint} at the real binary.`
        : `  - the backend's doctor() probe failed; check its bin/config in synod.config.mjs.`,
      "",
    ].join("\n"),
  );
  return false;
}

// ── Backend opener ────────────────────────────────────────────────────
async function openSession({ agent, model, effort, write, mesh, systemPrompt, cwd, report, openBackend, stderr }) {
  if (!checkAgentAvailable(agent, report, stderr)) return null;
  try {
    return await openBackend({ agent, cwd, write, model, effort, mesh, systemPrompt });
  } catch (err) {
    stderr.write(`synod: failed to open ${agent} session: ${err.message}\n`);
    return null;
  }
}

// ── Session manager factory ───────────────────────────────────────────

/**
 * @param {object} opts
 * @param {Function} opts.openBackend — injected backend opener (e.g. realOpenBackend or FakeSession factory)
 * @param {NodeJS.WriteStream} opts.stdout — for line-buffer output
 * @param {NodeJS.WriteStream} opts.stderr — for error output
 * @param {object} opts.report — doctor() availability report
 * @param {string} opts.cwd — working directory
 * @param {{ model?: string, effort?: string, write?: boolean }} opts.defaults — base CLI options
 * @param {(label: string) => void} opts.onIdle — called when a session goes idle (after flush)
 * @param {(label: string, result: object) => void} [opts.onTurnComplete] — called when a turn completes successfully (with the send result)
 * @param {boolean} [opts.errorLeadingNewline] — if true, prefix error lines with "\n" (interactive); default false (runTasks)
 */
function createSessionManager({ openBackend, stdout, stderr, report, cwd, defaults, onIdle, onTurnComplete, errorLeadingNewline = false, relays, env = process.env }) {
  const _sessions = new Map(); // label → { session, agent, model, effort, lineBuf, sendQueue }
  let _currentLabel = null;
  let _pendingOpens = 0;

  const _defaults = { model: undefined, effort: undefined, write: false, mesh: false, ...defaults };
  const _onIdle = onIdle || (() => {});
  const _onTurnComplete = onTurnComplete || null;
  const _nl = errorLeadingNewline ? "\n" : "";
  const _relays = relays || (() => []);
  // Shared output mux: per-session channels coordinate typewriter vs
  // line-atomic so single-session streaming is live, multi-session stays
  // cross-talk-free (see createOutputMux).
  const _mux = createOutputMux(stdout);

  // ── Label allocation (per-instance counters) ────────────────────────
  const agentCounters = { omp: 0, codex: 0 };

  function allocLabel(agent) {
    agentCounters[agent] = (agentCounters[agent] || 0) + 1;
    return `${agent}#${agentCounters[agent]}`;
  }

  /**
   * Open a new session with full event wiring.
   *
   * @param {object} opts
   * @param {string} opts.agent
   * @param {string} [opts.model]
   * @param {string} [opts.effort]
   * @param {boolean} [opts.write]
   * @param {"interactive"|"task"|false} [opts.announce]
   *   - "interactive": stdout Opening + stdout Opened (interactive /open path)
   *   - "task":         stderr Opening only, no Opened (runTasks path)
   *   - false:          silent (default session)
   * @returns {Promise<string|null>} label on success, null on failure
   */
  async function open({ agent, model, effort, write, mesh, systemPrompt, announce = false, setCurrent = true }) {
    const m = model ?? _defaults.model;
    const e = effort ?? _defaults.effort;
    const w = write ?? _defaults.write;
    const me = mesh ?? _defaults.mesh;

    if (!checkAgentAvailable(agent, report, stderr)) return null;

    // P2-37: guard 读的是 sessionLoad(= _sessions.size + 在飞 open 数)。这里同步 +1,
    // 使后续并发 fence /open 的 guardOpen 立刻看到本次占用,关掉 check-then-act 窗口。
    _pendingOpens += 1;
    try {
      const label = allocLabel(agent);
      if (announce === "task") {
        stderr.write(`Opening ${label} (${agent})...\n`);
      } else if (announce === "interactive") {
        stdout.write(`Opening ${label} (${agent})...\n`);
      }

      const session = await openSession({
        agent, model: m, effort: e, write: w, mesh: me, systemPrompt,
        cwd, report, openBackend, stderr,
      });
      if (!session) return null;

      const useColor = enabled(stdout, env);
      const colorize = useColor ? (s) => color(labelColor(label), s) : null;
      const lineBuf = _mux.register(label, { colorize });
      session.on("delta", (chunk) => lineBuf.feed(chunk));
      session.on("error", (err) => {
        stderr.write(`${_nl}[${label} error] ${err.message}\n`);
      });
      let _turnStartAt = null;
      session.on("status", ({ status }) => {
        if (status === "running") {
          _turnStartAt = Date.now();
          lineBuf.startTurn();
        } else if (status === "idle") {
          lineBuf.endTurn();
          if (useColor && _turnStartAt != null) {
            const secs = ((Date.now() - _turnStartAt) / 1000).toFixed(1);
            stdout.write(turnBoundary(label, secs));
            _turnStartAt = null;
          }
          _onIdle(label);
        }
      });

      // Capture each completed turn's text so /forward can replay it on
      // demand, then delegate to the real onTurnComplete (relay + control).
      const captureAndForward = (lbl, result) => {
        const inf = _sessions.get(lbl);
        if (inf) inf.lastTurnText = result?.text ?? "";
        if (_onTurnComplete) _onTurnComplete(lbl, result);
      };

      _sessions.set(label, {
        session, agent, model: m, effort: e, lineBuf, lastTurnText: "",
        sendQueue: createSendQueue(session, label, captureAndForward),
      });
      if (setCurrent) _currentLabel = label;

      if (announce === "interactive") {
        stdout.write(`Opened ${label} (${agent})\n`);
      }
      return label;
    } finally {
      _pendingOpens -= 1;
    }
  }

  /**
   * Route a message to one or all sessions.
   * @param {{ target?: string, msg: string }} opts
   *   - target === "all": broadcast to every session
   *   - target is a label: send to that session
   *   - target is undefined: send to current session
   * @returns {Promise|boolean} the enqueue promise (for single-target), true for @all, false on error
   */
  function enqueue({ target, msg }) {
    if (target === "all") {
      for (const [label, info] of _sessions) {
        info.sendQueue.enqueue(msg).catch((err) => {
          stderr.write(`${_nl}[${label} send error] ${err.message}\n`);
        });
      }
      return true;
    }

    const info = target ? _sessions.get(target) : _sessions.get(_currentLabel);
    if (!info) {
      stderr.write(
        (target ? `No session "${target}"\n` : "No current session. Use /open to create one.\n") + NO_SESSION_HINT,
      );
      return false;
    }

    const p = info.sendQueue.enqueue(msg);
    p.catch((err) => {
      stderr.write(`${_nl}[${target || _currentLabel} send error] ${err.message}\n`);
    });
    return p;
  }

  /** Switch current session. Returns true on success. */
  function use(target) {
    if (_sessions.has(target)) {
      _currentLabel = target;
      return true;
    }
    stderr.write(`No session "${target}"\n${NO_SESSION_HINT}`);
    return false;
  }

  /** Write the sessions table to stdout (§4: * current + RELAY column). */
  function list() {
    const rows = [];
    for (const [label, info] of _sessions) {
      const sum = info.session.summary();
      rows.push({ label, agent: sum.agent, model: sum.model, status: sum.status, turns: sum.turnCount });
    }
    stdout.write(renderSessionsTable({
      sessions: rows,
      currentLabel: _currentLabel,
      relays: _relays(),
      colorOn: enabled(stdout, env),
    }));
  }

  /** Drain all send queues to quiescence — loops until no new turns were
   *  enqueued during the drain pass (handles relay cascades).
   *  Throws if cascade exceeds _sessions.size + 1 passes (runaway detection). */
  async function drainAll() {
    const maxPasses = _sessions.size + 1;
    for (let pass = 0; pass < maxPasses; pass++) {
      // Snapshot current enqueuedCount for every session
      const counts = new Map();
      for (const [label, info] of _sessions) {
        counts.set(label, info.sendQueue.enqueuedCount);
      }

      // Drain each session's current chain
      const drains = [];
      for (const [, info] of _sessions) {
        drains.push(info.sendQueue.drain());
      }
      await Promise.all(drains);

      // Check if any session had new enqueues during this pass
      let changed = false;
      for (const [label, info] of _sessions) {
        if (info.sendQueue.enqueuedCount !== counts.get(label)) {
          changed = true;
          break;
        }
      }
      if (!changed) return; // quiescent
    }
    throw new Error(
      `drainAll did not quiesce after ${maxPasses} passes (possible relay runaway)`,
    );
  }
  /** Flush all line buffers. */
  function flushAll() {
    for (const [, info] of _sessions) {
      info.lineBuf.flush();
    }
  }

  /** Close one session by label: flush, kill, drop, reassign current. */
  function close(label) {
    const info = _sessions.get(label);
    if (!info) {
      stderr.write(`No session "${label}"\n${NO_SESSION_HINT}`);
      return false;
    }
    info.lineBuf.dispose();
    try { info.session.close(); } catch {}
    _sessions.delete(label);
    if (_currentLabel === label) {
      const remaining = [..._sessions.keys()];
      _currentLabel = remaining.length ? remaining[remaining.length - 1] : null;
    }
    return true;
  }

  /** Close all sessions. */
  function closeAll() {
    for (const [, info] of _sessions) {
      try { info.session.close(); } catch {}
    }
  }

  /** Iterator over [label, info] entries (for summary iteration in runTasks). */
  function entries() {
    return _sessions.entries();
  }

  /** The given session's last completed turn text (for /forward).
   *  Returns null if no such session, "" if it has not completed a turn. */
  function lastTurnText(label) {
    const info = _sessions.get(label);
    return info ? (info.lastTurnText ?? "") : null;
  }

  return {
    open,
    enqueue,
    use,
    list,
    close,
    drainAll,
    flushAll,
    closeAll,
    entries,
    lastTurnText,
    get currentLabel() { return _currentLabel; },
    get _sessions() { return _sessions; },
    get sessionLoad() { return _sessions.size + _pendingOpens; },
  };
}

export { createSessionManager, createLineBuffer, createOutputMux, checkAgentAvailable };
