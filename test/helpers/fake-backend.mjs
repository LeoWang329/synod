/**
 * FakeSession — contract for flow runtime (F1 `agent()` primitive).
 *
 * Aligns with the consumer-side API of the real `OmpSession` in
 * `src/backend.mjs`.  Flow runtime code that calls `agent()` MUST
 * only depend on the public surface documented here.
 *
 * ## Lifecycle
 *   const session = new FakeSession(opts)
 *   // or: const session = await fakeOpenBackend(opts)
 *   await session.send(msg)            // fire-and-forget
 *   await session.send(msg, { wait: true })  // wait for turn completion
 *   const r = await session.result()   // latest turn snapshot
 *   const s = session.summary()        // live metadata (no I/O)
 *   session.close()                    // tear down
 *
 * ## Constructor / fakeOpenBackend opts
 *   { agent, cwd, write, model, effort, deltas, text, failPrompt }
 *
 * ## Methods
 *
 * ### send(message, options?)
 *   message   {string} — required, non-empty (throws "message is required.")
 *   options   { wait?: boolean }
 *
 *   Emits in order:
 *     - 'status'   { status: "running", isStreaming: true }
 *     - 'event'    { type: "agent_start" }
 *     - 'delta'    <string>   (one per configured delta)
 *     - 'event'    { type: "message_update", message: { type: "text_delta", delta } }
 *     - 'event'    { type: "agent_end" }
 *     - 'status'   { status: "idle", isStreaming: false }
 *
 *   Return shape (wait: false / default):
 *     { accepted: true, session_id: string, status: string }
 *
 *   Return shape (wait: true) — delegates to result():
 *     { session: Summary, text: string|null, recent_events: EventRecord[], log_file: string }
 *
 *   Invariants:
 *     - Text is **reset per send** (agent_start clears lastAssistantText).
 *       Consecutive sends do NOT accumulate — second send returns only its
 *       own deltas.
 *     - failPrompt:true → send() rejects with "simulated prompt failure".
 *       No 'error' event is emitted for this path (matches real backend:
 *       success:false triggers pending.reject(), not #emitError).
 *     - Empty / whitespace-only / null message → reject with
 *       "message is required."
 *
 * ### result()
 *   Returns a snapshot of the latest turn:
 *     {
 *       session: Summary,
 *       text: string | null,
 *       recent_events: Array<{ at: string, event: object }>,  // last 20
 *       log_file: string,
 *     }
 *
 * ### close()
 *   Sets status "closed", marks _closed = true.
 *   Returns { closed: true, session_id: string }.
 *
 * ### summary()
 *   Synchronous, no I/O.  Returns live metadata:
 *     {
 *       id, agent, cwd, write, model, effort,
 *       status, isStreaming, turnCount, pid (null),
 *       createdAt, updatedAt, lastError, logFile, sessionState (null),
 *     }
 *   createdAt is stable (set at construction); updatedAt advances on
 *   every setStatus / emitEvent.
 *
 * ## Events (EventEmitter)
 *   'delta'   (delta: string)            — text_delta content
 *   'status'  ({ status, isStreaming })  — state transitions
 *   'event'   (event: object)            — raw compact events recorded
 *                                           into recent_events
 *   'error'   (err: Error)               — process-level errors
 *                                           (NOT emitted for failPrompt)
 *
 * ## recent_events contract
 *   Every send() round records:
 *     - agent_start
 *     - message_update  (one per delta)
 *     - agent_end
 *   Status transitions (running ↔ idle) are also recorded as
 *   { type: "status", status, isStreaming } events.
 *   result().recent_events returns the last 20 entries.
 */
import { Readable, Writable } from "node:stream";
import { EventEmitter } from "node:events";

