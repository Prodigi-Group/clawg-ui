import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";
import type { Command } from "commander";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk/plugin-entry";
import { randomUUID } from "node:crypto";
import { EventType } from "@ag-ui/core";
import { aguiChannelPlugin } from "./src/channel.js";
import {
  createAguiHttpHandler,
  createOperatorAguiHttpHandler,
} from "./src/http-handler.js";
import { clawgUiToolFactory } from "./src/client-tools.js";
import { redactForLog } from "./src/log-redact.js";
import {
  getWriter,
  getMessageId,
  getModelOverride,
  getRunSession,
  recordModelCall,
  recordRunUsage,
  pushToolCallId,
  popToolCallId,
  isClientTool,
  setClientToolCalled,
  type ModelCallUsage,
  type RunModelUsage,
} from "./src/tool-store.js";
import {
  extractToolResultText,
  tryParseA2UIOperations,
  groupBySurface,
  A2UI_OPERATIONS_KEY,
} from "./src/a2ui.js";

// ---------------------------------------------------------------------------
// Hook handlers — exported for testability
// ---------------------------------------------------------------------------

export interface BeforeToolCallEvent {
  toolName: string;
  params?: Record<string, unknown>;
}

export interface ToolCallContext {
  sessionKey?: string;
}

/**
 * Handles the `before_tool_call` OpenClaw hook.
 * Emits TOOL_CALL_START + TOOL_CALL_ARGS (and TOOL_CALL_END for client tools).
 */
export function handleBeforeToolCall(
  event: BeforeToolCallEvent,
  ctx: ToolCallContext,
): void {
  const sk = ctx.sessionKey;
  console.log(
    `[clawg-ui] before_tool_call: tool=${event.toolName}, sessionKey=${sk ?? "none"}, hasParams=${!!(event.params && Object.keys(event.params).length > 0)}, params=${redactForLog(event.params ?? {})}`,
  );
  if (!sk) {
    console.log(`[clawg-ui] before_tool_call: skipping, no sessionKey`);
    return;
  }
  const writer = getWriter(sk);
  if (!writer) {
    console.log(
      `[clawg-ui] before_tool_call: skipping, no writer for sessionKey=${sk}`,
    );
    return;
  }
  const toolCallId = `tool-${randomUUID()}`;
  console.log(
    `[clawg-ui] before_tool_call: emitting TOOL_CALL_START, toolCallId=${toolCallId}`,
  );
  writer({
    type: EventType.TOOL_CALL_START,
    toolCallId,
    toolCallName: event.toolName,
  });
  if (event.params && Object.keys(event.params).length > 0) {
    console.log(
      `[clawg-ui] before_tool_call: emitting TOOL_CALL_ARGS, params=${redactForLog(event.params)}`,
    );
    writer({
      type: EventType.TOOL_CALL_ARGS,
      toolCallId,
      delta: JSON.stringify(event.params),
    });
  }

  if (isClientTool(sk, event.toolName)) {
    // Client tool: emit TOOL_CALL_END now. The run will finish and the
    // client initiates a new run with the tool result.
    console.log(
      `[clawg-ui] before_tool_call: client tool detected, emitting TOOL_CALL_END immediately`,
    );
    writer({
      type: EventType.TOOL_CALL_END,
      toolCallId,
    });
    setClientToolCalled(sk);
  } else {
    // Server tool: push ID so tool_result_persist can emit
    // TOOL_CALL_RESULT + TOOL_CALL_END after execute() completes.
    console.log(
      `[clawg-ui] before_tool_call: server tool, pushing toolCallId to stack`,
    );
    pushToolCallId(sk, toolCallId);
  }
}

/**
 * Handles the `tool_result_persist` OpenClaw hook.
 * Emits TOOL_CALL_RESULT + TOOL_CALL_END for server-side tools.
 */
