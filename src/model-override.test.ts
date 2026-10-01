import { describe, it, expect, vi } from "vitest";

vi.mock("openclaw/plugin-sdk/plugin-entry", () => ({
  emptyPluginConfigSchema: () => ({}),
}));

import { handleBeforeModelResolve } from "../index.js";
import { resolveModelOverrideHeader } from "./http-handler.js";
import { setModelOverride, clearModelOverride } from "./tool-store.js";

describe("X-OpenClaw-Model header", () => {
  it.each([
    "anthropic/claude-opus-5-5",
    "anthropic/claude-sonnet-4-6",
    "openai/gpt-5.6-luna",
    "ollama/llama3.3:8b",
  ])("accepts the provider/model ref %s", (ref) => {
    expect(resolveModelOverrideHeader(ref)).toBe(ref);
    expect(resolveModelOverrideHeader(`  ${ref}  `)).toBe(ref);
  });

  it.each([
    [undefined],
    [""],
    ["claude-opus-5-5"],                  // no provider
    ["anthropic/"],                       // no model
    ["Anthropic/claude-opus-5-5"],        // provider ids are lowercase
    ["anthropic/claude opus"],            // whitespace inside
    ["anthropic/claude-opus-5-5\nx: y"],  // header smuggling
    [["anthropic/claude-opus-5-5"]],      // repeated header
  ])("ignores %j", (value) => {
    expect(resolveModelOverrideHeader(value as string | string[] | undefined)).toBeUndefined();
  });
});

describe("before_model_resolve", () => {
  const session = "agent:main:main:user:merchant-PRO-1:thread:t1";

  it("returns the run's model, split into provider and model", () => {
    setModelOverride("run-1", session, "anthropic/claude-sonnet-4-6");

    expect(handleBeforeModelResolve({}, { runId: "run-1", sessionKey: session })).toEqual({
      providerOverride: "anthropic",
      modelOverride: "claude-sonnet-4-6",
    });
    clearModelOverride("run-1");
  });

  it("keeps overlapping runs apart: each sees its own choice, and one ending leaves the other", () => {
    setModelOverride("run-a", session, "anthropic/claude-sonnet-4-6");
    setModelOverride("run-b", session, "anthropic/claude-opus-5-5");

    clearModelOverride("run-b"); // run B's request ends first
    expect(handleBeforeModelResolve({}, { runId: "run-a", sessionKey: session })?.modelOverride).toBe("claude-sonnet-4-6");
    clearModelOverride("run-a");
  });

  it("gives a queued follow-up the session's latest choice after its request has ended", () => {
    setModelOverride("run-a", session, "anthropic/claude-sonnet-4-6");
    setModelOverride("run-b", session, "anthropic/claude-haiku-4-5");
    clearModelOverride("run-b"); // B was queued: its request returned at once

    // OpenClaw runs B's message later, under a run with no entry of its own; session keys arrive lowercased.
    expect(handleBeforeModelResolve({}, { runId: "follow-up", sessionKey: session.toLowerCase() })?.modelOverride)
      .toBe("claude-haiku-4-5");
    clearModelOverride("run-a");
  });

  it("a request without the header resets its session to the default", () => {
    setModelOverride("run-1", session, "anthropic/claude-sonnet-4-6");
    clearModelOverride("run-1");
    setModelOverride("run-2", session, undefined);

    expect(handleBeforeModelResolve({}, { runId: "run-2", sessionKey: session })).toBeUndefined();
    expect(handleBeforeModelResolve({}, { runId: "follow-up", sessionKey: session })).toBeUndefined();
  });

  it("drops a session's choice once it has been idle for an hour", () => {
    const t0 = 1_000_000;
    setModelOverride("run-old", "agent:main:main:idle", "anthropic/claude-sonnet-4-6", t0);
    clearModelOverride("run-old");
    setModelOverride("run-new", "agent:main:main:other", "anthropic/claude-opus-5-5", t0 + 61 * 60 * 1000);

    expect(handleBeforeModelResolve({}, { sessionKey: "agent:main:main:idle" })).toBeUndefined();
    clearModelOverride("run-new");
  });

  it("leaves the configured model alone without an override", () => {
    expect(handleBeforeModelResolve({}, {})).toBeUndefined();
    expect(handleBeforeModelResolve({}, { runId: "nothing", sessionKey: "agent:main:main:none" })).toBeUndefined();
  });
});