export function makeFakeOmpProc(opts = {}) {
  const {
    sendReady = true,
    readyDelay = 5,
    emitProcError = null,       // emit 'error' on proc immediately
    closeCodeOnStart = null,    // emit 'close' with code immediately
    responseDeltas = ["Hello ", "from ", "omp"],
    errorMsgAfterReady = null,  // push error message to stdout after ready
    failPrompt = false,         // respond to prompt with success:false
    noGetLastAssistantText = false, // respond to get_last_assistant_text with empty response (no data)
  } = opts;

  let accumulatedText = "";

  // stdin: writable that collects written JSON lines and auto-responds
  const stdin = new Writable({
    write(chunk, encoding, callback) {
      const text = chunk.toString().trim();
      if (!text) {
        callback();
        return;
      }
      try {
        const msg = JSON.parse(text);
        // Defer so stdout data is pushed after the current tick's I/O settles
        process.nextTick(() => handleMessage(msg));
      } catch {
        // Malformed JSON → silently skip (session handles raw lines elsewhere)
      }
      callback();
    },
  });

  // stdout: readable we push JSONL lines into; readline.createInterface will consume
  const stdout = new Readable({
    read() {
      /* no-op — data pushed externally */
    },
  });

  // stderr: readable, never pushed to
  const stderr = new Readable({
    read() {
      /* no-op */
    },
  });

  const proc = new EventEmitter();
  proc.stdin = stdin;
  proc.stdout = stdout;
  proc.stderr = stderr;
  proc.pid = 90000 + Math.floor(Math.random() * 10000);
  proc.exitCode = null;

  const origEnd = stdin.end.bind(stdin);
  stdin.end = function (...args) {
    proc._closed = true;
    return origEnd(...args);
  };

  proc._closed = false;
  function pushLine(obj) {
    stdout.push(JSON.stringify(obj) + "\n");
  }

  function respond(id, data) {
    pushLine({ id, type: "response", data });
  }

  function respondEmpty(id) {
    pushLine({ id, type: "response" });
  }

  function handleMessage(msg) {
    if (msg.type === "prompt") {
      if (failPrompt) {
        pushLine({
          id: msg.id,
          type: "response",
          success: false,
          error: "simulated prompt failure",
        });
        return;
      }
      // Acknowledge the prompt
      pushLine({ id: msg.id, type: "response" });
      // Stream the response
      pushLine({ type: "agent_start" });
      for (const delta of responseDeltas) {
        accumulatedText += delta;
        pushLine({
          type: "message_update",
          message: { type: "text_delta", delta },
        });
      }
      pushLine({ type: "agent_end" });
    } else if (msg.type === "get_last_assistant_text") {
      if (noGetLastAssistantText) {
        respondEmpty(msg.id);
      } else {
        respond(msg.id, { text: accumulatedText });
      }
    } else if (msg.type === "get_state") {
      respond(msg.id, {
        isStreaming: false,
        queuedMessageCount: 0,
        sessionId: "fake-session",
        sessionFile: "/tmp/fake-session.json",
        messageCount: 1,
        model: "fake-model",
      });
    } else if (msg.type === "abort") {
      respond(msg.id, {});
    } else {
      // Unknown request → respond with empty data
      respond(msg.id, {});
    }
  }

  // Initialisation — schedule based on config
  process.nextTick(() => {
    if (emitProcError) {
      proc.emit("error", emitProcError);
      return;
    }
    if (closeCodeOnStart !== null) {
      proc.exitCode = closeCodeOnStart;
      proc.emit("close", closeCodeOnStart, null);
      return;
    }
    if (sendReady) {
      setTimeout(() => {
        pushLine({ type: "ready" });
      }, readyDelay);
    }
  });

  // Optional: push an error message to stdout after ready
  if (errorMsgAfterReady) {
    setTimeout(() => {
      pushLine({ type: "error", message: errorMsgAfterReady });
    }, readyDelay + 10);
  }

  return proc;
}
// ── FakeSession (session-level fake, no subprocess) ────────────────────
// Aligns with OmpSession public API: send(), result(), close(), summary(),
// plus EventEmitter for delta/status/error events.  Configurable via
// constructor opts and fakeOpenBackend().

export class FakeSession extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.id = `fake-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    this.agent = opts.agent || "omp";
    this.cwd = opts.cwd || "/tmp";
    this.write = Boolean(opts.write);
    this.model = opts.model || null;
    this.effort = opts.effort || null;
    this.status = "idle";
    this.isStreaming = false;
    this.lastAssistantText = opts.text || "";
    this.turnCount = 0;
    this.lastError = null;
    this.createdAt = new Date().toISOString();
    this.updatedAt = this.createdAt;
    this.events = [];

    // Fake-specific config
    this._deltas = opts.deltas || [];
    this._failPrompt = Boolean(opts.failPrompt);

    // Tracking for test assertions
    this._closed = false;
    this._sentMessages = [];
    this._opened = true;
  }

  async send(message, options = {}) {
    // Empty message validation (aligns with real OmpSession line 523)
    if (!message || !String(message).trim())
      throw new Error("message is required.");
    if (this._closed) throw new Error(`Session ${this.id} is closed.`);

    this._sentMessages.push({ message, options, at: new Date().toISOString() });

    if (this._failPrompt) {
      // Real backend (line 466-470): success:false triggers pending.reject(),
      // NOT #emitError. Just throw.
      throw new Error("simulated prompt failure");
    }

    this.#setStatus("running", true);
    this.#emitEvent({ type: "agent_start" });

    // Reset accumulated text each send (aligns with real line 480:
    // agent_start clears lastAssistantText)
    this.lastAssistantText = "";

    for (const delta of this._deltas) {
      this.lastAssistantText += delta;
      this.emit("delta", delta);
      this.#emitEvent({
        type: "message_update",
        message: { type: "text_delta", delta },
      });
    }

    this.turnCount++;
    this.#emitEvent({ type: "agent_end" });
    this.#setStatus("idle", false);

    if (options.wait) {
      return this.result();
    }

    return { accepted: true, session_id: this.id, status: this.status };
  }

  async result() {
    return {
      session: this.summary(),
      text: this.lastAssistantText || null,
      recent_events: this.events.slice(-20),
      log_file: `/tmp/${this.id}.log`,
    };
  }

  close() {
    this.#setStatus("closed", false);
    this._closed = true;
    return { closed: true, session_id: this.id };
  }

  summary() {
    return {
      id: this.id,
      agent: this.agent,
      cwd: this.cwd,
      write: this.write,
      model: this.model,
      effort: this.effort,
      status: this.status,
      isStreaming: this.isStreaming,
      turnCount: this.turnCount,
      pid: null,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      lastError: this.lastError,
      logFile: `/tmp/${this.id}.log`,
      sessionState: null,
    };
  }

  #setStatus(status, isStreaming) {
    const nextStreaming = Boolean(isStreaming);
    const changed =
      this.status !== status || this.isStreaming !== nextStreaming;
    this.status = status;
    this.isStreaming = nextStreaming;
    this.updatedAt = new Date().toISOString();
    if (changed) {
      this.#emitEvent({
        type: "status",
        status,
        isStreaming: nextStreaming,
      });
      this.emit("status", {
        status: this.status,
        isStreaming: this.isStreaming,
      });
    }
  }

  #emitEvent(event) {
    const record = { at: new Date().toISOString(), event };
    this.updatedAt = record.at;
    this.events.push(record);
    this.emit("event", event);
  }

  #emitError(err) {
    if (this.listenerCount("error") > 0) {
      this.emit("error", err);
    }
  }
}

export async function fakeOpenBackend(opts = {}) {
  // Simulate promise-based async startup (real openBackend is async)
  await new Promise((resolve) => setTimeout(resolve, 0));
  return new FakeSession(opts);
}
