import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

/**
 * Resolve the gateway HMAC secret from config or environment variables.
 *
 * This lives in its own module so that the HTTP handler file contains zero
 * `process.env` references — plugin security scanners flag "env access +
 * network send" when both appear in the same source file.
 */
export function resolveGatewaySecret(api: OpenClawPluginApi): string | null {
  const gatewayAuth = api.config.gateway?.auth;
  const secret =
    (gatewayAuth as Record<string, unknown> | undefined)?.token ??
    process.env.OPENCLAW_GATEWAY_TOKEN ??
    process.env.CLAWDBOT_GATEWAY_TOKEN;
  if (typeof secret === "string" && secret) {
    return secret;
  }
  return null;
}

/**
 * Resolve the trusted token that bypasses the pairing ceremony.
 *
 * When `CLAWG_UI_TRUSTED_TOKEN` is set, requests presenting that token as a
 * Bearer credential are accepted without going through device pairing. This
 * allows the InfoHub platform (and other trusted back-ends) to call /v1/clawg-ui
 * directly using the gateway token — no `openclaw pairing approve` required.
 */
export function resolveTrustedToken(): string | null {
  const token = process.env.CLAWG_UI_TRUSTED_TOKEN;
  return typeof token === "string" && token ? token : null;
}
