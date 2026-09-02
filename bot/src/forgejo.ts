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

  /**
   * Admin token, used only to create/delete the restricted push accounts.
   * Unlike the service token this one is optional: when the file is missing,
   * pushkey is simply unavailable instead of the whole client failing.
   */
  private async adminToken(): Promise<string | undefined> {
    try {
      const token = (await fs.readFile(config.forgejoAdminTokenFile, "utf8")).trim();
      return token || undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return undefined;
    }
  }

  private async api(pathname: string, init: RequestInit = {}, admin = false): Promise<Response> {
    const token = admin ? await this.adminToken() : await this.token();
    if (admin && !token) {
      throw new Error(
        `Forgejo admin token is not configured. Run scripts/bootstrap-forgejo.sh to create ${config.forgejoAdminTokenFile}.`,
      );
    }
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

  /** Clone URL for humans/push-key holders: the public Forgejo URL, not the docker-internal one. */
  repoGitPublicUrl(name: string): string {
    return joinUrl(config.forgejoPublicUrl, `${encodeURIComponent(config.forgejoOwner)}/${encodeURIComponent(name)}.git`);
  }

  async gitCredentials(): Promise<{ username: string; token: string }> {
    return { username: config.forgejoOwner, token: await this.token() };
  }

  /**
   * Create a restricted Forgejo user for a repo push key. Restricted users see
   * nothing on the instance except repositories they are explicitly added to.
   */
  async createPushAccount(username: string, password: string, email: string): Promise<void> {
    const created = await this.api("/api/v1/admin/users", {
      method: "POST",
      body: JSON.stringify({
        username,
        email,
        password,
        restricted: true,
        must_change_password: false,
        visibility: "private",
      }),
    }, true);
    if (!created.ok && created.status !== 422) {
      throw new Error(`Forgejo push-account creation failed (${created.status}): ${await created.text()}`);
    }
  }

  /**
   * Delete a push account. Forgejo removes its collaborations with the user, so
   * the credentials stop working immediately.
   */
  async deletePushAccount(username: string): Promise<void> {
    const response = await this.api(`/api/v1/admin/users/${encodeURIComponent(username)}`, { method: "DELETE" }, true);
    if (!response.ok && response.status !== 404) {
      throw new Error(`Forgejo push-account deletion failed (${response.status}): ${await response.text()}`);
    }
  }

  /** Grant an account Write access to exactly one repository (service token: the owner adds collaborators). */
  async addCollaborator(repoName: string, username: string): Promise<void> {
    const owner = encodeURIComponent(config.forgejoOwner);
    const repo = encodeURIComponent(repoName);
    const response = await this.api(`/api/v1/repos/${owner}/${repo}/collaborators/${encodeURIComponent(username)}`, {
      method: "PUT",
      body: JSON.stringify({ permission: "write" }),
    });
    if (!response.ok && response.status !== 204) {
      throw new Error(`Forgejo collaborator grant failed (${response.status}): ${await response.text()}`);
    }
  }

  /** Full hash of the commit currently at the repo's main branch tip. */
  async mainCommitSha(repoName: string): Promise<string | undefined> {
    const owner = encodeURIComponent(config.forgejoOwner);
    const repo = encodeURIComponent(repoName);
    const response = await this.api(`/api/v1/repos/${owner}/${repo}/branches/main`);
    if (!response.ok) return undefined;
    const body = (await response.json()) as { commit?: { id?: string } };
    return body.commit?.id;
  }

  /** Whether /site pushkey can work: the admin token file must exist. */
  async pushAccountsAvailable(): Promise<boolean> {
    return (await this.adminToken()) !== undefined;
  }
}
