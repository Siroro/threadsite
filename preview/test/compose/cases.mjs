export const cases = [
  { id: "200", kind: "site" },
  { id: "201", kind: "game-2d" },
  { id: "202", kind: "game-3d" },
];

export const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1"><title>Docker browser check</title>
  <link rel="icon" href="assets/mark.svg"><link rel="stylesheet" href="css/main.css"></head>
  <body><main><h1>Docker browser check</h1><p id="stage"></p>
  <form id="form"><label for="name">Display name</label><input id="name" name="name">
  <button id="submit" type="submit">Greet</button></form><p id="greeting">Waiting</p><p id="key">No key</p>
  <img id="asset" src="assets/mark.svg" width="32" height="32" alt="Local test asset">
  <a href="about.html">About this check</a><div id="game"></div><p id="data">Loading local data</p>
  <div id="bottom" style="margin-top:1200px">Scroll target</div></main>
  <script type="module" src="js/main.js"></script></body></html>`;

export function source(kind, stage) {
  const common = `
document.querySelector('#stage')!.textContent = '${stage}';
document.querySelector('#form')!.addEventListener('submit', event => {
  event.preventDefault();
  document.querySelector('#greeting')!.textContent = 'Hello ' + (document.querySelector('#name') as HTMLInputElement).value;
});
window.addEventListener('keydown', event => { document.querySelector('#key')!.textContent = event.key; });
fetch('data/check.json').then(r => r.json()).then(data => { document.querySelector('#data')!.textContent = data.message; });
`;
  if (kind === "game-3d") return `import * as THREE from 'three';
${common}
const scene = new THREE.Scene(); scene.background = new THREE.Color('#162344');
const camera = new THREE.PerspectiveCamera(60, 2, 0.1, 20); camera.position.z = 3;
const renderer = new THREE.WebGLRenderer({ antialias: true }); renderer.setSize(400, 200);
document.querySelector('#game')!.appendChild(renderer.domElement);
scene.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial({ color: '#33ddaa' })));
renderer.render(scene, camera); (window as any).smokeReady = true;
`;
  if (kind === "game-2d") return `import * as ex from 'excalibur';
${common}
const host = document.querySelector<HTMLElement>('#game')!;
host.style.width = 'min(400px, 100%)'; host.style.height = '200px';
const canvas = document.createElement('canvas'); canvas.style.display = 'block'; host.appendChild(canvas);
const game = new ex.Engine({ canvasElement: canvas, displayMode: ex.DisplayMode.FillContainer,
  backgroundColor: ex.Color.fromHex('#162344'), suppressPlayButton: true, suppressConsoleBootMessage: true });
game.add(new ex.Actor({ x: 100, y: 80, width: 80, height: 80, color: ex.Color.fromHex('#ffaa22') }));
await game.start();
game.on('postdraw', () => { (window as any).smokeReady = true; });
`;
  return `${common}\n(window as any).smokeReady = true;\n`;
}

export function planFor(testCase) {
  const root = `/workspace/100/${testCase.id}`;
  const inspect = (stage) => `async () => {
    for (let attempt = 0; attempt < 100 && (!window.smokeReady || document.querySelector('#data').textContent !== 'Local data loaded'); attempt++) await new Promise(r => setTimeout(r, 100));
    if (!window.smokeReady) throw new Error('Engine failed to render');
    ${testCase.kind === "game-2d" ? `const canvas = document.querySelector('#game canvas');
    const bounds = canvas.getBoundingClientRect();
    if (Math.abs(canvas.width - bounds.width * devicePixelRatio) > 1 || Math.abs(canvas.height - bounds.height * devicePixelRatio) > 1) throw new Error('Game canvas is being scaled instead of rendering at native display resolution');` : ""}
    if (document.querySelector('#data').textContent !== 'Local data loaded') throw new Error('Local fetch failed');
    if (document.querySelector('#stage').textContent !== '${stage}') throw new Error('Stale preview');
    if (document.querySelector('#greeting').textContent !== 'Hello Ada') throw new Error('Form failed');
    if (document.querySelector('#key').textContent !== 'ArrowRight') throw new Error('Keyboard failed');
    const image = document.querySelector('#asset');
    if (!image.complete || image.naturalWidth === 0) throw new Error('Local asset failed');
    document.querySelector('#bottom').scrollIntoView();
    if (scrollY === 0) throw new Error('Scroll failed');
    window.scrollTo(0, 0);
    const bytes = await (await fetch('js/main.js')).arrayBuffer();
    const bundleHash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))).map(b => b.toString(16).padStart(2, '0')).join('');
    return { interaction: 'passed', stage: '${stage}', bundleHash };
  }`;
  return [
    ["read", { filePath: `${root}/site/index.html` }],
    ["write", { filePath: `${root}/site/index.html`, content: html }],
    ["write", { filePath: `${root}/site/src/main.ts`, content: source(testCase.kind, "first") }],
    ["playwright_browser_navigate", { url: `http://127.0.0.1:8080/100/${testCase.id}/` }],
    ["playwright_browser_type", { target: "#name", text: "Ada" }],
    ["playwright_browser_click", { target: "#submit" }],
    ["playwright_browser_press_key", { key: "ArrowRight" }],
    ["playwright_browser_evaluate", { function: inspect("first") }],
    ["playwright_browser_click", { target: 'a[href="about.html"]' }],
    ["playwright_browser_evaluate", { function: "() => { if (document.querySelector('h1').textContent !== 'About the Docker check') throw new Error('Navigation failed'); return 'navigation passed'; }" }],
    ["playwright_browser_navigate_back", {}],
    ["playwright_browser_take_screenshot", {}],
    ["playwright_browser_resize", { width: 390, height: 844 }],
    ["playwright_browser_take_screenshot", {}],
    ["read", { filePath: `${root}/site/src/main.ts` }],
    ["write", { filePath: `${root}/site/src/main.ts`, content: source(testCase.kind, "updated") }],
    ["playwright_browser_navigate", { url: `http://127.0.0.1:8080/100/${testCase.id}/` }],
    ["playwright_browser_type", { target: "#name", text: "Ada" }],
    ["playwright_browser_click", { target: "#submit" }],
    ["playwright_browser_press_key", { key: "ArrowRight" }],
    ["playwright_browser_evaluate", { function: inspect("updated") }],
    ["playwright_browser_take_screenshot", {}],
    ["playwright_browser_console_messages", { level: "error" }],
    ["playwright_browser_evaluate", { function: "async () => { let blocked = false; try { await fetch('https://example.com', { signal: AbortSignal.timeout(1000) }); } catch { blocked = true; } if (!blocked) throw new Error('Preview escaped its local origin'); return 'external access blocked'; }" }],
    ["playwright_browser_close", {}],
  ];
}
