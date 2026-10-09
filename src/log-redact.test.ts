import { describe, it, expect } from "vitest";
import { redactForLog, redactText, REDACTED } from "./log-redact.js";

const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJtZXJjaElkIjoiNDIifQ.abcdefghijklmnopqrstuvwxyz0123456789";

describe("redactForLog", () => {
  it("masks a credential passed as a CLI flag inside a tool command", () => {
    const params = { command: `python3 scripts/orders.py get-order --token '${jwt}' --order-id 7285` };

    const out = redactForLog(params);

    expect(out).not.toContain(jwt);
    expect(out).toContain(`--token '${REDACTED}`);
    expect(out).toContain("--order-id 7285"); // non-secret arguments stay readable
  });

  it("masks token handles, bearer headers and bare JWTs", () => {
    expect(redactText("--token-handle 0123456789abcdef0123456789abcdef x")).toBe(`--token-handle ${REDACTED} x`);
    expect(redactText("Authorization: Bearer abc.def.ghi-jkl")).toBe(`Authorization: Bearer ${REDACTED}`);
    expect(redactText(`saw ${jwt} in text`)).toBe(`saw ${REDACTED} in text`);
  });

  it("masks credential-named JSON fields but not ordinary ones", () => {
    const out = redactForLog({ apiKey: "sk-live-1234", password: "hunter2", refresh_token: "r1", orderId: "7285", note: "no secret here" });

    expect(out).toBe(
      `{"apiKey":"${REDACTED}","password":"${REDACTED}","refresh_token":"${REDACTED}","orderId":"7285","note":"no secret here"}`,
    );
  });

  it("leaves a harmless line untouched and caps a huge one", () => {
    expect(redactForLog({ path: "~/.openclaw/skills/healthcheck/SKILL.md" })).toBe('{"path":"~/.openclaw/skills/healthcheck/SKILL.md"}');

    const big = redactForLog({ text: "x".repeat(5000) }, 100);
    expect(big.length).toBeLessThan(140);
    expect(big).toMatch(/…\(\d+ more\)$/);
  });
});
