import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventType } from "@ag-ui/core";

vi.mock("openclaw/plugin-sdk/plugin-entry", () => ({
  emptyPluginConfigSchema: () => ({}),
}));

import { handleModelCallEnded, handleLlmOutput, MODEL_REPORT_EVENT } from "../index.js";
import { setWriter, clearWriter, setRunSession, clearRunSession, clearModelUsage } from "./tool-store.js";

const session = "agent:main:main:user:merchant-PRO-1:thread:t1";

// Shapes as OpenClaw 2026.9.7 sends them (captured from a real run): model_call_ended has the session
// key on the event and no usage; llm_output has usage totals and the session key only on the context.
const callEnded = (over: Record<string, unknown> = {}) => ({
  runId: "run-1",
  callId: "run-1:model:1",
  sessionKey: session,
  provider: "anthropic",
  model: "claude-opus-5-5",
  outcome: "completed",
  durationMs: 242,
  ...over,
});
const llmOutput = (over: Record<string, unknown> = {}) => ({
  runId: "run-1",
  provider: "anthropic",
  model: "claude-opus-5-5",
  resolvedRef: "anthropic/claude-opus-5-5",
  usage: { input: 1300, output: 70, cacheRead: 200, cacheWrite: 0, total: 1570, cost: { total: 0.0123 } },
  ...over,
});

describe("model report (CUSTOM openclaw.model)", () => {
  let events: Array<Record<string, unknown>>;

  beforeEach(() => {
    events = [];
    clearModelUsage("run-1");
    setWriter(session, (e) => events.push(e), "m1");
    setRunSession("run-1", session);
  });

  it("names the model after each call, then adds the run's usage and cost from llm_output", () => {
    handleModelCallEnded(callEnded(), {});
    handleModelCallEnded(callEnded({ callId: "run-1:model:2" }), {});
    handleLlmOutput(llmOutput(), { runId: "run-1", sessionKey: session.toLowerCase() });

    expect(events.map((e) => e.type)).toEqual([EventType.CUSTOM, EventType.CUSTOM, EventType.CUSTOM]);
    expect(events[0]).toEqual({
      type: EventType.CUSTOM,
      name: MODEL_REPORT_EVENT,
      value: { provider: "anthropic", model: "claude-opus-5-5", ref: "anthropic/claude-opus-5-5", calls: 1, usage: null, costUsd: null },
    });
    expect(events[2]).toEqual({
      type: EventType.CUSTOM,
      name: MODEL_REPORT_EVENT,
      value: {
        provider: "anthropic",
        model: "claude-opus-5-5",
        ref: "anthropic/claude-opus-5-5",
        calls: 2,
        usage: { input: 1300, output: 70, cacheRead: 200, cacheWrite: 0 },
        costUsd: 0.0123,
      },
    });
  });

  it("names the last completed call's model when a run falls back to another model", () => {
    handleModelCallEnded(callEnded({ outcome: "error" }), {});
    handleModelCallEnded(callEnded({ model: "claude-sonnet-4-6" }), {});

    expect(events).toHaveLength(1);
    expect((events[0].value as { ref: string; calls: number }).ref).toBe("anthropic/claude-sonnet-4-6");
    expect((events[0].value as { calls: number }).calls).toBe(1);
  });

  it("finds the writer by run id when neither event nor context carries a session key", () => {
    handleModelCallEnded(callEnded({ sessionKey: undefined }), { runId: "run-1" });
    handleLlmOutput(llmOutput(), { runId: "run-1" });

    expect(events).toHaveLength(2);
    expect((events[1].value as { usage: unknown }).usage).toEqual({ input: 1300, output: 70, cacheRead: 200, cacheWrite: 0 });
  });

  it("keeps the usage already reported when a later llm_output has none, and treats missing numbers as 0", () => {
    handleLlmOutput(llmOutput({ usage: { input: 5 } }), { sessionKey: session });
    handleLlmOutput(llmOutput({ usage: undefined }), { sessionKey: session });

    expect((events[0].value as { usage: unknown }).usage).toEqual({ input: 5, output: 0, cacheRead: 0, cacheWrite: 0 });
    expect((events[1].value as { usage: unknown }).usage).toEqual({ input: 5, output: 0, cacheRead: 0, cacheWrite: 0 });
    expect((events[1].value as { costUsd: unknown }).costUsd).toBeNull();
  });

  it("does nothing without a writer, a model, or a run", () => {
    clearWriter(session);
    clearRunSession("run-1");
    handleModelCallEnded(callEnded(), {});
    handleLlmOutput(llmOutput(), { sessionKey: session });
    setWriter(session, (e) => events.push(e), "m1");
    handleModelCallEnded(callEnded({ model: undefined }), {});
    handleModelCallEnded(callEnded({ runId: undefined, sessionKey: undefined }), {});
    handleLlmOutput(llmOutput({ runId: undefined }), {});

    expect(events).toHaveLength(0);
  });
});
