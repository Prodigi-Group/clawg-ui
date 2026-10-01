import type { EventType, Tool } from "@ag-ui/core";

export type EventWriter = (event: { type: EventType } & Record<string, unknown>) => void;

/**
 * Per-session store for:
 * 1. AG-UI client-provided tools (read by the plugin tool factory)
 * 2. SSE event writer (read by before/after_tool_call hooks)
 *
 * Fully reentrant — concurrent requests use different session keys.
 */
// OpenClaw lowercases session keys before passing them to plugins (tool factory ctx, hook ctx),
// but the HTTP handler stores state under the key it resolved itself. Every map below is keyed
// through this so both sides meet whatever case the key arrives in.
const key = (sessionKey: string): string => sessionKey.toLowerCase();

const toolStore = new Map<string, Tool[]>();
const writerStore = new Map<string, EventWriter>();

// --- Client tools (for the plugin tool factory) ---

export function stashTools(sessionKey: string, tools: Tool[]): void {
  console.log(`[clawg-ui] stashTools: sessionKey=${sessionKey}, toolCount=${tools.length}`);
  for (const t of tools) {
    console.log(`[clawg-ui]   tool: name=${t.name}, description=${t.description ?? "(none)"}, hasParams=${!!t.parameters}, params=${JSON.stringify(t.parameters ?? {})}`);
  }
  toolStore.set(key(sessionKey), tools);
}

export function popTools(sessionKey: string): Tool[] {
  const tools = toolStore.get(key(sessionKey)) ?? [];
  console.log(`[clawg-ui] popTools: sessionKey=${sessionKey}, tools=${tools.length}`);
  toolStore.delete(key(sessionKey));
  return tools;
}

// --- SSE event writer (for before/after_tool_call hooks) ---

const messageIdStore = new Map<string, string>();

export function setWriter(
  sessionKey: string,
  writer: EventWriter,
  messageId: string,
): void {
  writerStore.set(key(sessionKey), writer);
  messageIdStore.set(key(sessionKey), messageId);
}

export function getWriter(sessionKey: string): EventWriter | undefined {
  return writerStore.get(key(sessionKey));
}

export function getMessageId(sessionKey: string): string | undefined {
  return messageIdStore.get(key(sessionKey));
}

export function clearWriter(sessionKey: string): void {
  writerStore.delete(key(sessionKey));
  messageIdStore.delete(key(sessionKey));
}

// --- Pending toolCallId stack (before_tool_call pushes, tool_result_persist pops) ---
// Only used for SERVER-side tools. Client tools emit TOOL_CALL_END in
// before_tool_call and never push to this stack.

const pendingStacks = new Map<string, string[]>();

export function pushToolCallId(sessionKey: string, toolCallId: string): void {
  let stack = pendingStacks.get(key(sessionKey));
  if (!stack) {
    stack = [];
    pendingStacks.set(key(sessionKey), stack);
  }
  stack.push(toolCallId);
  console.log(`[clawg-ui] pushToolCallId: sessionKey=${sessionKey}, toolCallId=${toolCallId}, stackSize=${stack.length}`);
}

export function popToolCallId(sessionKey: string): string | undefined {
  const stack = pendingStacks.get(key(sessionKey));
  const id = stack?.pop();
  console.log(`[clawg-ui] popToolCallId: sessionKey=${sessionKey}, toolCallId=${id ?? "none"}, stackSize=${stack?.length ?? 0}`);
  if (stack && stack.length === 0) {
    pendingStacks.delete(key(sessionKey));
  }
  return id;
}

// --- Client tool name tracking ---
// Tracks which tool names are client-provided so hooks can distinguish them.

const clientToolNames = new Map<string, Set<string>>();

export function markClientToolNames(
  sessionKey: string,
  names: string[],
): void {
  console.log(`[clawg-ui] markClientToolNames: sessionKey=${sessionKey}, names=${names.join(", ")}`);
  clientToolNames.set(key(sessionKey), new Set(names));
}

export function isClientTool(
  sessionKey: string,
  toolName: string,
): boolean {
  const result = clientToolNames.get(key(sessionKey))?.has(toolName) ?? false;
  console.log(`[clawg-ui] isClientTool: sessionKey=${sessionKey}, toolName=${toolName}, result=${result}`);
  return result;
}

