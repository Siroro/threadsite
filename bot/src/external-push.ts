import { ActionRowBuilder, ButtonBuilder, ButtonStyle, type Client } from "discord.js";
import { config } from "./config.js";
import { cardId } from "./card-actions.js";
import { renderStatusCard } from "./card-ui.js";
import { COMMIT_SHORT_HASH_CHARS } from "./project-identity.js";
import type { ForgejoClient } from "./forgejo.js";
import { log, logError, serializeError } from "./logger.js";
import type { ProjectService } from "./project.js";
import type { Store } from "./store.js";
import type { ProjectRecord } from "./types.js";

/**
 * External-push detection: push-key holders push straight to the repo's main
 * branch, and this monitor turns a foreign commit into one Publish/Dismiss
 * prompt in the project's thread. With webhooks on (default), Forgejo tells
 * the bot the moment it happens; the poller also runs as a safety net for
 * missing hooks, rejected deliveries and lost events.
 */
export interface ExternalPushServices {
  store: Store;
  forgejo: ForgejoClient;
  projects: ProjectService;
  client: Client;
  /** Whether the webhook listener actually bound; false keeps the poller as the only detector. */
  webhooksLive: () => boolean;
}

export interface ExternalPushMonitor {
  startPoller(): void;
  stopPoller(): void;
  ensureWebhooks(): Promise<void>;
  handleForgejoPush(event: { ref?: string; after?: string; repository?: { name?: string } }): Promise<void>;
  recheck(threadId: string): Promise<void>;
}

