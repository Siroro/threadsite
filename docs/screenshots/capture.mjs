// From bot/: node --import tsx ../docs/screenshots/capture.mjs
// Uses preview's Playwright installation. No Discord login or live project data.
// Gallery: set GALLERY_SCREENSHOT_DIR to this directory and run npm run test:gallery
// from bot/. That command also writes optional detail/mobile captures.
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "../../preview/node_modules/playwright/index.mjs";
import { renderProgressCard } from "../../bot/src/progress-view.ts";
import { buildingSnapshot } from "../../bot/test/fixtures/progress.ts";

process.env.DISCORD_BOT_TOKEN = "screenshot";
process.env.DISCORD_APPLICATION_ID = "screenshot";
const { renderProjectCard } = await import("../../bot/src/project-card.ts");
const output = fileURLToPath(new URL("./", import.meta.url));
await fs.mkdir(output, { recursive: true });

const escape = (text = "") => String(text).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
function markdown(text) {
  return text.split("\n").map((line) => {
    const tag = line.startsWith("-# ") ? "small" : line.startsWith("### ") ? "h3" : line.startsWith("## ") ? "h2" : line.startsWith("> ") ? "blockquote" : "p";
    const content = escape(line.replace(/^(-# |### |## |> )/, ""))
      .replace(/&lt;t:\d+:R&gt;/g, "a moment ago")
      .replace(/&lt;@\d+&gt;/g, '<span class="mention">@Alex</span>')
      .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
      .replace(/~~(.*?)~~/g, "<s>$1</s>")
      .replace(/`(.*?)`/g, "<code>$1</code>")
      .replace(/\\([_*~`])/g, "$1");
    return `<${tag}>${content || "&nbsp;"}</${tag}>`;
  }).join("");
}
function component(item) {
  if (item.type === 17) return `<div class="card" style="--accent:#${item.accent_color.toString(16).padStart(6, "0")}">${item.components.map(component).join("")}</div>`;
  if (item.type === 10) return `<div class="text">${markdown(item.content)}</div>`;
  if (item.type === 14) return "<hr>";
  if (item.type === 1) return `<div class="buttons">${item.components.map(component).join("")}</div>`;
  if (item.type === 2) return `<button class="control style-${item.style}">${escape(item.emoji?.name ?? "")}${item.emoji ? " " : ""}${escape(item.label)}${item.url ? ' <span class="external">↗</span>' : ""}</button>`;
  if (item.type === 9) return `<div class="section">${item.components.map(component).join("")}${component(item.accessory)}</div>`;
  if (item.type === 11) return "";
  throw new Error(`Unsupported Discord component: ${item.type}`);
}
const card = (message) => message.components.map((item) => component(item.toJSON())).join("");
const message = (name, body, bot = false, time = "Today at 14:32") => `<article class="message"><div class="avatar ${bot ? "bot" : ""}">${bot ? "✳" : "A"}</div><div class="message-body"><header><b>${name}</b>${bot ? '<span class="app">✓ APP</span>' : ""}<time>${time}</time></header>${body}</div></article>`;

const css = `
.control{border:0;border-radius:4px;background:#4e5058;color:#fff;font:550 12px 'Segoe UI',Arial,sans-serif;padding:7px 12px;height:32px;white-space:nowrap}.section>.control{flex-shrink:0;margin-top:2px}
*{box-sizing:border-box}body{margin:0;background:#313338;color:#dbdee1;font:15px/1.42 'Segoe UI',Arial,sans-serif}button{font:inherit}
.window{height:940px;display:grid;grid-template-columns:72px 240px 1fr}.servers{background:#1e1f22;display:flex;align-items:center;flex-direction:column;gap:14px;padding:20px 0}.server{width:48px;height:48px;border-radius:50%;background:#313338;display:grid;place-items:center;font-size:22px;color:#ddd}.server.active{background:#5865f2;border-radius:16px;color:#fff;position:relative}.server.active:before{content:'';position:absolute;background:white;width:4px;height:38px;left:-12px;border-radius:0 4px 4px 0}.server.line{height:2px;width:32px;background:#35363c}.server.plus{color:#23a55a}
.channels{background:#2b2d31;position:relative}.server-name{height:54px;display:flex;align-items:center;justify-content:space-between;padding:0 18px;font-weight:650;border-bottom:1px solid #202126;color:#f2f3f5}.channel-body{padding:18px 8px}.category{font-size:11px;font-weight:750;color:#949ba4;margin:18px 8px 7px;letter-spacing:.5px}.channel{padding:7px 12px;border-radius:4px;color:#949ba4;margin:2px 0}.channel .hash{font-size:20px;margin-right:8px;color:#80848e}.channel.selected{background:#404249;color:#f2f3f5}.thread{margin-left:30px;padding:8px 10px 8px 16px;border-left:2px solid #41434a;color:#949ba4;font-size:14px}.thread.selected{background:#35373c;border-radius:0 4px 4px 0;color:#f2f3f5}.user-panel{position:absolute;bottom:0;width:100%;height:54px;background:#232428;display:flex;align-items:center;gap:10px;padding:10px;font-size:13px}.user-panel small{display:block;font-size:11px;color:#b5bac1}.user-panel .avatar{width:32px;height:32px;font-size:14px}
main{position:relative;min-width:0}.topbar{height:54px;padding:0 22px;border-bottom:1px solid #202126;display:flex;align-items:center;gap:10px;color:#f2f3f5;font-weight:650}.topbar .hash{font-size:25px;color:#80848e;font-weight:400}.topbar .description{font-weight:400;color:#b5bac1;font-size:13px;border-left:1px solid #484a51;padding-left:14px;margin-left:8px}.tools{margin-left:auto;color:#b5bac1;letter-spacing:14px}.pinned{margin:18px 24px 8px;color:#b5bac1;font-size:12px}.pinned span{color:#00a8fc}.message{display:flex;gap:16px;padding:12px 24px}.avatar{flex-shrink:0;width:40px;height:40px;border-radius:50%;background:#ba7b53;display:grid;place-items:center;font-size:20px;font-weight:600;color:white}.avatar.bot{background:#5865f2;font-size:29px;font-weight:400}.message-body{min-width:0;flex:1}.message header{display:flex;align-items:center;gap:7px;margin-bottom:5px}.message b{color:#f2f3f5;font-weight:600}.message time{color:#949ba4;font-size:11px;margin-left:3px}.app{background:#5865f2;color:#fff;font-size:10px;font-weight:600;border-radius:3px;padding:0 4px}.plain{margin:0;line-height:1.5}.card{background:#2b2d31;border:1px solid #222327;border-left:4px solid var(--accent);border-radius:8px;padding:15px 16px;max-width:650px}.text+.text{margin-top:12px}.card h2{font-size:20px;line-height:1.25;margin:5px 0 9px;color:#f2f3f5}.card h3{font-size:14px;color:#f2f3f5;margin:0 0 5px}.card p{margin:3px 0;font-size:14px}.card small{display:block;font-size:11px;color:#b5bac1;line-height:1.5}.card strong{color:#f2f3f5;font-weight:600}hr{border:0;border-top:1px solid #41434a;margin:14px 0}.buttons{display:flex;gap:8px;margin-top:13px;flex-wrap:wrap}.buttons button{border:0;border-radius:4px;background:#4e5058;color:#fff;font-size:12px;padding:7px 12px;font-weight:550}.buttons .style-1{background:#5865f2}.buttons .style-4{background:#da373c}.external{margin-left:6px}code{font:12px Consolas,monospace;background:#1e1f22;border-radius:3px;padding:2px 4px}blockquote{margin:6px 0;border-left:3px solid #4e5058;padding-left:10px;font-size:14px}.mention{background:#5865f24d;color:#c9cdfb}.composer{position:absolute;bottom:23px;left:24px;right:24px;height:48px;border-radius:8px;background:#383a40;color:#949ba4;display:flex;align-items:center;padding:0 16px;gap:18px}.composer .add{font-size:25px;color:#b5bac1}.composer .right{margin-left:auto;letter-spacing:12px;color:#b5bac1}.section{display:flex;justify-content:space-between;gap:20px}.date{display:flex;align-items:center;gap:10px;margin:20px 24px 8px;color:#949ba4;font-size:11px}.date:before,.date:after{content:'';height:1px;background:#41434a;flex:1}
`;
function shell(title, content, mode) {
  return `<!doctype html><meta charset="utf-8"><style>${css}</style><div class="window">
  <nav class="servers"><div class="server">◈</div><div class="server line"></div><div class="server active">✳</div><div class="server">☕</div><div class="server plus">+</div></nav>
  <aside class="channels"><div class="server-name">The ThreadSite Arcade <span>⌄</span></div><div class="channel-body"><div class="category">⌄ WELCOME</div><div class="channel"><span class="hash">#</span>start-here</div><div class="channel"><span class="hash">#</span>general</div><div class="category">⌄ MAKE SOMETHING</div><div class="channel ${mode === "build" ? "selected" : ""}"><span class="hash">#</span>build-a-site</div><div class="thread ${mode === "build" ? "selected" : ""}">Sumo Shove</div><div class="thread">Server Cookbook</div><div class="category">⌄ THE ARCADE</div><div class="channel ${mode === "games" ? "selected" : ""}"><span class="hash">#</span>make-a-game</div><div class="thread ${mode === "games" ? "selected" : ""}">Koi Pond Arcade</div><div class="thread">Capybara Courier</div><div class="thread">Hover Yard</div><div class="thread">Dungeon Delivery</div><div class="channel"><span class="hash">#</span>looking-to-play</div></div><div class="user-panel"><div class="avatar">A</div><div><b>Alex</b><small>Online</small></div></div></aside>
  <main><div class="topbar"><span class="hash">▤</span>${title}<span class="description">${mode === "build" ? "build-a-site" : "make-a-game"}</span><span class="tools">⌕ ⋯</span></div>${content}<div class="composer"><span class="add">⊕</span>Message ${title}<span class="right">◇ ☺</span></div></main></div>`;
}

const progress = card(renderProgressCard(buildingSnapshot(), { resource: "123", stopCustomId: "threadsite:stop" }));
const project = card(renderProjectCard({
  project: {
    threadId: "123", guildId: "1", parentChannelId: "2", displayName: "Koi Pond Arcade",
    workspacePath: "/screenshot", siteSlug: "koi-pond-arcade", repoName: "site-koi-pond-arcade",
    sessionId: "s", projectKind: "game-2d", multiplayerMode: "rooms", status: "ready",
    createdAt: "2026-10-23T12:00:00Z", updatedAt: "2026-10-23T14:30:00Z", lastCommit: "e9b74c2",
    initialPrompt: "Make a koi pond fishing game. Let friends join with a room code and compete for the biggest catch.",
  },
  description: { pitch: "A quiet pond, a few friends, and one very competitive fishing trip. Cast together and see who lands the biggest koi." },
  siteUrl: "https://sites.example.com/koi-pond-arcade/", repoUrl: "https://git.example.com/site-koi-pond-arcade",
}));
const thread = shell("Sumo Shove", `<div class="date">23 October 2026</div>${message("Alex", '<p class="plain">Make the arena feel more alive, and add a proper leaderboard.<br>Keep it easy to play on a phone.</p>')}${message("ThreadSite", progress, true)}${message("Alex", '<p class="plain">And give the winner a little confetti burst 🎉</p>', false, "Today at 14:34")}`, "build");
const games = shell("Koi Pond Arcade", `<div class="pinned">⌖ <span>Pinned project card</span></div>${message("ThreadSite", project, true, "Today at 14:30")}${message("Alex", '<p class="plain">Can we add a rare golden koi and a longer evening round?</p>', false, "Today at 14:35")}`, "games");

const browser = await chromium.launch({ headless: true, ...(process.env.GALLERY_BROWSER_EXECUTABLE_PATH ? { executablePath: process.env.GALLERY_BROWSER_EXECUTABLE_PATH } : {}) });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 940 }, deviceScaleFactor: 1.5 });
  for (const [name, html] of [["discord-thread.png", thread], ["discord-games.png", games]]) {
    await page.setContent(html);
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: `${output}/${name}` });
    console.log(`Captured ${name}`);
  }
} finally { await browser.close(); }