export function clearClientToolNames(sessionKey: string): void {
  console.log(`[clawg-ui] clearClientToolNames: sessionKey=${sessionKey}`);
  clientToolNames.delete(key(sessionKey));
}

// --- Tool-fired-in-run flag ---
// Tracks whether any tool call (server or client) was emitted in the current
// run. When a text message is about to be emitted and this flag is set, the
// http-handler splits into a new run so tool events and text events live in
// separate runs (per AG-UI protocol best practice).

const toolFiredInRunFlags = new Map<string, boolean>();

export function setToolFiredInRun(sessionKey: string): void {
  toolFiredInRunFlags.set(key(sessionKey), true);
}

export function wasToolFiredInRun(sessionKey: string): boolean {
  return toolFiredInRunFlags.get(key(sessionKey)) ?? false;
}

export function clearToolFiredInRun(sessionKey: string): void {
  toolFiredInRunFlags.delete(key(sessionKey));
}

// --- Client-tool-called flag ---
// Set when a client tool is invoked during a run so the dispatcher can
// suppress text output and end the run after the tool call events.

const clientToolCalledFlags = new Map<string, boolean>();

export function setClientToolCalled(sessionKey: string): void {
  console.log(`[clawg-ui] setClientToolCalled: sessionKey=${sessionKey}`);
  clientToolCalledFlags.set(key(sessionKey), true);
}

export function wasClientToolCalled(sessionKey: string): boolean {
  const result = clientToolCalledFlags.get(key(sessionKey)) ?? false;
  console.log(`[clawg-ui] wasClientToolCalled: sessionKey=${sessionKey}, result=${result}`);
  return result;
}

export function clearClientToolCalled(sessionKey: string): void {
  console.log(`[clawg-ui] clearClientToolCalled: sessionKey=${sessionKey}`);
  clientToolCalledFlags.delete(key(sessionKey));
}

// --- Per-run model override (X-OpenClaw-Model, from the trusted proxy) ---
// Read by the before_model_resolve hook, so the proxy can choose the model for a run without a
// gateway config change. A "provider/model" ref, e.g. "anthropic/claude-opus-5-5".
//
// Two layers, so overlapping requests on one conversation (a double send, a message typed while
// the last is being answered) can't undo each other:
//  - per run: the request's own choice, looked up by the run id OpenClaw hands the hook, and
//    cleared when that request ends. No other run can overwrite or clear it.
//  - per conversation: the latest choice any request sent for that session. OpenClaw may queue a
//    message that arrives mid-run and run it as a follow-up after its own request has returned;
//    the follow-up then has no run entry, and uses this instead of falling back to the default.
//    Only a newer request replaces it (a request without the header resets it to the default);
//    entries idle for SESSION_MODEL_TTL_MS are dropped.

const runModelOverrides = new Map<string, string>();
const sessionModelOverrides = new Map<string, { ref: string; at: number }>();
const SESSION_MODEL_TTL_MS = 60 * 60 * 1000;

/** Record the model a request chose (undefined = the agent's default) for its run and its session. */
export function setModelOverride(runId: string, sessionKey: string, modelRef: string | undefined, now = Date.now()): void {
  for (const [k, v] of sessionModelOverrides) {
    if (now - v.at > SESSION_MODEL_TTL_MS) sessionModelOverrides.delete(k);
  }
  if (modelRef) {
    runModelOverrides.set(runId, modelRef);
    sessionModelOverrides.set(key(sessionKey), { ref: modelRef, at: now });
  } else {
    runModelOverrides.delete(runId);
    sessionModelOverrides.delete(key(sessionKey));
  }
}

/** The run's own choice, else the latest one sent for its session; undefined = the agent's default. */
export function getModelOverride(runId: string | undefined, sessionKey: string | undefined): string | undefined {
  if (runId) {
    const own = runModelOverrides.get(runId);
    if (own) return own;
  }
  return sessionKey ? sessionModelOverrides.get(key(sessionKey))?.ref : undefined;
}

/** A request ended: drop its run's entry. Its session's latest choice stays for queued follow-ups. */
export function clearModelOverride(runId: string): void {
  runModelOverrides.delete(runId);
}