export function handleToolResultPersist(
  event: Record<string, unknown>,
  ctx: ToolCallContext,
): void {
  const sk = ctx.sessionKey;
  console.log(
    `[clawg-ui] tool_result_persist: sessionKey=${sk ?? "none"}, event=${redactForLog(event)}`,
  );
  if (!sk) {
    console.log(
      `[clawg-ui] tool_result_persist: skipping, no sessionKey`,
    );
    return;
  }
  const writer = getWriter(sk);
  const toolCallId = popToolCallId(sk);
  const messageId = getMessageId(sk);
  console.log(
    `[clawg-ui] tool_result_persist: writer=${writer ? "present" : "missing"}, toolCallId=${toolCallId ?? "none"}, messageId=${messageId ?? "none"}`,
  );
  if (writer && toolCallId && messageId) {
    // Extract actual tool result text from event.message.content
    const msg = (event as Record<string, unknown>).message as
      | { content?: unknown }
      | undefined;
    const resultText = msg?.content
      ? extractToolResultText(msg.content)
      : "";

    console.log(
      `[clawg-ui] tool_result_persist: emitting TOOL_CALL_RESULT and TOOL_CALL_END`,
    );
    // Use a dedicated messageId for the tool result so it doesn't collide
    // with the text message messageId. Tool events are linked via toolCallId.
    const toolResultMessageId = `msg-tool-${toolCallId}`;
    writer({
      type: EventType.TOOL_CALL_RESULT,
      toolCallId,
      messageId: toolResultMessageId,
      content: resultText,
    });

    // Detect A2UI and emit ACTIVITY_SNAPSHOT per surface
    const a2uiOps = tryParseA2UIOperations(resultText);
    if (a2uiOps) {
      const groups = groupBySurface(a2uiOps);
      for (const [surfaceId, ops] of groups) {
        writer({
          type: EventType.ACTIVITY_SNAPSHOT,
          messageId: `a2ui-surface-${surfaceId}-${toolCallId}`,
          activityType: "a2ui-surface",
          content: { [A2UI_OPERATIONS_KEY]: ops },
          replace: true,
        });
      }
    }

    writer({
      type: EventType.TOOL_CALL_END,
      toolCallId,
    });
  }
}

/**
 * before_model_resolve: use the model the trusted proxy chose (X-OpenClaw-Model) — this run's own
 * choice, else the latest one sent for its session (a queued follow-up's request has already ended).
 * Returns nothing otherwise, so the agent's configured model applies.
 */
export function handleBeforeModelResolve(
  _event: unknown,
  ctx: { runId?: string; sessionKey?: string },
): { providerOverride: string; modelOverride: string } | undefined {
  const ref = getModelOverride(ctx.runId, ctx.sessionKey);
  if (!ref) return undefined;
  const slash = ref.indexOf("/");
  return { providerOverride: ref.slice(0, slash), modelOverride: ref.slice(slash + 1) };
}

/** Name of the AG-UI CUSTOM event that reports the run's model and usage to the proxy. */
export const MODEL_REPORT_EVENT = "openclaw.model";

export interface ModelCallEndedEvent {
  runId?: string;
  sessionKey?: string;
  provider?: string;
  model?: string;
  outcome?: string; // "completed" | "error"
}

export interface LlmOutputEvent {
  runId?: string;
  sessionKey?: string;
  provider?: string;
  model?: string;
  usage?: ModelCallUsage & { total?: number; cost?: { total?: number } };
}

type HookContext = { runId?: string; sessionKey?: string };

function emitModelReport(sk: string, totals: RunModelUsage): void {
  const writer = getWriter(sk);
  if (!writer) return;
  writer({
    type: EventType.CUSTOM,
    name: MODEL_REPORT_EVENT,
    value: {
      provider: totals.provider,
      model: totals.model,
      ref: `${totals.provider}/${totals.model}`,
      calls: totals.calls,
      usage: totals.usage,
      costUsd: totals.costUsd,
    },
  });
}

/**
 * model_call_ended: tell the proxy which model answered. OpenClaw fires this at the end of every
 * model call in a run — a tool loop makes several — naming the provider/model that actually ran
 * (the X-OpenClaw-Model override, the agent's default, or a fallback it fell to). It carries no
 * token usage; that comes from llm_output. Emitted as a CUSTOM event the proxies record on the
 * interaction and withhold from browsers; the stream is still open, as the run hasn't finished.
 * Failed calls are skipped: the model that answered is the one of the last completed call.
 */
