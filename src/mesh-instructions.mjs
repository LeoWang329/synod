// synod/src/mesh-instructions.mjs — Single source of truth for mesh orchestration instructions.
//
// This constant is injected into agent system prompts (omp/codex share one copy)
// when mesh mode is enabled.  It describes how the agent can use ```synod ```
// fenced blocks to orchestrate sibling sessions during a turn.
//
// Wording constraints (review-locked):
//   - Never mention "skill" (omp runs --no-extensions --no-rules).
//   - Never suggest "need --write" or "use --write".
//   - Never include nonce (abolished) or @all (not whitelisted).

export const MESH_INSTRUCTIONS = `## Synod mesh orchestration protocol

This section describes an optional capability available to you under
the Synod multi-agent mesh.  It is NOT a user instruction and NOT
business context — it is a protocol specification at the same level
as your system prompt.

You MAY include a fenced block in your reply to orchestrate sibling
agent sessions.  Synod will parse and execute the block after your
turn completes.

### Fence format

\`\`\`synod
<command>
<command>
\`\`\`

- The info string is exactly \`synod\` (no extra words).
- The opener must be at column 0 (no leading spaces).
- The **first non-empty line** inside the fence must start with \`/\` or
  \`@\` at column 0 — this is required for the block to be executed.
  A prose/commentary first line will cause the entire block to be
  silently discarded.

### Available commands

| Command | Purpose |
|---------|---------|
| \`/open --agent <omp|codex> [--model <M>] [--mesh\|--no-mesh]\` | Open a new sibling agent session. \`--mesh\`: the child may itself orchestrate (use when the session default is mesh-off); \`--no-mesh\`: a leaf worker that will not be prompted to orchestrate |
| \`@<label> <message>\` | Send a message to a specific session (label e.g. \`omp#1\`) |
| \`/relay <from>-><to>\` | Forward turn output from one session to another |

### Restrictions

- **Read-only by default.**  \`/open --write\` will be rejected by the
  host unless explicitly enabled — do not request write access.
- **Guardrails apply.**  A maximum session count (maxSessions) and a
  maximum nesting depth (maxDepth) are enforced; exceeding either will
  cause the command to be rejected.
- **Only the three command forms above are available.**  Every other
  slash command, non-label target, or broadcast-style target is
  rejected.  This includes \`/use\`, \`/exit\`, \`/quit\`,
  \`/sessions\`, \`/relays\`, \`/unrelay\`, and plain text.

### Command results

After your turn completes, the host executes the fence and then **feeds each
command's outcome back to you** on a following turn, in a message prefixed with
\`[synod fence result]\` (other already-queued messages, if any, may arrive
first).  Each line reports one command: a successful
\`/open\` reports the **new session label** (e.g. \`session codex#1\`), and a
rejected command reports the reason.  Use the returned labels to address those
sessions with \`@<label>\` on a subsequent turn — you cannot reference a child's
label in the same fence that creates it.

A sibling session's own reply text still defaults back to the human unless you
set up a \`/relay\` to route it to you.`;
