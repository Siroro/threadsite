import type { Client } from "discord.js";
import { config } from "./config.js";
import type { IncidentRecord } from "./logger.js";
import { log, redactText } from "./logger.js";
import { truncate } from "./util.js";

export class AdminReporter {
  constructor(private readonly client: Client) {}

  async notify(incident: IncidentRecord): Promise<boolean> {
    if (!config.errorDmEnabled || config.errorReportUserIds.size === 0) return false;
    let sent = false;
    for (const userId of config.errorReportUserIds) {
      try {
        const user = await this.client.users.fetch(userId);
        // Build the sections that must always arrive first, then let context
        // fill whatever room is left: a hard slice over the joined body would
        // cut the error, cause and stack — the reason the DM exists — whenever
        // the context block alone is longer than the remaining budget.
        const head = `🚨 **ThreadSite ${incident.id}**\nTime: ${incident.timestamp}`;
        const errorSection = `\nError:\n\`${truncate(redactText(incident.message), 800)}\``;
        const detailsSection = incident.details ? `\nCause/details:\n\`\`\`json\n${truncate(redactText(formatValue(incident.details)), 650)}\n\`\`\`` : "";
        const stackSection = incident.stack ? `\nStack (trimmed):\n\`\`\`\n${truncate(redactText(incident.stack), 420)}\n\`\`\`` : "";
        const contextBudget = Math.max(0, 1900 - head.length - errorSection.length - detailsSection.length - stackSection.length);
        let context = "";
        for (const [key, value] of Object.entries(incident.context)) {
          if (value === undefined || value === null || value === "") continue;
          const line = `${key}: ${truncate(redactText(formatValue(value)), 220)}`;
          const room = contextBudget - context.length - (context ? 1 : 0) - line.length;
          if (room < 0) {
            // Keep at least a truncated first entry so the DM always names
            // some context, and stop at the first line that no longer fits.
            if (!context) context = truncate(line, Math.max(0, contextBudget));
            break;
          }
          context = context ? `${context}\n${line}` : line;
        }
        const body = [head, context ? `\n${context}` : "", errorSection, detailsSection, stackSection].filter(Boolean).join("\n");
        await user.send(truncate(body, 1950));
        sent = true;
      } catch (error) {
        log("warn", "discord.admin_dm_failed", { userId, incidentId: incident.id, error: String(error) });
      }
    }
    return sent;
  }
}

function formatValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
