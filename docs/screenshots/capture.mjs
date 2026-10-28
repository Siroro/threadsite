// From bot/: node --import tsx ../docs/screenshots/capture.mjs
// Draws a focused Discord thread around the real turn-card payloads.
// Uses preview's Playwright installation; no Discord login or live project data.
// Gallery captures are generated separately by bot's test:gallery command.
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "../../preview/node_modules/playwright/index.mjs";
import { renderProgressCard } from "../../bot/src/progress-view.ts";
import { buildingSnapshot } from "../../bot/test/fixtures/progress.ts";

process.env.DISCORD_BOT_TOKEN = "screenshot";
process.env.DISCORD_APPLICATION_ID = "screenshot";
const { renderTechnicalCard, renderPlayCard } = await import("../../bot/src/turn-card.ts");
const output = fileURLToPath(new URL("./", import.meta.url));

const escape = (text = "") => String(text).replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[char]);

function markdown(text) {
  return text.split("\n").map((line) => {
    if (!line) return '<div class="paragraph-gap"></div>';
    const tag = line.startsWith("-# ") ? "small" : line.startsWith("### ") ? "h3"
      : line.startsWith("## ") ? "h2" : line.startsWith("> ") ? "blockquote" : "p";
    const bullet = /^[-*] /.test(line);
    const content = escape(line.replace(/^(-# |### |## |> |[-*] )/, ""))
      .replace(/&lt;t:\d+:R&gt;/g, "a moment ago")
      .replace(/&lt;@\d+&gt;/g, '<span class="mention">@Alex</span>')
      .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
      .replace(/~~(.*?)~~/g, "<s>$1</s>")
      .replace(/`(.*?)`/g, "<code>$1</code>")
      .replace(/\\([_*~`])/g, "$1");
    return `<${tag}${bullet ? ' class="bullet"' : ""}>${content}</${tag}>`;
  }).join("");
}

function component(item) {
  switch (item.type) {
    case 17: return `<div class="card" style="--accent:#${item.accent_color.toString(16).padStart(6, "0")}">${item.components.map(component).join("")}</div>`;
    case 10: return `<div class="text">${markdown(item.content)}</div>`;
    case 14: return "<hr>";
    case 1: return `<div class="buttons">${item.components.map(component).join("")}</div>`;
    case 2: return `<button class="control style-${item.style}">${escape(item.emoji?.name ?? "")}${item.emoji ? " " : ""}${escape(item.label)}${item.url ? ' <span class="external">↗</span>' : ""}</button>`;
    case 9: return `<div class="section">${item.components.map(component).join("")}${component(item.accessory)}</div>`;
    default: throw new Error(`Unsupported Discord component: ${item.type}`);
  }
}
const card = (payload) => payload.components.map((item) => component(item.toJSON())).join("");
const message = (name, body, { bot = false, time = "14:32", reply = false } = {}) => `
  <article class="message">
    ${reply ? '<div class="reply-context"><span class="reply-line"></span><span class="reply-avatar">✳</span>ThreadSite <span>✅ Sumo Shove</span></div>' : ""}
    <div class="avatar ${bot ? "bot" : ""}">${bot ? "✳" : "A"}</div>
    <div class="message-body"><header><b>${name}</b>${bot ? '<span class="app">✓ APP</span>' : ""}<time>Today at ${time}</time></header>${body}</div>
  </article>`;

const css = `
* { box-sizing: border-box; }
body { margin: 0; background: #313338; color: #dbdee1; font: 16px/1.4 'Segoe UI', Arial, sans-serif; }
.thread { width: 860px; padding-bottom: 20px; }
.topbar { height: 54px; display: flex; align-items: center; gap: 12px; padding: 0 24px; border-bottom: 1px solid #242529; color: #f2f3f5; font-weight: 650; }
.topbar svg { width: 22px; height: 22px; color: #949ba4; }
.topbar .parent { margin-left: 4px; padding-left: 15px; border-left: 1px solid #4e5058; color: #949ba4; font-size: 13px; font-weight: 400; }
.topbar .more { margin-left: auto; color: #b5bac1; font-size: 22px; }
.messages { padding: 14px 0 4px; }
.message { display: grid; grid-template-columns: 40px minmax(0,1fr); column-gap: 16px; padding: 12px 24px; }
.avatar { width: 40px; height: 40px; border-radius: 50%; background: #b77b58; display: grid; place-items: center; font-size: 20px; color: white; }
.avatar.bot { background: #5865f2; font-size: 28px; }
.message-body header { display: flex; align-items: center; gap: 7px; min-height: 22px; margin-bottom: 6px; }
.message-body header b { color: #f2f3f5; font-size: 15px; font-weight: 600; }
.message-body time { margin-left: 2px; color: #949ba4; font-size: 11px; }
.app { display: inline-block; padding: 0 4px; border-radius: 3px; background: #5865f2; color: white; font-size: 10px; font-weight: 650; line-height: 16px; }
.plain { margin: 0; font-size: 15px; line-height: 1.55; }
.card { width: 100%; max-width: 700px; padding: 16px; border: 1px solid #222327; border-left: 4px solid var(--accent); border-radius: 8px; background: #2b2d31; }
.card h2 { margin: 1px 0 8px; font-size: 20px; line-height: 1.35; color: #f2f3f5; font-weight: 700; }
.card h3 { margin: 0 0 5px; font-size: 15px; color: #f2f3f5; font-weight: 650; }
.card p { margin: 3px 0; font-size: 15px; }
.card small { display: block; font-size: 11px; line-height: 1.6; color: #b5bac1; }
.card strong { color: #f2f3f5; font-weight: 600; }
.text + .text { margin-top: 12px; }
.paragraph-gap { height: 10px; }
hr { border: 0; border-top: 1px solid #41434a; margin: 14px 0; }
code { padding: 2px 4px; background: #1e1f22; border-radius: 3px; font: 12px Consolas, monospace; }
.bullet { position: relative; padding-left: 17px; }
.bullet::before { content: '•'; position: absolute; left: 2px; }
blockquote { margin: 6px 0; padding-left: 10px; border-left: 3px solid #4e5058; }
.buttons { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 13px; }
.control { flex-shrink: 0; height: 32px; border: 0; border-radius: 4px; padding: 6px 12px; background: #4e5058; color: #fff; font: 550 12px 'Segoe UI', Arial, sans-serif; white-space: nowrap; }
.style-1 { background: #5865f2; }
.style-4 { background: #da373c; }
.external { margin-left: 6px; }
.section { display: flex; justify-content: space-between; gap: 20px; margin-bottom: 7px; }
.section > .control { margin-top: 1px; }
.mention { color: #c9cdfb; background: #5865f24d; }
.reply-context { grid-column: 1/-1; display: flex; align-items: center; gap: 6px; height: 23px; margin-top: -5px; color: #b5bac1; font-size: 11px; }
.reply-context > span:last-child { margin-left: 4px; color: #949ba4; }
.reply-line { width: 33px; height: 12px; margin-left: 19px; border-top: 2px solid #4e5058; border-left: 2px solid #4e5058; border-radius: 7px 0 0; align-self: end; }
.reply-avatar { display: grid; place-items: center; width: 15px; height: 15px; border-radius: 50%; color: white; background: #5865f2; font-size: 11px; }
.composer { display: flex; align-items: center; gap: 13px; height: 48px; margin: 18px 24px 0; padding: 0 14px; background: #383a40; border-radius: 8px; color: #949ba4; font-size: 14px; }
.composer .add { font-size: 25px; color: #b5bac1; }
.composer .face { margin-left: auto; color: #b5bac1; font-size: 22px; }
`;
const shell = (content) => `<!doctype html><html lang="en"><meta charset="utf-8"><title>Sumo Shove</title><style>${css}</style>
  <main class="thread"><div class="topbar"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M6 3 4 21M14 3l-2 18M2 9h18M1 16h13"/><path d="M16 14h6v5h-2l-2 2v-2h-2z"/></svg>Sumo Shove<span class="parent">make-a-game</span><span class="more">⋯</span></div>
  <div class="messages">${content}</div><div class="composer"><span class="add">⊕</span>Message Sumo Shove<span class="face">☺</span></div></main></html>`;

const progress = renderProgressCard(buildingSnapshot(), { resource: "123", stopCustomId: "ts2:stop:123" });
const finished = {
  resource: "123", name: "Sumo Shove", kind: "game-2d", published: true,
  commit: "e9b74c2a0f", commitFiles: 6, additions: 184, deletions: 37, durationMs: 178000,
  usage: { inputTokens: 82300, outputTokens: 6200, cacheTokens: 65840, contextTokens: 28400, contextLimit: 100000, steps: 18, cost: 0, models: [] },
  summary: "Added a live leaderboard and tightened the touch controls.\n\n- The crowd reacts to knockouts.\n- Winners get a confetti burst.\n- Tested keyboard and touch controls, then published the update.",
  description: { pitch: "Push your friends out of the ring. Last player standing wins.", play: "Move with WASD or the arrow keys. On a phone, use the touch controls." },
  changelog: { title: "Leaderboard and winner effects", body: "Scores update during the match and reset for each new round." },
  meta: "2D · Excalibur · shared arena multiplayer", hasFileDetails: true,
  siteUrl: "https://sites.example.com/sumo-shove/", repoUrl: "https://git.example.com/site-sumo-shove",
};
const request = message("Alex", '<p class="plain">Add a proper leaderboard and make the arena feel more alive.<br>Keep it easy to play on a phone.</p>');
const running = shell(request + message("ThreadSite", card(progress), { bot: true })
  + message("Alex", '<p class="plain">And give the winner a little confetti burst 🎉</p>', { time: "14:34" }));
const complete = shell(message("ThreadSite", card(renderTechnicalCard(finished)), { bot: true, time: "14:35" })
  + message("ThreadSite", card(renderPlayCard(finished)), { bot: true, reply: true, time: "14:35" }));

await fs.mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, ...(process.env.GALLERY_BROWSER_EXECUTABLE_PATH ? { executablePath: process.env.GALLERY_BROWSER_EXECUTABLE_PATH } : {}) });
try {
  const page = await browser.newPage({ viewport: { width: 860, height: 1000 }, deviceScaleFactor: 2 });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  for (const [name, html] of [["discord-turn-progress.png", running], ["discord-turn-complete.png", complete]]) {
    await page.setContent(html);
    await page.evaluate(() => document.fonts.ready);
    if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw new Error(`${name} has horizontal overflow`);
    await page.locator(".thread").screenshot({ path: `${output}/${name}` });
    console.log(`Captured ${name}`);
  }
  if (errors.length) throw new Error(errors.join("\n"));
} finally { await browser.close(); }
