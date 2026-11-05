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

  it("masks an API key passed as an HTTP header inside a tool command", () => {
    // The shape Clara's exec calls had in Live: curl with the key written into the header.
    const key = "a1b2c3d4-e5f6-4711-8899-aabbccddeeff";
    const params = { command: `curl -s -H "x-api-key: ${key}" https://rest.logentries.com/management/logs | head -50` };

    const out = redactForLog(params);

    expect(out).not.toContain(key);
    expect(out).toContain(`x-api-key: ${REDACTED}`);
    expect(out).toContain("https://rest.logentries.com/management/logs | head -50"); // the rest stays readable
  });

  it("masks a key that starts with digits (a number followed by more characters isn't a count)", () => {
    expect(redactText(`curl -H "x-api-key: 12345678-e5f6-4711-8899-aabbccddeeff" https://x`))
      .toBe(`curl -H "x-api-key: ${REDACTED}" https://x`);
    expect(redactText("api_key=1234abcd5678")).toBe(`api_key=${REDACTED}`);
    expect(redactText("token: 42.secretpart")).toBe(`token: ${REDACTED}`);
  });

  it("masks credential-named key=value and key: value pairs in free text", () => {
    expect(redactText("X-API-Key: sk_live_0123456789")).toBe(`X-API-Key: ${REDACTED}`);
    expect(redactText("GET /v1/items?api_key=abc123def456&page=2")).toBe(`GET /v1/items?api_key=${REDACTED}&page=2`);
    expect(redactText("PGPASSWORD=hunter2 psql -h db")).toBe(`PGPASSWORD=${REDACTED} psql -h db`);
    expect(redactText("client_secret: 9f8e7d6c5b4a")).toBe(`client_secret: ${REDACTED}`);
  });

  it("masks Basic credentials and SAS signatures", () => {
    expect(redactText("Authorization: Basic dXNlcjpwYXNzd29yZA==")).toBe(`Authorization: Basic ${REDACTED}`);
    expect(redactText("https://acct.blob.core.windows.net/c/b.png?sv=2024-01-01&sp=rw&sig=AbC%2Bdef123456789xyz%3D&se=2026"))
      .toBe(`https://acct.blob.core.windows.net/c/b.png?sv=2024-01-01&sp=rw&sig=${REDACTED}&se=2026`);
  });

  it("leaves env-var references, counts and already-redacted values alone", () => {
    expect(redactText(`curl -H "x-api-key: $LOGS_API_KEY" https://x`)).toBe(`curl -H "x-api-key: $LOGS_API_KEY" https://x`);
    expect(redactText("max_tokens: 4096, input_tokens=512")).toBe("max_tokens: 4096, input_tokens=512");
    expect(redactForLog({ apiKey: "sk-live-1234" })).toBe(`{"apiKey":"${REDACTED}"}`);
    expect(redactText(`--token '${REDACTED}'`)).toBe(`--token '${REDACTED}'`);
  });

  it("leaves a harmless line untouched and caps a huge one", () => {
    expect(redactForLog({ path: "~/.openclaw/skills/healthcheck/SKILL.md" })).toBe('{"path":"~/.openclaw/skills/healthcheck/SKILL.md"}');

    const big = redactForLog({ text: "x".repeat(5000) }, 100);
    expect(big.length).toBeLessThan(140);
    expect(big).toMatch(/…\(\d+ more\)$/);
  });
});
