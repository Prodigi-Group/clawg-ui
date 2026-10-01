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
  it("returns the run's model, split into provider and model", () => {
    const sessionKey = "agent:main:main:user:merchant-PRO-1:thread:t1";
    setModelOverride(sessionKey, "anthropic/claude-sonnet-4-6");

    // OpenClaw hands plugins the lowercased session key.
    expect(handleBeforeModelResolve({}, { sessionKey: sessionKey.toLowerCase() })).toEqual({
      providerOverride: "anthropic",
      modelOverride: "claude-sonnet-4-6",
    });

    clearModelOverride(sessionKey);
    expect(handleBeforeModelResolve({}, { sessionKey })).toBeUndefined();
  });

  it("leaves the configured model alone without a session or an override", () => {
    expect(handleBeforeModelResolve({}, {})).toBeUndefined();
    expect(handleBeforeModelResolve({}, { sessionKey: "agent:main:main:no-override" })).toBeUndefined();
  });
});
