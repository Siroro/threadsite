import fs from "node:fs/promises";
import { config } from "./config.js";

function joinUrl(base: string, pathname: string): string {
  return `${base.replace(/\/$/, "")}/${pathname.replace(/^\//, "")}`;
}

export class ForgejoClient {
  private async token(): Promise<string> {
    if (config.forgejoToken) return config.forgejoToken;
    try {
      const token = (await fs.readFile(config.forgejoTokenFile, "utf8")).trim();
      if (token) return token;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    throw new Error(
      `Forgejo token is not configured. Set FORGEJO_TOKEN or run scripts/bootstrap-forgejo.sh to create ${config.forgejoTokenFile}.`,
    );
  }

  private async api(pathname: string, init: RequestInit = {}): Promise<Response> {
    const token = await this.token();
    const headers = new Headers(init.headers);
    headers.set("Authorization", `token ${token}`);
    if (init.body) headers.set("Content-Type", "application/json");
    return fetch(joinUrl(config.forgejoInternalUrl, pathname), { ...init, headers });
  }

  async ensureRepository(name: string, description: string): Promise<void> {
    const owner = encodeURIComponent(config.forgejoOwner);
    const repo = encodeURIComponent(name);
    const existing = await this.api(`/api/v1/repos/${owner}/${repo}`);
    if (existing.ok) return;
    if (existing.status !== 404) {
      throw new Error(`Forgejo repository lookup failed (${existing.status}): ${await existing.text()}`);
    }

    const endpoint = config.forgejoOwnerType === "org"
      ? `/api/v1/orgs/${owner}/repos`
      : "/api/v1/user/repos";
    const created = await this.api(endpoint, {
      method: "POST",
      body: JSON.stringify({
        name,
        description,
        private: false,
        auto_init: false,
      }),
    });
    if (!created.ok && created.status !== 409) {
      throw new Error(`Forgejo repository creation failed (${created.status}): ${await created.text()}`);
    }
  }

  /**
   * Rename a repository and refresh its description. Forgejo leaves a redirect
   * from the old name behind. A 404 on the old name still counts as success
   * when the new name already exists: a previous attempt may have renamed the
   * repo before a later step failed, and retried renames must converge instead
   * of stranding a half-renamed project.
   */
  async renameRepository(currentName: string, newName: string, description?: string): Promise<void> {
    if (currentName === newName) return;
    const owner = encodeURIComponent(config.forgejoOwner);
    const repo = encodeURIComponent(currentName);
    const response = await this.api(`/api/v1/repos/${owner}/${repo}`, {
      method: "PATCH",
      body: JSON.stringify({ name: newName, ...(description ? { description } : {}) }),
    });
    if (response.ok) return;
    if (response.status === 404) {
      const target = await this.api(`/api/v1/repos/${owner}/${encodeURIComponent(newName)}`);
      if (target.ok) return;
    }
    throw new Error(`Forgejo repository rename failed (${response.status}): ${await response.text()}`);
  }

  /** Delete a repository. */
  async deleteRepository(name: string): Promise<void> {
    const owner = encodeURIComponent(config.forgejoOwner);
    const repo = encodeURIComponent(name);
    const response = await this.api(`/api/v1/repos/${owner}/${repo}`, { method: "DELETE" });
    if (!response.ok && response.status !== 404) {
      throw new Error(`Forgejo repository deletion failed (${response.status}): ${await response.text()}`);
    }
  }

  repoWebUrl(name: string): string {
    return joinUrl(config.forgejoPublicUrl, `${encodeURIComponent(config.forgejoOwner)}/${encodeURIComponent(name)}`);
  }

  repoGitUrl(name: string): string {
    return joinUrl(config.forgejoInternalUrl, `${encodeURIComponent(config.forgejoOwner)}/${encodeURIComponent(name)}.git`);
  }

  async gitCredentials(): Promise<{ username: string; token: string }> {
    return { username: config.forgejoOwner, token: await this.token() };
  }
}
