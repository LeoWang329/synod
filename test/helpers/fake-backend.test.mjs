import { describe, it } from "node:test";
import assert from "node:assert";
import { FakeSession, fakeOpenBackend } from "./fake-backend.mjs";

describe("FakeSession", () => {
  it("emits deltas and status events on send", async () => {
    const session = new FakeSession({ deltas: ["Hello ", "world"] });

    const deltas = [];
    const statuses = [];
    session.on("delta", (d) => deltas.push(d));
    session.on("status", (s) => statuses.push(s));

    await session.send("hello");

    assert.deepStrictEqual(deltas, ["Hello ", "world"]);
    assert.ok(statuses.length >= 2, "should emit at least running and idle");
    assert.strictEqual(statuses[0].status, "running");
    assert.strictEqual(statuses[0].isStreaming, true);
    // Last should be idle
    const last = statuses[statuses.length - 1];
    assert.strictEqual(last.status, "idle");
    assert.strictEqual(last.isStreaming, false);
  });

  it("send(wait:true) resolves with text and recent_events", async () => {
    const session = new FakeSession({ deltas: ["part1", "part2"] });

    const res = await session.send("task", { wait: true });

    assert.strictEqual(res.text, "part1part2");
    assert.strictEqual(res.session.agent, "omp");
    assert.strictEqual(res.session.status, "idle");

    // recent_events should contain agent_start, message_update deltas, agent_end, status events
    assert.ok(Array.isArray(res.recent_events));
    assert.ok(res.recent_events.length >= 4, "should have at least agent_start, 2 deltas, agent_end");
    const types = res.recent_events.map((r) => r.event.type);
    assert.ok(types.includes("agent_start"), "should include agent_start");
    assert.ok(types.includes("message_update"), "should include message_update");
    assert.ok(types.includes("agent_end"), "should include agent_end");
  });

  it("close() sets _closed flag and returns {closed:true}", async () => {
    const session = new FakeSession();

    const res = session.close();

    assert.strictEqual(res.closed, true);
    assert.strictEqual(res.session_id, session.id);
    assert.strictEqual(session._closed, true);
    assert.strictEqual(session.status, "closed");
  });

  it("consecutive sends reset text per turn", async () => {
    const session = new FakeSession({ deltas: ["A", "B"] });

    await session.send("first");
    assert.strictEqual(session.lastAssistantText, "AB");
    assert.strictEqual(session.turnCount, 1);

    // Second send: text should be just from this round (AB), not accumulated (ABAB)
    await session.send("second");
    assert.strictEqual(session.lastAssistantText, "AB");
    assert.strictEqual(session.turnCount, 2);

    assert.strictEqual(session._sentMessages.length, 2);
  });

  it("same session/id is reused across sends", async () => {
    const session = new FakeSession({ deltas: ["X"] });
    const sid = session.id;
    await session.send("first");
    await session.send("second");
    assert.strictEqual(session.id, sid, "session id should not change");
    assert.strictEqual(session._sentMessages.length, 2);
  });

  it("failPrompt: send rejects with simulated prompt failure", async () => {
    const session = new FakeSession({ failPrompt: true });

    await assert.rejects(
      () => session.send("boom"),
      /simulated prompt failure/,
    );
  });

  it("send rejects on empty message", async () => {
    const session = new FakeSession();

    await assert.rejects(
      () => session.send(""),
      /message is required/,
    );

    await assert.rejects(
      () => session.send("   "),
      /message is required/,
    );

    await assert.rejects(
      () => session.send(null),
      /message is required/,
    );
  });

  it("fakeOpenBackend returns a ready FakeSession with opts applied", async () => {
    const session = await fakeOpenBackend({
      agent: "omp",
      model: "test-model",
      effort: "high",
      deltas: ["X"],
      text: "pre-filled",
    });

    assert.strictEqual(session.agent, "omp");
    assert.strictEqual(session.model, "test-model");
    assert.strictEqual(session.effort, "high");
    assert.strictEqual(session.status, "idle");
    assert.strictEqual(session.lastAssistantText, "pre-filled");
    assert.strictEqual(session._opened, true);
  });
});
