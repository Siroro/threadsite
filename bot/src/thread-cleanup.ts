import type { ProjectRecord } from "./types.js";
import type { Store } from "./store.js";
import { log, serializeError } from "./logger.js";

/** Only Discord's explicit Unknown Channel code proves absence. */
export async function reconcileProjectThreads(store: Store, services: {
  available(project: ProjectRecord): boolean;
  fetch(threadId: string): Promise<unknown>;
  remove(threadId: string, reason: string): Promise<void>;
}): Promise<void> {
  for (const project of store.listProjects()) {
    try {
      if (project.pendingDeletion) {
        await services.remove(project.threadId, project.pendingDeletion.reason);
        continue;
      }
      if (!services.available(project)) continue;
      try { await services.fetch(project.threadId); }
      catch (error) {
        if ((error as { code?: number }).code !== 10003) throw error;
        await services.remove(project.threadId, "missing-thread");
      }
    } catch (error) {
      log("warn", "project.cleanup_retry_pending", { threadId: project.threadId, error: serializeError(error) });
    }
  }
}
