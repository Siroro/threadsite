/**
 * Human-readable labels for agent tool calls, shared by the live activity
 * feed and the subagent lines. Workspace paths stay out of public labels.
 */
import path from "node:path";
import { truncate } from "./util.js";

export function describeTool(tool: string, input: any, status: string, title?: string, directory?: string): { text: string; detail?: string; command?: boolean } | undefined {
  const normalized = tool.toLowerCase().replace(/-/g, "_");
  if (normalized === "subagent") {
    const agent = typeof input?.agent === "string" && input.agent ? input.agent : "subagent";
    const description = typeof input?.description === "string" ? input.description
      : typeof input?.prompt === "string" ? input.prompt : undefined;
    return {
      text: status === "running" ? `🤖 Delegating to ${agent}` : `🤖 ${agent} finished`,
      detail: description ? truncate(description, 90) : undefined,
    };
  }
  if (normalized === "websearch") return { text: status === "running" ? "🔎 Searching the web" : "🔎 Web research gathered" };
  if (normalized === "webfetch") return { text: status === "running" ? "🌐 Reading a web reference" : "🌐 Web reference read" };
  if (normalized.startsWith("playwright_")) {
    const screenshot = normalized.includes("screenshot");
    return { text: status === "running"
      ? screenshot ? "📸 Inspecting the rendered preview" : "🌐 Testing the browser preview"
      : screenshot ? "📸 Preview screenshot captured" : "🌐 Browser check complete" };
  }
  if (normalized === "asset_download") {
    const destination = typeof input?.destination === "string" ? path.basename(input.destination) : undefined;
    return { text: status === "running" ? "📥 Downloading a media asset" : "📦 Asset saved locally", detail: destination };
  }
  if (normalized === "asset_import") {
    const destination = typeof input?.destination === "string" ? path.basename(input.destination) : undefined;
    return { text: status === "running" ? "📤 Installing an uploaded file" : "📦 Upload installed into the site", detail: destination };
  }
  if (normalized === "asset_save") {
    const destination = typeof input?.destination === "string" ? path.basename(input.destination) : undefined;
    return { text: status === "running" ? "🎨 Creating an asset" : "🖼️ Asset added to the site", detail: destination };
  }
  if (normalized === "asset_preview") {
    const file = typeof input?.file === "string" ? path.basename(input.file) : undefined;
    return { text: status === "running" ? "👀 Reviewing an asset" : "👀 Asset reviewed", detail: file };
  }
  if (["edit", "write", "apply_patch"].includes(normalized)) {
    const target = input?.filePath ?? input?.file_path ?? input?.path ?? input?.file;
    const detail = typeof target === "string" ? projectFileLabel(target, directory) : undefined;
    return { text: status === "running" ? "✏️ Editing" : "✅ Edited", detail };
  }
  if (["read", "glob", "grep", "list"].includes(normalized)) {
    const target = input?.filePath ?? input?.file_path ?? input?.path;
    return { text: status === "running" ? "📚 Reading" : "📚 Read",
      detail: typeof target === "string" ? projectFileLabel(target, directory) : undefined };
  }
  if (normalized === "shell") {
    // The command is its own label; `command` keeps the service-wait
    // heuristics from ever matching command text.
    const command = typeof input?.command === "string" ? input.command : undefined;
    return { text: command ? shellCommandLabel(command, directory) : status === "running" ? "⚙️ Command" : "✓ Command", command: true };
  }
  if (["todowrite", "todoread"].includes(normalized)) return { text: status === "running" ? "🗺️ Organising the build" : "🗺️ Plan updated" };
  if (title) return { text: status === "running" ? `⚙️ ${toolLabel(tool)}` : `✅ ${truncate(stripWorkspaceDir(String(title), directory), 90)}` };
  return { text: status === "running" ? `⚙️ ${toolLabel(tool)}` : `✓ ${toolLabel(tool)} finished` };
}

const SHELL_LABEL_CHARS = 90;

/**
 * A shell command as a public activity label. Every command runs inside the
 * thread's workspace, so a `cd` to that root is dropped (subdirectory targets
 * stay, relativized) and absolute workspace paths become project-relative.
 * Other long tool paths collapse to a basename hint (`…/tsc`), and a command
 * that still overflows is cut from the middle so the program and its final
 * arguments both stay visible.
 */
function shellCommandLabel(command: string, directory?: string): string {
  const oneLine = command.replace(/\r?\n+/g, " ").replace(/\s+/g, " ").trim();
  const insideWorkspace = (absolute: string): string | undefined => {
    if (!directory) return undefined;
    const relative = path.relative(path.resolve(directory), absolute).replaceAll(path.sep, "/");
    return relative.startsWith("../") || relative === ".." || path.isAbsolute(relative) ? undefined : relative;
  };
  let body = oneLine;
  const cd = /^cd\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s*(?:&&|;)\s*/.exec(oneLine);
  if (cd && directory) {
    const relative = insideWorkspace(path.resolve(directory, cd[1] ?? cd[2] ?? cd[3]!));
    const rest = oneLine.slice(cd[0].length);
    body = relative === "" ? rest : relative ? `cd ${relative} && ${rest}` : body;
  }
  body = body.split(" ").map((token) => {
    if (!token.startsWith("/")) return token;
    const relative = insideWorkspace(path.resolve(token));
    if (relative !== undefined) return relative || ".";
    if (token.length > 32 && token.split("/").length >= 4) return `…/${token.split("/").at(-1)}`;
    return token;
  }).join(" ");
  const stripped = stripWorkspaceDir(body, directory);
  if (stripped.length <= SHELL_LABEL_CHARS) return stripped;
  const head = stripped.slice(0, SHELL_LABEL_CHARS - 33).replace(/\s+\S*$/, "");
  const tail = stripped.slice(-(SHELL_LABEL_CHARS - head.length - 1)).replace(/^\S+\s+/, "");
  return head && tail ? `${head}…${tail}` : truncate(stripped, SHELL_LABEL_CHARS);
}

/** The thread's workspace path is internal bookkeeping: it must never reach a
 * public label, wherever it appears — flag values (`--out=/workspace/…`),
 * quoted prose, or any other position a token pass does not relativize. */
function stripWorkspaceDir(text: string, directory?: string): string {
  if (!directory) return text;
  // POSIX-absolute directories are used verbatim: path.resolve would inject a
  // drive prefix on Windows and the literal text would never match.
  const normalized = directory.replaceAll("\\", "/");
  const root = normalized.startsWith("/") ? normalized : path.resolve(normalized).replaceAll(path.sep, "/");
  return text.split(`${root}/`).join("").split(root).join(".");
}

function projectFileLabel(file: string, directory?: string): string {
  const relative = directory && path.isAbsolute(file) ? path.relative(directory, file) : file;
  return truncate(!relative || relative.startsWith("..") || path.isAbsolute(relative) ? path.basename(file) : relative.replaceAll(path.sep, "/"), 140);
}

export function toolLabel(tool: string): string {
  return tool.replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}
