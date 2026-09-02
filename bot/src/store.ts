import fs from "node:fs/promises";
import path from "node:path";
import type { PersistedState, ProjectRecord } from "./types.js";

// Process-wide write queue: Discord threads mutate the store concurrently and
// every save() writes through the same `${file}.tmp`, so unserialized writes
// could race on the temp file or persist an older snapshot over a newer one.
// Chaining the renames keeps them strictly ordered; the file path is part of
// the key because tests open stores on separate files.
const storeWriteQueues = new Map<string, Promise<unknown>>();

function enqueueWrite(file: string, write: () => Promise<void>): Promise<void> {
  const queued = (storeWriteQueues.get(file) ?? Promise.resolve()).then(write, write);
  storeWriteQueues.set(file, queued);
  return queued;
}

export class Store {
  private state: PersistedState;

  private constructor(private readonly file: string, state: PersistedState) {
    this.state = state;
  }

  static async open(file: string, defaultModel?: string): Promise<Store> {
    await fs.mkdir(path.dirname(file), { recursive: true });
    let state: PersistedState;
    try {
      state = JSON.parse(await fs.readFile(file, "utf8")) as PersistedState;
      if (state.version !== 1 || !state.projects || !state.settings) throw new Error("unsupported state format");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn("State file could not be loaded; refusing to silently overwrite it:", error);
        throw error;
      }
      state = { version: 1, settings: { model: defaultModel || undefined }, projects: {} };
      const store = new Store(file, state);
      await store.save();
      return store;
    }
    if (!state.settings.model && defaultModel) {
      state.settings.model = defaultModel;
      const store = new Store(file, state);
      await store.save();
      return store;
    }
    return new Store(file, state);
  }

  getModel(): string | undefined {
    return this.state.settings.model;
  }

  async setModel(model?: string): Promise<void> {
    this.state.settings.model = model || undefined;
    await this.save();
  }

  getEffort(): string | undefined {
    return this.state.settings.effort;
  }

  async setEffort(effort?: string): Promise<void> {
    this.state.settings.effort = effort || undefined;
    await this.save();
  }

  getProject(threadId: string): ProjectRecord | undefined {
    return this.state.projects[threadId];
  }

  listProjects(): ProjectRecord[] {
    return Object.values(this.state.projects).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async putProject(project: ProjectRecord): Promise<void> {
    this.state.projects[project.threadId] = project;
    await this.save();
  }

  async patchProject(threadId: string, patch: Partial<ProjectRecord>): Promise<ProjectRecord> {
    const current = this.state.projects[threadId];
    if (!current) throw new Error(`Unknown project thread ${threadId}`);
    const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
    this.state.projects[threadId] = next;
    await this.save();
    return next;
  }

  async deleteProject(threadId: string): Promise<void> {
    delete this.state.projects[threadId];
    await this.save();
  }

  private async save(): Promise<void> {
    const file = this.file;
    // Snapshot the state synchronously: queued later writers must not
    // serialize a state mutated by an even later save.
    const payload = `${JSON.stringify(this.state, null, 2)}\n`;
    return enqueueWrite(file, async () => {
      const tmp = `${file}.tmp`;
      await fs.writeFile(tmp, payload, { mode: 0o600 });
      await fs.rename(tmp, file);
    });
  }
}
