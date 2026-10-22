// Focused density-check setup using the production bot's staged engine seed.
import fs from "node:fs/promises";
import path from "node:path";
import { ensureEnginePackages } from "/app/dist/engines.js";
import { buildSite } from "/app/dist/build.js";
import { validateSite } from "/app/dist/publish.js";
import { html, source } from "./cases.mjs";

const workspace = "/workspace/100/201";
const site = path.join(workspace, "site");
for (const dir of ["src", "css", "data", "assets"]) await fs.mkdir(path.join(site, dir), { recursive: true });
await fs.writeFile(path.join(site, "index.html"), html);
await fs.writeFile(path.join(site, "about.html"), "<!doctype html><html><body><h1>About the Docker check</h1></body></html>");
await fs.writeFile(path.join(site, "css", "main.css"), "body{margin:20px;background:#14213d;color:white}canvas{max-width:100%}");
await fs.writeFile(path.join(site, "assets", "mark.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="#33ddaa"/></svg>');
await fs.writeFile(path.join(site, "data", "check.json"), '{"message":"Local data loaded"}');
await fs.writeFile(path.join(site, "src", "main.ts"), source("game-2d", "pixels"));
await ensureEnginePackages(workspace, "game-2d");
await buildSite(workspace);
await validateSite(site);
