import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventType } from "@ag-ui/core";

vi.mock("openclaw/plugin-sdk/plugin-entry", () => ({
  emptyPluginConfigSchema: () => ({}),
}));

import { handleModelCallEnded, MODEL_REPORT_EVENT } from "../index.js";
import { setWriter, clearWriter, setRunSession, clearRunSession, clearModelUsage } from "./tool-store.js";

const session = "agent:main:main:user:merchant-PRO-1:thread:t1";

describe("model_call_ended -> CUSTOM openclaw.model", () => {
  let events: Array<Record<string, unknown>>;

  beforeEach(() => {
    events = [];
    setWriter(session, (e) => events.push(e), "m1");
    setRunSession("run-1", session);
  });

  const call = (over: Record<string, unknown> = {}) => ({
    type: "model.call.completed",
    runId: "run-1",
    sessionKey: session,
    provider: "anthropic",
    model: "claude-opus-5-5",
    usage: { input: 1000, output: 50, cacheRead: 200, total: 1250 },
    ...over,
  });

  it("reports the model that answered and the run's cumulative usage, once per call", () => {
    handleModelCallEnded(call(), {});
    handleModelCallEnded(call({ usage: { input: 300, output: 20 } }), {});

    expect(events.map((e) => e.type)).toEqual([EventType.CUSTOM, EventType.CUSTOM]);
    expect(events[1]).toEqual({
      type: EventType.CUSTOM,
      name: MODEL_REPORT_EVENT,
      value: {
        provider: "anthropic",
        model: "claude-opus-5-5",
        ref: "anthropic/claude-opus-5-5",
        calls: 2,
        usage: { input: 1300, output: 70, cacheRead: 200, cacheWrite: 0 },
      },
    });
    clearModelUsage("run-1");
  });

  it("names the last completed call's model when a run falls back to another model", () => {
    handleModelCallEnded(call({ type: "model.call.error", usage: undefined }), {});
    handleModelCallEnded(call({ model: "claude-sonnet-4-6", usage: { input: 10, output: 5 } }), {});

    expect(events).toHaveLength(1);
    expect((events[0].value as { ref: string; calls: number }).ref).toBe("anthropic/claude-sonnet-4-6");
    expect((events[0].value as { calls: number }).calls).toBe(1);
    clearModelUsage("run-1");
  });

  it("finds the writer by run id when the event carries no session key, and by a lowercased one", () => {
    handleModelCallEnded(call({ sessionKey: undefined }), { runId: "run-1" });
    handleModelCallEnded(call({ sessionKey: undefined }), { sessionKey: session.toLowerCase() });

    expect(events).toHaveLength(2);
    clearModelUsage("run-1");
  });

  it("does nothing without a writer, a model, or a run", () => {
    clearWriter(session);
    clearRunSession("run-1");
    handleModelCallEnded(call(), {});
    setWriter(session, (e) => events.push(e), "m1");
    handleModelCallEnded(call({ model: undefined }), {});
    handleModelCallEnded(call({ runId: undefined, sessionKey: undefined }), {});

    expect(events).toHaveLength(0);
  });
});
