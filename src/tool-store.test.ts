import { describe, it, expect } from "vitest";
import {
  stashTools,
  popTools,
  setWriter,
  getWriter,
  clearWriter,
  markClientToolNames,
  isClientTool,
  clearClientToolNames,
} from "./tool-store.js";

// OpenClaw 2026.9 lowercases session keys before handing them to plugins, while the HTTP handler
// stores state under the key it resolved from the request header.
describe("tool store session keys", () => {
  const stored = "agent:main:main:user:merchant-PRO-12345:thread:t1";
  const fromOpenClaw = stored.toLowerCase();

  it("finds stashed client tools whatever case the key arrives in", () => {
    stashTools(stored, [{ name: "show_menu", description: "menu", parameters: {} }]);
    expect(popTools(fromOpenClaw).map((t) => t.name)).toEqual(["show_menu"]);
    expect(popTools(stored)).toEqual([]);
  });

  it("finds the SSE writer and client tool names from a lowercased key", () => {
    const writer = () => {};
    setWriter(stored, writer, "msg-1");
    markClientToolNames(stored, ["show_menu"]);

    expect(getWriter(fromOpenClaw)).toBe(writer);
    expect(isClientTool(fromOpenClaw, "show_menu")).toBe(true);

    clearWriter(fromOpenClaw);
    clearClientToolNames(fromOpenClaw);
    expect(getWriter(stored)).toBeUndefined();
    expect(isClientTool(stored, "show_menu")).toBe(false);
  });
});
