import type { FormInfo, SessionMessageInfo } from "@opencode/client";
import type { SessionMessage } from "./opencode-v1.js";
import type { AgentQuestion } from "./progress.js";

/** Normalize at the application boundary; v2 wire types never escape the adapter. */
export function applicationMessage(message: SessionMessageInfo, sessionID: string): SessionMessage {
  const info: NonNullable<SessionMessage["info"]> = {
    id: message.id, sessionID, role: message.type, time: message.time,
  };
  if (message.type === "assistant") {
    Object.assign(info, { role: "assistant", agent: message.agent,
      providerID: message.model.providerID, modelID: message.model.id, variant: message.model.variant,
      model: { providerID: message.model.providerID, modelID: message.model.id, variant: message.model.variant },
      tokens: message.tokens, cost: message.cost, error: message.error,
      // Only an execution-level idle record proves that a v2 turn completed.
      finish: message.finish ? "tool-calls" : undefined,
    });
    return { info, parts: message.content.map((part, index) => part.type === "tool"
      ? { ...part, tool: part.name, callID: part.id, messageID: message.id, sessionID }
      : { ...part, id: `${message.id}:${index}`, messageID: message.id, sessionID }) };
  }
  if (message.type === "user" || message.type === "synthetic") {
    // Synthetic steering is persisted too, so finish-up receipts survive restarts.
    info.role = "user";
    return { info, parts: [{ type: "text", text: message.text }] };
  }
  if (message.type === "idle") {
    Object.assign(info, { role: "assistant", agent: "sitebuilder",
      finish: message.outcome === "succeeded" ? "stop" : "aborted", error: message.error,
      time: { ...message.time, completed: message.time.created } });
  }
  if (message.type === "compaction" && message.status !== "running") {
    Object.assign(info, { role: "assistant", tokens: message.tokens, cost: message.cost });
  }
  return { info, parts: message.type === "compaction" ? [{ type: "compaction", status: message.status }] : [] };
}

export function formQuestion(form: FormInfo): AgentQuestion {
  return {
    requestID: form.id,
    questions: form.fields.filter((field) => !("hidden" in field && field.hidden)).map((field) => ({
      header: (field.title || form.title || "Question").slice(0, 80),
      question: (field.description || field.title || form.title).slice(0, 500),
      multiple: field.type === "multiselect",
      options: ("options" in field ? field.options ?? [] : []).map((option) => ({
        label: option.label, description: option.description,
      })),
    })),
  };
}
