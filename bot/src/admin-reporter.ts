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
        const context = Object.entries(incident.context)
          .filter(([, value]) => value !== undefined && value !== null && value !== "")
          .slice(0, 12)
          .map(([key, value]) => `${key}: ${truncate(redactText(formatValue(value)), 220)}`)
          .join("\n");
        const body = [
          `🚨 **ThreadSite ${incident.id}**`,
          `Time: ${incident.timestamp}`,
          context ? `\n${context}` : "",
          `\nError:\n\`${truncate(redactText(incident.message), 800)}\``,
          incident.details ? `\nCause/details:\n\`\`\`json\n${truncate(redactText(formatValue(incident.details)), 650)}\n\`\`\`` : "",
          incident.stack ? `\nStack (trimmed):\n\`\`\`\n${truncate(redactText(incident.stack), 420)}\n\`\`\`` : "",
        ].filter(Boolean).join("\n");
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
