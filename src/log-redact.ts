/**
 * Redaction for log lines. clawg-ui logs tool parameters and results, which carry whatever the model
 * put in them — including credentials from its context (a merchant's bearer token in a `--token`
 * argument has ended up in Log Analytics). Everything that goes into a console.log passes through
 * redactForLog first: credential-named JSON fields, credential CLI flags, credential-named
 * `name: value` / `name=value` pairs (HTTP headers such as `x-api-key: …`, query strings, env
 * assignments), Bearer and Basic credentials, SAS signatures and anything shaped like a JWT are
 * masked, and the line is capped so a large tool result doesn't flood the log.
 */

const JSON_FIELD =
  /("(?:[A-Za-z0-9_-]*(?:token|password|passwd|secret|api[-_]?key|authorization|credential)[A-Za-z0-9_-]*)"\s*:\s*")((?:[^"\\]|\\.)*)(")/gi;
const CLI_FLAG =
  /(--?(?:token(?:[-_]handle)?|password|passwd|secret|api[-_]?key|access[-_]?token|refresh[-_]?token|client[-_]?secret)(?:\s+|=))(['"]?)([^\s'"\\]+)/gi;
const BEARER = /\b((?:Bearer|Basic)\s+)[A-Za-z0-9._~+/=-]{8,}/gi;
const JWT = /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g;
// `x-api-key: k`, `api_key=k`, `PGPASSWORD=k`, `client_secret: k`. Skips values that are an env-var
// reference ($NAME), a plain number (max_tokens: 4096), already redacted, or a Bearer/Basic scheme
// (BEARER has masked the credential after it). "Plain number" means the digits are the whole value:
// `12345678-e5f6-…` starts with digits but is a key, so the number must end where the value ends.
const KEY_VALUE =
  /\b([A-Za-z0-9_-]*(?:token|password|passwd|secret|api[-_]?key|authorization|credential)[A-Za-z0-9_-]*\s*[:=]\s*)(?!\$|\[REDACTED\]|(?:Bearer|Basic)\b|\d+(?![^\s"'\\,;&)}\]]))[^\s"'\\,;&)}\]]+/gi;
const SAS_SIG = /([?&]sig=)(?!\[REDACTED\])[^&\s"'\\]+/gi;

export const REDACTED = "[REDACTED]";

/** The text with credentials masked. Pure string in, string out. */
export function redactText(text: string): string {
  return text
    .replace(JSON_FIELD, (_m, key: string, _value: string, quote: string) => `${key}${REDACTED}${quote}`)
    .replace(CLI_FLAG, (_m, flag: string, quote: string) => `${flag}${quote}${REDACTED}`)
    .replace(BEARER, (_m, prefix: string) => `${prefix}${REDACTED}`)
    .replace(JWT, REDACTED)
    .replace(KEY_VALUE, (_m, prefix: string) => `${prefix}${REDACTED}`)
    .replace(SAS_SIG, (_m, prefix: string) => `${prefix}${REDACTED}`);
}

/** JSON.stringify for a log line, redacted and capped (default 2000 characters). */
export function redactForLog(value: unknown, max = 2000): string {
  let text: string;
  try {
    text = typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));
  } catch {
    text = String(value);
  }
  const redacted = redactText(text);
  return redacted.length > max ? `${redacted.slice(0, max)}…(${redacted.length - max} more)` : redacted;
}
