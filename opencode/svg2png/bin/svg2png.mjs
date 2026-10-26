#!/usr/bin/env node
// Rasterize an SVG to PNG for game assets. Only the container's DejaVu fonts
// are available for <text>, so pixel-exact labels should be authored as paths.
import fs from "node:fs";
import { Resvg } from "@resvg/resvg-js";

const usageText = "usage: svg2png <input.svg> [-o output.png] [--width N | --height N | --zoom F]";

function fail(message) {
  console.error(`svg2png: ${message}\n${usageText}`);
  process.exit(1);
}

const args = process.argv.slice(2);
let input;
let output;
let fitTo;
const number = (flag, raw, { integer = true } = {}) => {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0 || (integer && !Number.isInteger(value))) {
    fail(`--${flag} needs a positive ${integer ? "integer" : "number"}`);
  }
  return value;
};
for (let index = 0; index < args.length; index++) {
  const arg = args[index];
  if (arg === "-o" || arg === "--output") output = args[++index] ?? fail(`${arg} needs a path`);
  else if (arg === "--width") fitTo = { mode: "width", value: number("width", args[++index]) };
  else if (arg === "--height") fitTo = { mode: "height", value: number("height", args[++index]) };
  else if (arg === "--zoom") fitTo = { mode: "zoom", value: number("zoom", args[++index], { integer: false }) };
  else if (arg === "-h" || arg === "--help") { console.log(usageText); process.exit(0); }
  else if (arg.startsWith("-")) fail(`unknown option ${arg}`);
  else if (input) fail("pass exactly one input file");
  else input = arg;
}
if (!input) fail("an input SVG is required");
if (!output) output = input.replace(/\.svg$/i, "") + ".png";

let svg;
try {
  svg = fs.readFileSync(input);
} catch (error) {
  fail(`cannot read ${input}: ${error.code ?? error.message}`);
}
svg = Buffer.from(ensureViewBox(svg.toString("utf8")));

let png;
try {
  const resvg = new Resvg(svg, {
    ...(fitTo ? { fitTo } : {}),
    font: { loadSystemFonts: true, defaultFontFamily: "DejaVu Sans" },
  });
  const rendered = resvg.render();
  png = Buffer.from(rendered.asPng());
  process.stdout.write(`wrote ${output} (${rendered.width}x${rendered.height}, ${png.length} bytes)\n`);
} catch (error) {
  fail(`rendering failed: ${error.message}`);
}
fs.writeFileSync(output, png);

/** fitTo cannot scale an SVG that has an explicit pixel size but no viewBox
 * (there is no coordinate system to map), so derive one from the root size. */
function ensureViewBox(svgText) {
  const tag = svgText.match(/<svg\b[^>]*>/i)?.[0];
  if (!tag || /\bviewBox\s*=/i.test(tag)) return svgText;
  const width = Number(tag.match(/\bwidth\s*=\s*"([\d.]+)/i)?.[1]);
  const height = Number(tag.match(/\bheight\s*=\s*"([\d.]+)/i)?.[1]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return svgText;
  return svgText.replace(tag, tag.replace(/^<svg\b/i, `<svg viewBox="0 0 ${width} ${height}"`));
}
