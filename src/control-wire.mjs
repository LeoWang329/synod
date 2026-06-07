// synod/src/control-wire.mjs — Control channel: wires marker parser + dispatch at turn completion.
//
// Connects extractControlCommands (B1) to dispatch (B2) at the same turn-completion
// point used by relay (A2).  Follows the relay.mjs pattern: pure logic, single-factory
// export, injectable dependencies.
//
// Exports:
//   createControlChannel({ dispatch, nonce, onWarnings })
//     — Low-level: parse + dispatch.  Returns { onTurnComplete, nonce }.
//   wireControl({ sm, registry, stderr, guardrails })
//     — CLI helper: creates dispatch+channel, composes relay+control into one
//       onTurnComplete callback.  Uses documented default guardrails.
//
// ## Nonce handshake boundary
//
// Each control channel holds a nonce generated via crypto.randomUUID().
// Only control fences tagged with `synod <this-nonce>` are recognized.
//
// How the agent learns the nonce is the *handshake* — this module does NOT
// inject the nonce into agent context.  That responsibility belongs to the
// orchestrator layer (B4 / e2e) which prefixes the prompt or system message
// with the nonce.  This module only threads the nonce to the parser side.
// Tests simulate the agent knowing the correct nonce.
//
// ## Output routing (default: back to human)
//
// When a control command opens a child session via manager.open(), its output
// goes to stdout through the normal line-buffer path — i.e., back to the human.
// Feeding output back to the initiating agent requires an explicit relay rule
// or send-back command; this is NOT automatic.  Rationale: simplest default,
// least surprising, least error-prone.
//
// ## Delta honesty
//
// Deltas are streamed to the user character-by-character in real time.
// Control fences within the stream CANNOT be stripped mid-stream — they
// appear as visible text to the human.  Commands are only parsed and
// dispatched after the turn completes (onTurnComplete), not during streaming.
// This is an accepted limitation; same discipline as relay.  We do NOT pretend
// mid-stream stripping is possible.

import { randomUUID } from "node:crypto";
import { extractControlCommands } from "./control-marker.mjs";
import { createControlDispatch } from "./control-dispatch.mjs";

/**
 * Create a control channel.
 *
 * @param {object} opts
 * @param {(commands: object[]) => Promise<{ dispatched: object[], rejected: object[] }>} opts.dispatch
 *   Dispatch function from createControlDispatch.
 * @param {string} [opts.nonce] — pre-existing nonce; if omitted, a fresh randomUUID is generated.
 * @param {(label: string, warnings: object[]) => void} [opts.onWarnings]
 *   Optional callback for parse/validation warnings (e.g. log to stderr).
 * @returns {{
 *   onTurnComplete: (label: string, turnText: string) => void,
 *   nonce: string,
 * }}
 */
export function createControlChannel({ dispatch, nonce, onWarnings }) {
  const _nonce = nonce || randomUUID();

  /**
   * Called when a session completes a real turn (same hook as relay).
   * Extracts control commands from the complete turn text and dispatches them.
   *
   * Dispatch is fire-and-forget — we do not block turn completion on command
   * execution.  Rejections are collected by dispatch itself; errors never
   * propagate back to the caller.
   */
  function onTurnComplete(_label, turnText) {
    if (!turnText) return;

    const { commands, warnings } = extractControlCommands(turnText, { nonce: _nonce });

    if (onWarnings && warnings.length > 0) {
      try { onWarnings(_label, warnings); } catch {}
    }

    if (commands.length === 0) return;

    // Fire-and-forget.  Synchronous throw is caught so it cannot bubble up
    // through the session-manager turn-completion point.  Async rejections
    // are swallowed via .catch so they never become unhandledRejections.
    let p;
    try {
      p = dispatch(commands);
    } catch (_syncErr) {
      // dispatch threw synchronously — swallow, do not propagate.
      return;
    }
    if (typeof p?.catch === "function") {
      p.catch(() => {});
    }
  }

  return { onTurnComplete, nonce: _nonce };
}

/**
 * Wire control dispatch + channel into the session manager, composing
 * relay and control into a single onTurnComplete callback.
 *
 * This is the CLI integration helper.  It creates a control-dispatch
 * instance with the documented default guardrails, wraps it in a control
 * channel, and returns a combined onTurnComplete that feeds both relay
 * forwarding and control-command dispatch at every real turn completion.
 *
 * Default guardrails:
 *   maxSessions: 10
 *   maxDepth: 3
 *   allowWrite: false (read-only by default; write must be opt-in)
 *   allowedAgents: null (any agent)
 *   allowedModels: null (any model)
 *
 * @param {object} opts
 * @param {object} opts.sm — session-manager instance (must have open/enqueue/_sessions)
 * @param {{ onTurnComplete: (label: string, turnText: string) => void }} opts.registry
 *   Relay registry (or any object with onTurnComplete).  Called before control dispatch.
 * @param {NodeJS.WriteStream} opts.stderr — for guardrail/warning log output
 * @param {object} [opts.guardrails] — overrides for any default guardrail
 * @param {string} [opts.nonce] — pre-existing nonce; if omitted, a fresh randomUUID is generated
 * @returns {{
 *   onTurnComplete: (label: string, result: { text: string }) => void,
 *   nonce: string,
 * }}
 */
export function wireControl({ sm, registry, stderr, guardrails, nonce }) {
  const g = {
    maxSessions: 10,
    maxDepth: 3,
    allowWrite: false,
    ...guardrails,
  };

  const controlDispatch = createControlDispatch({
    manager: sm,
    guardrails: g,
    log: ({ level, reason }) => {
      if (level === "warn" || level === "error") {
        stderr.write(`[control ${level}] ${reason}\n`);
      }
    },
  });

  const control = createControlChannel({
    dispatch: controlDispatch,
    nonce,
    onWarnings: (_label, warnings) => {
      for (const w of warnings) {
        stderr.write(`[control warn] line ${w.line}: ${w.reason}\n`);
      }
    },
  });

  /**
   * Composed turn-completion callback: relay first, then control.
   * Suitable for passing to createSessionManager's onTurnComplete option.
   */
  function onTurnComplete(label, result) {
    registry.onTurnComplete(label, result.text);
    control.onTurnComplete(label, result.text);
  }

  return { onTurnComplete, nonce: control.nonce };
}
