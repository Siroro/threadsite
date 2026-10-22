import fs from "node:fs/promises";
import { config } from "./config.js";

function joinUrl(base: string, pathname: string): string {
  return `${base.replace(/\/$/, "")}/${pathname.replace(/^\//, "")}`;
}

export class ForgejoClient {
  /** Only the configured ThreadSite owner is inventoried; never scan the whole instance. */
  async listOwnedRepositories(): Promise<Array<{ id: number; name: string; description: string }>> {
    const owner = encodeURIComponent(config.forgejoOwner);
    const endpoint = config.forgejoOwnerType === "org" ? `/api/v1/orgs/${owner}/repos` : `/api/v1/users/${owner}/repos`;
    return this.pages(endpoint);
  }

  private async pages<T>(endpoint: string, admin = false): Promise<T[]> {
    const entries: T[] = [];
    const seen = new Set<number>();
    for (let page = 1; ; page++) {
      const response = await this.api(`${endpoint}?limit=50&page=${page}`, {}, admin);
      if (!response.ok) throw new Error(`Forgejo inventory failed (${response.status}): ${endpoint}`);
      const items = await response.json() as Array<T & { id: number }>;
      if (!Array.isArray(items) || items.some((item) => !Number.isSafeInteger(item.id) || seen.has(item.id))) throw new Error("Forgejo inventory pagination did not advance.");
      for (const item of items) { seen.add(item.id); entries.push(item); }
      if (items.length < 50) return entries;
    }
  }

  async isManagedRepository(repo: { name: string; description?: string }): Promise<boolean> {
    if (/^(?:static website|[23]D static web game) generated (?:from Discord thread .+|by ThreadSite)$/i.test(repo.description ?? "")) return true;
    const response = await this.api(`/api/v1/repos/${encodeURIComponent(config.forgejoOwner)}/${encodeURIComponent(repo.name)}/contents/README.md`);
    if (response.status === 404) return false;
    if (!response.ok) throw new Error(`Forgejo repository ownership check failed (${response.status}): ${repo.name}`);
    const readme = await response.json() as { content?: string; encoding?: string; size?: number };
    return readme.encoding === "base64" && (readme.size ?? Infinity) <= 64 * 1024
      && ["maintained by the ThreadSite harness.", "maintained by the ThreadSite Discord harness."].some((marker) => Buffer.from(readme.content ?? "", "base64").toString("utf8").includes(marker));
  }

  async listManagedPushAccounts(): Promise<string[]> {
    const users = await this.pages<{ login: string; email: string; restricted: boolean }>("/api/v1/admin/users", true);
    const domain = new URL(config.forgejoPublicUrl).hostname;
    return users.filter((user) => user.restricted && /^push-[a-z0-9]{6}$/.test(user.login)
      && user.email === `${user.login}@noreply.${domain}`).map((user) => user.login);
  }

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
    // These calls run inside the per-thread queue; an unanswered connection
    // would park the thread indefinitely. 15s is far beyond a healthy response.
    return fetch(joinUrl(config.forgejoInternalUrl, pathname), {
      ...init,
      headers,
      signal: init.signal ?? AbortSignal.timeout(15_000),
    });
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

  /** Resolve the canonical name and ID, including Forgejo's old-name redirects. */
  async repositoryInfo(name: string): Promise<{ id: number; name: string } | undefined> {
    const response = await this.api(`/api/v1/repos/${encodeURIComponent(config.forgejoOwner)}/${encodeURIComponent(name)}`);
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`Forgejo repository lookup failed (${response.status})`);
    const repo = await response.json() as { id: number; name: string };
    return { id: repo.id, name: repo.name };
  }

  /** Resume a rename only when the original or target still has the expected identity. */
  async renameRepository(currentName: string, newName: string, description?: string, expectedId?: number): Promise<void> {
    const current = await this.repositoryInfo(currentName);
    const target = current?.name === newName ? current : await this.repositoryInfo(newName);
    const repoId = expectedId ?? current?.id;
    if (!repoId) throw new Error("Cannot verify the repository being renamed.");
    if (current && current.id !== repoId) throw new Error("The original repository name now belongs to another repository.");
    if (target && target.id !== repoId) throw new Error("That repository name is already in use.");
    // Resolve retries by repository identity, never merely by the target's existence.
    const source = current?.name ?? target?.name;
    if (!source) throw new Error("The repository being renamed no longer exists.");
    const owner = encodeURIComponent(config.forgejoOwner);
    const repo = encodeURIComponent(source);
    const response = await this.api(`/api/v1/repos/${owner}/${repo}`, {
      method: "PATCH",
      body: JSON.stringify({ name: newName, ...(description ? { description } : {}) }),
    });
    if (response.ok) return;
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

  /**
   * Full hash of the commit currently at the repo's main branch tip.
   * A 404 means the branch genuinely does not exist yet; anything else
   * (revoked token, renamed repo, Forgejo 5xx) is an operational failure and
   * must not masquerade as "nothing new" — that would silently disable
   * external-push detection for the project.
   */
  async mainCommitSha(repoName: string): Promise<string | undefined> {
    const owner = encodeURIComponent(config.forgejoOwner);
    const repo = encodeURIComponent(repoName);
    const response = await this.api(`/api/v1/repos/${owner}/${repo}/branches/main`);
    if (response.status === 404) return undefined;
    if (!response.ok) {
      throw new Error(`Forgejo branch lookup failed (${response.status}): ${await response.text()}`);
    }
    const body = (await response.json()) as { commit?: { id?: string } };
    return body.commit?.id;
  }

  /**
   * Ensure a signed push webhook exists on the repo's main branch, pointing at
   * the bot's HTTP endpoint. Idempotent: a hook with the same URL is left
   * alone, so boot sweeps and rename retries do not pile up duplicates.
   */
  async ensurePushWebhook(repoName: string, url: string, secret: string): Promise<void> {
    const repository = await this.repositoryInfo(repoName);
    if (!repository) {
      throw new Error(`Forgejo repository ${config.forgejoOwner}/${repoName} was not found or is not accessible. Check repository access or restore the missing repository.`);
    }
    const owner = encodeURIComponent(config.forgejoOwner);
    const repo = encodeURIComponent(repository.name);
    const existing = await this.api(`/api/v1/repos/${owner}/${repo}/hooks`);
    if (!existing.ok) {
      throw new Error(`Forgejo webhook lookup failed (${existing.status}): ${await existing.text()}`);
    }
    const hooks = await existing.json() as Array<{ config?: { url?: string } }>;
    if (!Array.isArray(hooks)) throw new Error("Forgejo webhook lookup returned an unexpected payload.");
    if (hooks.some((hook) => hook.config?.url === url)) return;
    const created = await this.api(`/api/v1/repos/${owner}/${repo}/hooks`, {
      method: "POST",
      body: JSON.stringify({
        type: "gitea",
        active: true,
        branch_filter: "main",
        events: ["push"],
        config: { url, content_type: "json", secret },
      }),
    });
    if (!created.ok) {
      throw new Error(`Forgejo webhook creation failed (${created.status}): ${await created.text()}`);
    }
  }

  /** Whether /site pushkey can work: the admin token file must exist. */
  async pushAccountsAvailable(): Promise<boolean> {
    return (await this.adminToken()) !== undefined;
  }
}
