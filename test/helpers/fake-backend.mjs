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
    stallTurn = false,          // ack prompt + agent_start,然后永不结束 turn
    dropGetState = false,       // 永不应答 get_state(模拟 RPC wedge)
    noGetLastAssistantText = false, // respond to get_last_assistant_text with empty response (no data)
    // Multi-segment: each inner array is a segment; turn_start emitted between them.
    // get_last_assistant_text returns only the LAST segment's text (simulates the bug).
    responseSegments = null,    // string[][] — overrides responseDeltas when set
    // Provider/turn error: ack the prompt, start the turn, emit NO deltas, then end
    // the turn with stopReason:"error" embedded — exactly how real OMP surfaces a
    // model-API failure (e.g. 402 Insufficient Balance) on agent_end.
    turnError = null,           // { errorStatus, errorMessage } | null
  } = opts;

  let accumulatedText = "";
  let lastSegmentText = "";  // for get_last_assistant_text when multi-segment
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
  // Fakes back no real OS process, so they must NOT advertise a kill-triggering
  // pid: every kill/record site guards on Number.isInteger(pid), so a null pid
  // makes terminateProcessTree / scheduleForceKill / writePidRecord no-op for
  // fakes — eliminating any chance of signalling an unrelated real pid that a
  // fabricated 90000+ value might have collided with.
  proc.pid = null;
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
  // Test hook: deterministically push a JSONL line onto stdout *now*, with no
  // timer involved. Lets tests emit an event only AFTER attaching a listener,
  // avoiding the errorMsgAfterReady timer race (which Windows's ~15.6ms clock
  // granularity turns into a lost-error hang).
  proc.pushLine = pushLine;

  function respond(id, data) {
    pushLine({ id, type: "response", data });
  }

  function respondEmpty(id) {
    pushLine({ id, type: "response" });
  }

  function handleMessage(msg) {
    if (msg.type === "prompt") {
      if (stallTurn) {
        pushLine({ id: msg.id, type: "response" });
        pushLine({ type: "agent_start" });
        return;
      }
      if (failPrompt) {
        pushLine({
          id: msg.id,
          type: "response",
          success: false,
          error: "simulated prompt failure",
        });
        return;
      }
      if (turnError) {
        // Ack, start the turn, no deltas, then end with stopReason:"error"
        // embedded on the assistant message (real OMP shape for a 402 etc.).
        // turnError.via picks the end-event shape: "agent_end" carries a
        // `messages` array (default), "turn_end" carries a single `message`.
        pushLine({ id: msg.id, type: "response" });
        pushLine({ type: "agent_start" });
        const errAssistant = {
          role: "assistant",
          content: [],
          stopReason: "error",
          errorStatus: turnError.errorStatus,
          errorMessage: turnError.errorMessage,
        };
        if (turnError.via === "turn_end") {
          pushLine({ type: "turn_end", message: errAssistant, toolResults: [] });
        } else {
          pushLine({
            type: "agent_end",
            messages: [
              { role: "user", content: [{ type: "text", text: "" }] },
              errAssistant,
            ],
          });
        }
        return;
      }
      // Acknowledge the prompt
      pushLine({ id: msg.id, type: "response" });
      // Stream the response
      const segments = responseSegments || [responseDeltas];
      accumulatedText = "";
      lastSegmentText = "";
      pushLine({ type: "agent_start" });
      for (let si = 0; si < segments.length; si++) {
        const deltas = segments[si];
        if (si > 0) {
          // Simulate a tool-call interruption: new turn starts, dropping
          // lastAssistantText but NOT turnText (the fix's accumulator).
          pushLine({ type: "turn_start" });
        }
        lastSegmentText = "";
        for (const delta of deltas) {
          lastSegmentText += delta;
          accumulatedText += delta;
          pushLine({
            type: "message_update",
            message: { type: "text_delta", delta },
          });
        }
      }
      pushLine({ type: "agent_end" });
    } else if (msg.type === "get_last_assistant_text") {
      if (noGetLastAssistantText) {
        respondEmpty(msg.id);
      } else {
        // When multi-segment, return only the LAST segment's text (simulates
        // the real OMP's get_last_assistant_text behaviour — the bug).
        const text = responseSegments ? lastSegmentText : accumulatedText;
        respond(msg.id, { text });
      }
    } else if (msg.type === "get_state") {
      if (dropGetState) return;   // 模拟 wedge:请求石沉大海
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

// ── makeFakeCodexProc — fake `codex app-server` (JSON-RPC over stdio) ───
// Drives CodexSession through its real handshake (initialize → initialized →
// thread/start) and turn lifecycle (turn/start → turn/completed) so contract
// tests can assert how CodexSession surfaces a turn-level failure WITHOUT a real
// codex. Mirrors the line-delimited JSON-RPC the app-server speaks: requests get
// a `{ id, result }` reply; notifications are `{ method, params }`.
//
// opts:
//   turnStartStatus  — status returned in the turn/start RESPONSE. A terminal
//                      status ("failed"/"completed"/…) settles the turn
//                      synchronously inside send(); "in_progress" keeps it live
//                      so an async turn/completed notification drives it.
//   turnError        — null | { via?: "completed"|"error", status?, message? }.
//                      When set with via "completed" (default), emit an async
//                      turn/completed notification carrying `status` (default
//                      "failed"); with via "error", emit an `error` notification.
export function makeFakeCodexProc(opts = {}) {
  const { turnStartStatus = "in_progress", turnError = null } = opts;
  const THREAD_ID = "thread-fake";
  const TURN_ID = "turn-fake";

  const stdin = new Writable({
    write(chunk, encoding, callback) {
      for (const line of chunk.toString().split("\n")) {
        const t = line.trim();
        if (!t) continue;
        let msg;
        try {
          msg = JSON.parse(t);
        } catch {
          continue;
        }
        process.nextTick(() => handleMessage(msg));
      }
      callback();
    },
  });
  const stdout = new Readable({ read() {} });
  const stderr = new Readable({ read() {} });

  const proc = new EventEmitter();
  proc.stdin = stdin;
  proc.stdout = stdout;
  proc.stderr = stderr;
  proc.pid = null;
  proc.exitCode = null;

  const origEnd = stdin.end.bind(stdin);
  stdin.end = function (...args) {
    proc._closed = true;
    return origEnd(...args);
  };
  proc._closed = false;

  function push(obj) {
    stdout.push(JSON.stringify(obj) + "\n");
  }

  function handleMessage(msg) {
    const { id, method } = msg;
    switch (method) {
      case "initialize":
        push({ id, result: {} });
        return;
      case "initialized":
        return; // notification, no reply
      case "thread/start":
        push({ id, result: { thread: { id: THREAD_ID } } });
        return;
      case "turn/start":
        push({
          id,
          result: { turn: { id: TURN_ID, status: turnStartStatus } },
        });
        if (turnError) {
          if (turnError.via === "error") {
            push({
              method: "error",
              params: {
                threadId: THREAD_ID,
                turn: { id: TURN_ID },
                error: { message: turnError.message || "codex provider error" },
              },
            });
          } else {
            push({
              method: "turn/completed",
              params: {
                threadId: THREAD_ID,
                turn: { id: TURN_ID, status: turnError.status || "failed" },
              },
            });
          }
        }
        return;
      default:
        if (id !== undefined) push({ id, result: {} }); // generic ack (turn/interrupt etc.)
    }
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
    this._texts = opts.texts || null;
    this._failPrompt = Boolean(opts.failPrompt);
    this._failAfter = opts.failAfter ?? null;
    this._failAfterTriggered = false;

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

    // failAfter: after N successful sends, the next send fails (one-shot).
    // Used to simulate session drops mid-loop for reviseWithHuman tests.
    if (this._failAfter != null && !this._failAfterTriggered && this.turnCount >= this._failAfter) {
      this._failAfterTriggered = true;
      throw new Error("simulated session failure");
    }

    this.#setStatus("running", true);
    this.#emitEvent({ type: "agent_start" });

    // Reset accumulated text each send (aligns with real line 480:
    // agent_start clears lastAssistantText)
    this.lastAssistantText = "";

    if (this._texts && this._texts.length > 0) {
      // Per-turn text responses: consume next entry, clamp to last if exhausted
      const idx = Math.min(this.turnCount, this._texts.length - 1);
      this.lastAssistantText = this._texts[idx];
      if (this.lastAssistantText) {
        this.emit("delta", this.lastAssistantText);
        this.#emitEvent({
          type: "message_update",
          message: { type: "text_delta", delta: this.lastAssistantText },
        });
      }
    } else {
      for (const delta of this._deltas) {
        this.lastAssistantText += delta;
        this.emit("delta", delta);
        this.#emitEvent({
          type: "message_update",
          message: { type: "text_delta", delta },
        });
      }
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