export function createExternalPushMonitor(services: ExternalPushServices): ExternalPushMonitor {
  const { store, forgejo, projects, client } = services;

  // lastSeenCommit is written only after a successful send, so two deliveries
  // arriving together (a webhook plus the poller, or a retried hook with a new
  // delivery id) would otherwise both reach the thread. The key is
  // thread+commit: a later commit still gets its own prompt.
  const inFlight = new Set<string>();
  let pollTimer: NodeJS.Timeout | undefined;

  function externalPushRow(): ActionRowBuilder<ButtonBuilder> {
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(cardId("extpublish", "external-push")).setLabel("Publish").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(cardId("extdismiss", "external-push")).setLabel("Dismiss").setStyle(ButtonStyle.Secondary),
    );
  }

  function startPoller(): void {
    if (pollTimer || config.externalPushPollMs <= 0) return;
    let scanning = false;
    pollTimer = setInterval(() => {
      if (scanning) return;
      scanning = true;
      void scanForExternalPushes().finally(() => { scanning = false; });
    }, config.externalPushPollMs);
    pollTimer.unref();
  }

  function stopPoller(): void {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = undefined;
  }

  async function scanForExternalPushes(): Promise<void> {
    const candidates = store.listProjects().filter((project) => project.status === "ready" && !project.pendingDeletion);
    for (const project of candidates) {
      try {
        const sha = await forgejo.mainCommitSha(project.repoName);
        if (!sha) continue;
        await notifyExternalPushIfNeeded(project, sha, "poll");
      } catch (error) {
        logError("project.external_push_scan_failed", error, { threadId: project.threadId });
      }
    }
  }

  /**
   * One shared external-push decision for the webhook and the poller. Guards,
   * in order: nothing new on main; a bot turn mid-flight (its own push, or a
   * user push that the post-turn recheck will pick up); and the bot's own
   * commit landing before the store catches up — recognized silently via
   * lastCommit so the thread never gets a bogus "external push" for its own
   * turn. Only a genuinely foreign, fully idle push prompts the thread.
   */
  async function notifyExternalPushIfNeeded(project: ProjectRecord, sha: string, source: "webhook" | "poll" | "recheck"): Promise<void> {
    if (sha === project.lastSeenCommit) return;
    if (project.pendingDeletion || project.pendingTurn || project.pendingRename) return;
    if (await projects.agentBusy(project.threadId).catch(() => true)) return;
    if (project.lastCommit && sha.startsWith(project.lastCommit)) {
      await store.patchProject(project.threadId, { lastSeenCommit: sha });
      return;
    }
    const key = `${project.threadId}:${sha}`;
    if (inFlight.has(key)) return;
    inFlight.add(key);
    try {
      await deliverExternalPushPrompt(project, sha, source);
    } finally {
      inFlight.delete(key);
    }
  }

  async function deliverExternalPushPrompt(project: ProjectRecord, sha: string, source: "webhook" | "poll" | "recheck"): Promise<void> {
    const channel = await client.channels.fetch(project.threadId).catch(() => undefined);
    const thread = channel?.isTextBased() && "send" in channel ? channel : undefined;
    // Mark the commit seen only after the prompt is actually delivered. Patching
    // first meant a failed send (thread deleted, permissions revoked) suppressed
    // the push permanently: neither the webhook nor the poller would mention it
    // again.
    if (!thread) {
      log("warn", "project.external_push_undeliverable", { source, threadId: project.threadId, commit: sha.slice(0, COMMIT_SHORT_HASH_CHARS) });
      return;
    }
    try {
      await thread.send(renderStatusCard(
        `📥 **External push detected** on \`${project.repoName}\` · commit \`${sha.slice(0, COMMIT_SHORT_HASH_CHARS)}\` · pushed with a repo push key.\n` +
        "Publish it to the live site, or dismiss it (the commit stays in git history either way).",
        { rows: [externalPushRow()] },
      ));
    } catch (error) {
      logError("project.external_push_notify_failed", error, { source, threadId: project.threadId, commit: sha.slice(0, COMMIT_SHORT_HASH_CHARS) });
      return;
    }
    await store.patchProject(project.threadId, { lastSeenCommit: sha });
    log("info", "project.external_push_detected", { source, threadId: project.threadId, commit: sha.slice(0, COMMIT_SHORT_HASH_CHARS) });
  }

  /** Signed Forgejo push event: react instantly when it touches a known repo's main. */
  async function handleForgejoPush(event: { ref?: string; after?: string; repository?: { name?: string } }): Promise<void> {
    if (event.ref !== "refs/heads/main" || !event.after) return;
    const repoName = event.repository?.name;
    if (!repoName) return;
    const project = store.listProjects().find((candidate) => candidate.repoName === repoName && candidate.status !== "creating");
    if (!project) return;
    await notifyExternalPushIfNeeded(project, event.after, "webhook");
  }

  /**
   * A push that arrived while a turn was running was skipped by the guards in
   * notifyExternalPushIfNeeded; once the turn settles, look once more so it is
   * not lost to the one-shot webhook.
   */
  async function recheck(threadId: string): Promise<void> {
    if (!services.webhooksLive()) return;
    const project = store.getProject(threadId);
    if (!project || project.pendingDeletion || project.pendingTurn || project.pendingRename) return;
    try {
      const sha = await forgejo.mainCommitSha(project.repoName);
      if (sha) await notifyExternalPushIfNeeded(project, sha, "recheck");
    } catch (error) {
      logError("project.external_push_recheck_failed", error, { threadId });
    }
  }

  /** Retry webhook registration after service outages or configuration changes. */
  async function ensureWebhooks(): Promise<void> {
    const secret = store.getWebhookSecret();
    if (!secret) return;
    const url = `${config.webhookPublicUrl}/hooks/forgejo`;
    const list = store.listProjects().filter((project) => project.status !== "creating" && !project.pendingDeletion);
    await Promise.all(list.map(async (project) => {
      await forgejo.ensurePushWebhook(project.repoName, url, secret).catch((error) => {
        log("warn", "webhook.ensure_failed", { repoName: project.repoName, error: serializeError(error) });
      });
    }));
    log("info", "webhook.boot_sweep_done", { projects: list.length });
  }

  return { startPoller, stopPoller, ensureWebhooks, handleForgejoPush, recheck };
}
