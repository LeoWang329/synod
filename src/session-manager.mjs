// synod/src/session-manager.mjs — Session collection + event wiring.
//
// Encapsulates: session open/close/enqueue/list, per-session line buffers,
// send queues, and event wiring (delta → feed, error → stderr, status → flush).
// Injected via createSessionManager({ openBackend, stdout, stderr, report, cwd, defaults, onIdle, errorLeadingNewline }).

import { enabled, color, labelColor } from "./ui/ansi.mjs";

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
function createSessionManager({ openBackend, stdout, stderr, report, cwd, defaults, onIdle, onTurnComplete, errorLeadingNewline = false }) {
  const _sessions = new Map(); // label → { session, agent, model, effort, lineBuf, sendQueue }
  let _currentLabel = null;
  let _pendingOpens = 0;

  const _defaults = { model: undefined, effort: undefined, write: false, mesh: false, ...defaults };
  const _onIdle = onIdle || (() => {});
  const _onTurnComplete = onTurnComplete || null;
  const _nl = errorLeadingNewline ? "\n" : "";

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

      const useColor = enabled(stdout);
      const colorize = useColor ? (s) => color(labelColor(label), s) : null;
      const lineBuf = createLineBuffer(label, stdout, { colorize });
      session.on("delta", (chunk) => lineBuf.feed(chunk));
      session.on("error", (err) => {
        stderr.write(`${_nl}[${label} error] ${err.message}\n`);
      });
      session.on("status", ({ status }) => {
        if (status === "idle") {
          lineBuf.flush();
          _onIdle(label);
        }
      });

      _sessions.set(label, {
        session, agent, model: m, effort: e, lineBuf,
        sendQueue: createSendQueue(session, label, _onTurnComplete),
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
      stderr.write(target ? `No session "${target}"\n` : "No current session. Use /open to create one.\n");
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
    stderr.write(`No session "${target}"\n`);
    return false;
  }

  /** Write formatted session list to stdout. */
  function list() {
    stdout.write("\n");
    for (const [label, info] of _sessions) {
      const marker = label === _currentLabel ? "*" : " ";
      const sum = info.session.summary();
      stdout.write(
        ` ${marker} ${label}  ${sum.agent}  ${sum.model || "default"}  ${sum.status}\n`,
      );
    }
    stdout.write("\n");
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

  return {
    open,
    enqueue,
    use,
    list,
    drainAll,
    flushAll,
    closeAll,
    entries,
    get currentLabel() { return _currentLabel; },
    get _sessions() { return _sessions; },
    get sessionLoad() { return _sessions.size + _pendingOpens; },
  };
}

export { createSessionManager, createLineBuffer, checkAgentAvailable };