export function handleModelCallEnded(event: ModelCallEndedEvent, ctx: HookContext): void {
  if (event.outcome === "error") return;
  const runId = event.runId ?? ctx.runId;
  const sk = event.sessionKey ?? ctx.sessionKey ?? getRunSession(runId);
  if (!runId || !sk || !event.provider || !event.model) return;
  emitModelReport(sk, recordModelCall(runId, event.provider, event.model));
}

/**
 * llm_output: add the run's token usage (and OpenClaw's cost estimate) to the report. OpenClaw fires
 * this once per run attempt as it finalizes, with the attempt's usage totals; it lands before the
 * reply's TEXT_MESSAGE_END, so the writer is still open. It is a conversation hook, so it needs
 * plugins.entries.clawg-ui.hooks.allowConversationAccess — without it the model is still reported,
 * just not the tokens. The event names no session key; the hook context does.
 */
export function handleLlmOutput(event: LlmOutputEvent, ctx: HookContext): void {
  const runId = event.runId ?? ctx.runId;
  const sk = event.sessionKey ?? ctx.sessionKey ?? getRunSession(runId);
  if (!runId || !sk || !event.provider || !event.model) return;
  emitModelReport(sk, recordRunUsage(runId, event.provider, event.model, event.usage, event.usage?.cost?.total));
}

const plugin: {
  id: string;
  name: string;
  description: string;
  configSchema: ReturnType<typeof emptyPluginConfigSchema>;
  register: (api: OpenClawPluginApi) => void;
} = {
  id: "clawg-ui",
  name: "CLAWG-UI",
  description: "AG-UI protocol endpoint for CopilotKit and HttpAgent clients",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    api.registerChannel({ plugin: aguiChannelPlugin });
    api.registerTool(clawgUiToolFactory);
    // Example tools (not published to npm — live in examples/)
    import("./examples/cron-report-tool.js")
      .then(({ cronReportToolFactory }) => {
        api.registerTool(cronReportToolFactory, { name: "cron_report", optional: true });
      })
      .catch(() => {
        // examples/ not available (npm install) — skip
      });

    // OpenClaw 2026.9 ties HTTP routes to the plugin's registration lifetime: register them
    // here, synchronously, through the plugin API. (Earlier versions needed the
    // plugin-sdk/plugin-runtime registerPluginHttpRoute workaround, because api.registerHttpRoute
    // wrote to a registry the HTTP server didn't read. 2026.9 no longer exports it there.)
    api.registerHttpRoute({
      path: "/v1/clawg-ui",
      auth: "plugin",
      match: "exact",
      handler: createAguiHttpHandler(api),
    });
    // Operator-auth AG-UI route — for OpenClaw operator-UI embedded
    // consumers (plugin-contributed `chat.surface` slot, etc.) that
    // already hold a gateway token and shouldn't need a second pairing
    // dance. Gateway validates operator scope before our handler runs.
    api.registerHttpRoute({
      path: "/v1/clawg-ui/operator",
      auth: "gateway",
      match: "exact",
      handler: createOperatorAguiHttpHandler(api),
    });

    api.on("before_tool_call", handleBeforeToolCall);
    api.on("before_model_resolve", handleBeforeModelResolve);
    api.on("model_call_ended", handleModelCallEnded);
    api.on("llm_output", handleLlmOutput);
    api.on("tool_result_persist", handleToolResultPersist);

    // CLI commands for device management
    api.registerCli(
      ({ program }: { program: Command }) => {
        const clawgUi = program
          .command("clawg-ui")
          .description("CLAWG-UI (AG-UI) channel commands");

        clawgUi
          .command("devices")
          .description("List approved devices")
          .action(async () => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK types lag behind runtime
            const devices = await (api.runtime.channel.pairing.readAllowFromStore as (arg: any) => Promise<string[]>)({ channel: "clawg-ui" });
            if (devices.length === 0) {
              console.log("No approved devices.");
              return;
            }
            console.log("Approved devices:");
            for (const deviceId of devices) {
              console.log(`  ${deviceId}`);
            }
          });
      },
      { commands: ["clawg-ui"] },
    );
  },
};

export default plugin;
