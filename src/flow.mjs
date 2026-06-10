#!/usr/bin/env node
/**
 * src/flow.mjs — Flow engine CLI entry point.
 *
 * Usage:
 *   node src/flow.mjs <name> [input]    Run a flow by name.
 *   node src/flow.mjs --list            List available flows.
 *   node src/flow.mjs --help            Print this help.
 *
 * Options:
 *   --workflows <path>   Workflows directory (default: ./workflows).
 *   --list               List flow names and descriptions (no agent needed).
 *   --progress           Stream agent deltas to stdout (also SYNOD_PROGRESS=1).
 *
 * Input is parsed as JSON if possible, otherwise kept as a raw string.
 * When no input is given, the flow receives `undefined`.
 */
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRuntime } from "./flow/runtime.mjs";
import { discoverFlows, loadFlow } from "./flow/loader.mjs";
import { runFlow } from "./flow/runner.mjs";
import { openBackend } from "./backend.mjs";

// ── CLI parsing ──────────────────────────────────────────────────────────

/**
 * parseFlowArgs(argv) — pure function, no side effects.
 *
 * @param {string[]} argv — typically process.argv.slice(2)
 * @returns {{
 *   list: boolean,
 *   name: string | null,
 *   input: string | null,
 *   workflowsRoot: string | null,
 *   _help: boolean,
 *   _error: string | null,
 * }}
 */
export function parseFlowArgs(argv) {
  const out = {
    list: false,
    progress: false,
    name: null,
    input: null,
    workflowsRoot: null,
    _help: false,
    _error: null,
  };

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    switch (tok) {
      case "--list":
        out.list = true;
        break;
      case "--progress":
        out.progress = true;
        break;
      case "--workflows": {
        const v = argv[++i];
        if (!v || v.startsWith("--")) {
          out._error = "--workflows requires a path";
          return out;
        }
        out.workflowsRoot = v;
        break;
      }
      case "--help":
      case "-h":
        out._help = true;
        break;
      default: {
        if (tok.startsWith("-") && out.name === null) {
          out._error = `unrecognized option: ${tok}`;
          return out;
        }
        if (out.name === null) {
          out.name = tok;
        } else if (out.input === null) {
          out.input = tok;
        } else {
          out._error = `unexpected argument: ${tok}`;
          return out;
        }
      }
    }
  }

  return out;
}
function printHelp(stdout) {
  stdout.write(
    "Usage: node src/flow.mjs <name> [input]\n" +
    "       node src/flow.mjs --list\n" +
    "\n" +
    "Options:\n" +
    "  --workflows <path>  Workflows directory (default: ./workflows).\n" +
    "  --list              List flow names and descriptions (pure, no agent).\n" +
    "  --progress          Stream agent deltas to stdout with [agent:model] prefix.\n" +
    "                      Also enabled by SYNOD_PROGRESS=1.\n" +
    "  --help, -h          Print this help.\n" +
    "\n" +
    "Input is JSON-parsed if valid; otherwise treated as a raw string.\n" +
    "When no input is given, the flow receives undefined.\n",
  );
}

// ── Progress sink ─────────────────────────────────────────────────────────

/**
 * Create the default stdout progress sink.
 *
 * Writes to stdout with `[agent:model]` prefix.  No line buffering
 * (qa-loop is serial; YAGNI).  Silent for "started" / "end" types.
 *
 * @param {NodeJS.WritableStream} stdout
 * @returns {{ emit: (event: object) => void }}
 */
function createDefaultProgressSink(stdout) {
  let atLineStart = true;
  return {
    emit(event) {
      const label = event.model ? `${event.agent}:${event.model}` : event.agent;
      if (event.type === "opening") {
        stdout.write(`[${label}] opening...\n`);
        atLineStart = true;
      } else if (event.type === "delta" && event.text) {
        const t = event.text;
        let out = "";
        let i = 0;
        while (i < t.length) {
          if (atLineStart) {
            out += `[${label}] `;
            atLineStart = false;
          }
          const nl = t.indexOf("\n", i);
          if (nl === -1) {
            out += t.slice(i);
            break;
          }
          out += t.slice(i, nl + 1);
          atLineStart = true;
          i = nl + 1;
        }
        if (out) stdout.write(out);
      }
    },
  };
}

// ── Input parsing ────────────────────────────────────────────────────────

/**
 * Parse user-supplied input string.
 * Tries JSON.parse; falls back to raw string if that fails.
 * Returns undefined for null/undefined input.
 *
 * @param {string | null | undefined} raw
 * @returns {*} parsed value or raw string
 */
