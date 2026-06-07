import { describe, it } from "node:test";
import assert from "node:assert";
import { createRelayRegistry } from "../src/relay.mjs";

describe("relay registry lifecycle", () => {

  it("add and list rules", () => {
    const relay = createRelayRegistry(() => {});
    relay.add("omp", "codex");
    relay.add("omp", "claude");

    const list = relay.list();
    assert.strictEqual(list.length, 2);
    assert.ok(list.some((r) => r.from === "omp" && r.to === "codex"));
    assert.ok(list.some((r) => r.from === "omp" && r.to === "claude"));
  });

  it("remove a specific rule", () => {
    const relay = createRelayRegistry(() => {});
    relay.add("a", "b");
    relay.add("a", "c");
    relay.remove("a", "b");

    assert.deepStrictEqual(relay.list(), [{ from: "a", to: "c" }]);
  });

  it("removeForLabel removes rules where label is source", () => {
    const relay = createRelayRegistry(() => {});
    relay.add("omp", "codex");
    relay.add("omp", "claude");

    relay.removeForLabel("omp");

    assert.strictEqual(relay.list().length, 0);
  });

  it("removeForLabel removes rules where label is target", () => {
    const relay = createRelayRegistry(() => {});
    relay.add("a", "omp");
    relay.add("b", "omp");
    relay.add("c", "d"); // unrelated

    relay.removeForLabel("omp");

    const list = relay.list();
    assert.strictEqual(list.length, 1);
    assert.deepStrictEqual(list[0], { from: "c", to: "d" });
  });

  it("removeForLabel removes both source and target rules for a label", () => {
    const relay = createRelayRegistry(() => {});
    relay.add("omp", "codex");  // omp as source
    relay.add("claude", "omp"); // omp as target
    relay.add("a", "b");        // unrelated

    relay.removeForLabel("omp");

    assert.deepStrictEqual(relay.list(), [{ from: "a", to: "b" }]);
  });

  it("removeForLabel does not throw for unknown label", () => {
    const relay = createRelayRegistry(() => {});
    relay.add("a", "b");
    relay.removeForLabel("nonexistent");
    assert.strictEqual(relay.list().length, 1);
  });

  it("removeForLabel disables forwarding from removed source", () => {
    const fwd = [];
    const relay = createRelayRegistry((to, msg) => fwd.push({ to, msg }));
    relay.add("omp", "codex");

    relay.removeForLabel("omp");

    relay.onTurnComplete("omp", "text");
    assert.strictEqual(fwd.length, 0, "forwarding should stop after source removed");
  });

  it("removeForLabel disables forwarding to removed target", () => {
    const fwd = [];
    const relay = createRelayRegistry((to, msg) => fwd.push({ to, msg }));
    relay.add("omp", "codex");

    relay.removeForLabel("codex");

    relay.onTurnComplete("omp", "text");
    assert.strictEqual(fwd.length, 0, "forwarding should stop after target removed");
  });
});
