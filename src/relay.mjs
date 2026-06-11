// synod/src/relay.mjs — Agent relay: parse /relay commands and manage relay rules.
//
// Relay forwards a source session's complete turn text to target session(s)
// when the source completes a real turn (enqueue promise resolve), NOT on
// bare status:idle events.  Includes cycle detection, source attribution,
// and echo prevention (rules are directional, not auto-reciprocal).

/**
 * Parse a relay specification string.
 *
 * @param {string} input — e.g. "/relay omp->codex" or "omp->codex"
 * @returns {{ from: string, to: string } | { error: string }}
 */
export function parseRelay(input) {
  const s = input.startsWith("/relay ") ? input.slice(7).trim() : input.trim();
  const idx = s.indexOf("->");
  if (idx === -1) return { error: `relay must contain "->"` };
  const from = s.slice(0, idx).trim();
  const to = s.slice(idx + 2).trim();
  if (!from) return { error: "relay source label must not be empty" };
  if (!to) return { error: "relay target label must not be empty" };
  if (from === to) return { error: "relay source and target must differ" };
  return { from, to };
}

/**
 * Create a relay registry.
 *
 * @param {(target: string, msg: string) => void} enqueue — called with the target
 *   label and attributed message for each forward.  Typically wired to
 *   session-manager.enqueue().
 * @returns {{
 *   add: (from: string, to: string) => void,
 *   remove: (from: string, to: string) => void,
 *   list: () => Array<{ from: string, to: string }>,
 *   onTurnComplete: (fromLabel: string, turnText: string) => void,
 * }}
 */
export function createRelayRegistry(enqueue) {
  const _graph = new Map(); // from → Set<to>

  /** DFS cycle check: is there a path from `from` to `to`? */
  function hasPath(from, to, visited = new Set()) {
    if (from === to) return true;
    if (visited.has(from)) return false;
    visited.add(from);
    const targets = _graph.get(from);
    if (!targets) return false;
    for (const t of targets) {
      if (hasPath(t, to, visited)) return true;
    }
    return false;
  }

  return {
    /**
     * Add a relay rule from→to.  Throws on self-reference, duplicate,
     * or would-create-cycle.
     */
    add(from, to) {
      if (!from || !to) throw new Error("from and to are required");
      if (from === to) throw new Error("cannot relay to self");
      // Cycle check: adding from→to would be a cycle if to can already reach from
      if (hasPath(to, from)) {
        throw new Error(`adding relay ${from}->${to} would create a cycle`);
      }
      if (!_graph.has(from)) _graph.set(from, new Set());
      const targets = _graph.get(from);
      if (targets.has(to)) {
        throw new Error(`relay ${from}->${to} already exists`);
      }
      targets.add(to);
    },

    /** Remove a relay rule. */
    remove(from, to) {
      const targets = _graph.get(from);
      if (targets) targets.delete(to);
    },

    /**
     * Remove all rules involving the given label (as source or target).
     * Use when a session is closed to clean up its relay bindings.
     */
    removeForLabel(label) {
      // Remove rules where label is the source
      _graph.delete(label);
      // Remove rules where label is a target
      for (const [, targets] of _graph) {
        targets.delete(label);
      }
    },

    /** List all active relay rules. */
    list() {
      const result = [];
      for (const [from, targets] of _graph) {
        for (const to of targets) {
          result.push({ from, to });
        }
      }
      return result;
    },

    /**
     * Called when a source session completes a real turn.
     * Forwards the turn text (with source attribution) to all target sessions.
     */
    onTurnComplete(fromLabel, turnText) {
      const targets = _graph.get(fromLabel);
      if (!targets || targets.size === 0) return;
      const msg = `[relay from ${fromLabel}]\n\n${turnText}`;
      for (const to of targets) {
        enqueue(to, msg, { from: fromLabel, chars: turnText.length });
      }
    },
  };
}