function parseInput(raw) {
  if (raw == null) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

// ── Main ─────────────────────────────────────────────────────────────────

/**
 * main(opts) — injectable entry point.
 *
 * All dependencies are injectable so the function is testable without
 * spawning a real process or hitting real backends.
 *
 * @param {object} [opts]
 * @param {string[]} [opts.argv]            — CLI args (default: process.argv.slice(2))
 * @param {object} [opts.stdout]            — writable stream (default: process.stdout)
 * @param {object} [opts.stderr]            — writable stream (default: process.stderr)
 * @param {Function} [opts.openBackend]     — backend factory (default: real openBackend)
 * @param {string} [opts.workflowsRoot]     — default workflows dir (default: ./workflows)
 * @param {string} [opts.cwd]               — working directory (default: process.cwd())
 * @returns {Promise<number>} exit code (0, 1, or 2)
 */
export async function main({
  argv = process.argv.slice(2),
  stdout = process.stdout,
  stderr = process.stderr,
  openBackend: ob = openBackend,
  workflowsRoot: defaultRoot = resolve(process.cwd(), "workflows"),
  cwd = process.cwd(),
  // Inject real fs by default; tests pass a noop/in-memory sink
  fs: realFs = { writeFile, appendFile },
} = {}) {
  const args = parseFlowArgs(argv);

  if (args._error) {
    stderr.write(`Error: ${args._error}\n`);
    return 2;
  }

  if (args._help) {
    printHelp(stdout);
    return 0;
  }

  const root = args.workflowsRoot ? resolve(cwd, args.workflowsRoot) : defaultRoot;

  // ── --list ─────────────────────────────────────────────────────────
  if (args.list) {
    let flows;
    try {
      flows = await discoverFlows(root);
    } catch (err) {
      stderr.write(`Error: failed to discover flows in ${root}: ${err.message}\n`);
      return 1;
    }
    for (const f of flows) {
      stdout.write(`${f.name}: ${f.meta.description}\n`);
    }
    return 0;
  }

  // ── <name> ─────────────────────────────────────────────────────────
  if (!args.name) {
    stderr.write("Error: flow name required (or use --list to see available flows)\n");
    return 2;
  }

  const input = parseInput(args.input);

  // ── Progress sink ───────────────────────────────────────────────────
  const progressEnabled = args.progress || process.env.SYNOD_PROGRESS === "1";
  const progressSink = progressEnabled ? createDefaultProgressSink(stdout) : undefined;

  // Ensure artifacts directory exists for logger
  await mkdir("artifacts", { recursive: true }).catch(() => {});

  // Build runtime with real dependencies
  let runtime;
  try {
    runtime = createRuntime({
      openBackend: ob,
      workflowsRoot: root,
      clock: () => Date.now(),
      fs: realFs,
      progress: progressSink,
    });
  } catch (err) {
    stderr.write(`Error: failed to create runtime: ${err.message}\n`);
    return 1;
  }

  // Find the flow — try discoverFlows first, then loadFlow as fallback
  let flow;
  try {
    const discovered = await discoverFlows(root);
    flow = discovered.find((f) => f.name === args.name);
  } catch {
    // discoverFlows may fail if the directory doesn't exist or has bad flows;
    // fall through to loadFlow.
  }

  if (!flow) {
    try {
      flow = await loadFlow(root, args.name);
      // loadFlow returns { name, meta, run, path } — compatible with runFlow
    } catch (err) {
      stderr.write(`Error: flow "${args.name}" not found in ${root}\n`);
      return 1;
    }
  }

  // Create context and run
  const ctx = runtime.createCtx(input, { cwd });
  try {
    const result = await runFlow(runtime, flow, ctx, input);
    if (result !== undefined) {
      stdout.write(JSON.stringify(result, null, 2) + "\n");
    }
    return 0;
  } catch (err) {
    stderr.write(`Error: flow "${args.name}" failed: ${err.message}\n`);
    return 1;
  }
}

// ── Run guard ────────────────────────────────────────────────────────────
// realpath both sides so symlinked installs (npm link / npm i -g) still match —
// see src/cli.mjs isEntrypoint() for the full rationale.
function isEntrypoint(metaUrl) {
  const entry = process.argv[1];
  if (!entry) return false;
  const self = fileURLToPath(metaUrl);
  try {
    return realpathSync(self) === realpathSync(entry);
  } catch {
    return self === resolve(entry);
  }
}
const _isMain = isEntrypoint(import.meta.url);

if (_isMain) {
  main()
    .then((code) => process.exit(code ?? 0))
    .catch((err) => {
      console.error("Fatal:", err);
      process.exit(2);
    });
}
