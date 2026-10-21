import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";

// Forgejo refuses to POST a webhook to a private/loopback target unless that
// host is allowlisted, and the bot's listener is reached at http://bot:8901 on
// the Compose network. Without the allowlist Forgejo logs "webhook can only
// call allowed HTTP servers" and drops the delivery.
//
// The bot cannot notice: pushWebhooksLive only reflects whether its own
// listener bound, so it registers hooks, reports webhooks as live, and skips
// the external-push poller fallback — pushes are missed with no error on the
// bot side. Keep the allowlist and the webhook host in step.
const compose = await fs.readFile(
  new URL("../../docker-compose.yml", import.meta.url),
  "utf8",
);
const envExample = await fs.readFile(
  new URL("../../.env.example", import.meta.url),
  "utf8",
);

const ALLOWLIST =
  /FORGEJO__webhook__ALLOWED_HOST_LIST:\s*\$\{([A-Z_]+):-([^}]+)\}/;

test("Forgejo is allowed to deliver push webhooks to the bot", () => {
  const match = ALLOWLIST.exec(compose);
  assert.ok(
    match,
    "docker-compose.yml must set FORGEJO__webhook__ALLOWED_HOST_LIST on the forgejo service",
  );
  const [, variable, fallback] = match;
  assert.ok(
    fallback.trim().length > 0,
    `${variable} needs a non-empty default`,
  );
  assert.notEqual(
    fallback.trim(),
    "*",
    "a wildcard allowlist would permit any webhook target",
  );
});

test("the webhook allowlist host matches the URL Forgejo is told to call", () => {
  const allowed = ALLOWLIST.exec(compose)?.[2].trim();
  const publicUrl = /^WEBHOOK_PUBLIC_URL=https?:\/\/([^/\s:]+)/m.exec(
    envExample,
  )?.[1];
  assert.ok(publicUrl, ".env.example must document WEBHOOK_PUBLIC_URL");
  assert.equal(
    allowed,
    publicUrl,
    "the allowlisted host must be the host in WEBHOOK_PUBLIC_URL, or Forgejo denies the delivery",
  );
});
