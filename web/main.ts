declare const WORKER: string;

const MAX_IMAGES = 8;
const GAP = 8; // CSS px between tiles
const TILE = 0, OVERLAY = 1, SPREAD = 2;

const $ = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector(selector) as T;
const canvas = $<HTMLCanvasElement>('#canvas');
const labelLayer = $('#labels');
const chips = $('#chips');
const toleranceInput = $<HTMLInputElement>('#tolerance');
const tintInput = $<HTMLInputElement>('#tint');
const fileInput = $<HTMLInputElement>('#files');

// --- GPU ----------------------------------------------------------------------------------------
// Every image is one layer of a texture array. A single fullscreen pass draws the current view and
// the diff, so panning, zooming and moving the tolerance only touch on-screen pixels.

const gl = canvas.getContext('webgl2', { antialias: false, alpha: false })!;

const VERTEX = `#version 300 es
void main() { gl_Position = vec4(vec2(gl_VertexID & 1, gl_VertexID >> 1) * 4. - 1., 0, 1); }`;

const FRAGMENT = `#version 300 es
precision highp float;
precision highp sampler2DArray;

const int TILE = ${TILE}, OVERLAY = ${OVERLAY}, SPREAD = ${SPREAD};
const vec3 BG = vec3(.059, .059, .063), WELL = vec3(.075, .075, .08), ACCENT = vec3(.85, .42, .44);
const float TAU = 6.2831853;

uniform sampler2DArray images;
uniform int count, mode, cols, ref, solo, order[${MAX_IMAGES}];
uniform vec2 canvasSize, tileSize, imageSize, mouse;
uniform vec3 view; // pan x, pan y, scale
uniform float gap, tolerance, tint, dpr;
out vec4 color;

vec3 filtered(int layer, vec2 uv) { return texture(images, vec3(uv, layer)).rgb; }
vec3 texel(int layer, vec2 uv) { return texelFetch(images, ivec3(uv * imageSize, layer), 0).rgb; }

void main() {
  vec2 frag = vec2(gl_FragCoord.x, canvasSize.y - gl_FragCoord.y);
  ivec2 cell = mode == TILE ? ivec2(frag / tileSize) : ivec2(0);
  int slot = cell.y * cols + cell.x;
  vec2 inner = tileSize - gap;
  vec2 p = frag - vec2(cell) * tileSize - gap * .5;

  color = vec4(BG, 1);
  if (slot >= count || cell.x >= cols || any(lessThan(p, vec2(0))) || any(greaterThan(p, inner))) return;

  vec2 border = min(p, inner - p);
  if (mode == TILE && order[slot] == ref && min(border.x, border.y) < dpr) {
    color = vec4(ACCENT, 1);
    return;
  }

  vec2 uv = (p - view.xy) / view.z / imageSize;
  color = vec4(WELL, 1);
  if (any(lessThan(uv, vec2(0))) || any(greaterThanEqual(uv, vec2(1)))) return;

  // Overlay: one wedge per image around the cursor. seam = distance to the nearest wedge edge.
  float seam = 1e9;
  if (mode == OVERLAY) {
    if (solo >= 0) {
      slot = solo;
    } else {
      vec2 d = frag - mouse;
      float a = (atan(d.y, d.x) / TAU + .5) * float(count);
      slot = int(a) % count;
      seam = min(fract(a), 1. - fract(a)) * TAU / float(count) * length(d);
    }
  }
  int layer = order[slot];
  vec3 rgb = filtered(layer, uv);

  if (mode == SPREAD) {
    // Per-pixel RGB range across all images, drawn as heat over a dimmed reference.
    vec3 lo = vec3(1), hi = vec3(0);
    for (int i = 0; i < count; i++) {
      vec3 q = texel(i, uv);
      lo = min(lo, q);
      hi = max(hi, q);
    }
    float spread = length(hi - lo) * 255.;
    vec3 base = vec3(dot(filtered(ref, uv), vec3(.299, .587, .114)) * .3);
    vec3 heat = mix(vec3(.35, .14, .24), vec3(1., .85, .74), sqrt(min(spread / 128., 1.)));
    rgb = spread >= tolerance ? mix(base, heat, max(tint, .2)) : base;
  } else if (layer != ref && tint > 0. && length(texel(layer, uv) - texel(ref, uv)) * 255. >= tolerance - 1e-3) {
    rgb = mix(rgb, ACCENT, tint);
  }
  if (seam < 1.) rgb = mix(rgb, vec3(1), .35 * (1. - seam));
  color = vec4(rgb, 1);
}`;

function compile(type: number, source: string) {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader)!);
  return shader;
}

const program = gl.createProgram()!;
gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX));
gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAGMENT));
gl.linkProgram(program);
gl.useProgram(program);

const uniforms = new Map<string, WebGLUniformLocation | null>();
function uniform(name: string) {
  if (!uniforms.has(name)) uniforms.set(name, gl.getUniformLocation(program, name));
  return uniforms.get(name)!;
}

// --- State --------------------------------------------------------------------------------------

type Stat = { psnr: number; percent: number } | null;

let imageW = 0, imageH = 0;
let names: string[] = [];
let order: number[] = []; // display slot -> texture layer
let stats: Stat[] = []; // by layer
let ref = 0; // reference layer
let mode = TILE;
let cols = 0; // 0 = automatic
let solo = -1; // slot shown alone in overlay, or -1
let diffOn = true;
let view = { x: 0, y: 0, s: 1 }; // shared pan/zoom inside each tile, CSS px
let mouse = [0, 0];
let texture: WebGLTexture | null = null;
let gen = 0; // bumped per load so stale decodes and stats are dropped
let frame = 0;

const worker = new Worker(URL.createObjectURL(new Blob([WORKER], { type: 'text/javascript' })), { type: 'module' });
worker.onmessage = ({ data }) => {
  if (data.gen !== gen) return;
  stats = data.stats;
  renderChips();
};

// --- Layout and drawing -------------------------------------------------------------------------

function grid() {
  const n = order.length;
  const c = mode === TILE ? Math.min(cols || Math.ceil(Math.sqrt(n)), n) : 1;
  const rows = mode === TILE ? Math.ceil(n / c) : 1;
  return { cols: c, w: canvas.clientWidth / c, h: canvas.clientHeight / rows };
}

function fit() {
  const g = grid();
  const w = g.w - GAP, h = g.h - GAP;
  const s = Math.min(w / imageW, h / imageH);
  view = { s, x: (w - imageW * s) / 2, y: (h - imageH * s) / 2 };
  draw();
}

function draw() {
  frame ||= requestAnimationFrame(render);
}

function render() {
  frame = 0;
  const dpr = devicePixelRatio;
  const w = Math.round(canvas.clientWidth * dpr), h = Math.round(canvas.clientHeight * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  gl.viewport(0, 0, w, h);
  gl.clearColor(0.059, 0.059, 0.063, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  if (!order.length) return;

  const g = grid();
  gl.uniform2f(uniform('canvasSize'), w, h);
  gl.uniform2f(uniform('tileSize'), g.w * dpr, g.h * dpr);
  gl.uniform2f(uniform('imageSize'), imageW, imageH);
  gl.uniform2f(uniform('mouse'), mouse[0] * dpr, mouse[1] * dpr);
  gl.uniform3f(uniform('view'), view.x * dpr, view.y * dpr, view.s * dpr);
  gl.uniform1f(uniform('gap'), GAP * dpr);
  gl.uniform1f(uniform('dpr'), dpr);
  gl.uniform1i(uniform('count'), order.length);
  gl.uniform1i(uniform('mode'), mode);
  gl.uniform1i(uniform('cols'), g.cols);
  gl.uniform1i(uniform('ref'), ref);
  gl.uniform1i(uniform('solo'), solo);
  gl.uniform1iv(uniform('order'), order);
  gl.uniform1f(uniform('tolerance'), +toleranceInput.value);
  gl.uniform1f(uniform('tint'), diffOn ? +tintInput.value : 0);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  renderLabels(g);
}

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, c => `&#${c.charCodeAt(0)};`);

function renderLabels(g: ReturnType<typeof grid>) {
  let slots = order.map((_, slot) => slot);
  if (mode === SPREAD) slots = [];
  if (mode === OVERLAY && solo >= 0) slots = [solo];

  labelLayer.innerHTML = slots
    .map(slot => {
      let x = GAP / 2, y = GAP / 2;
      if (mode === TILE) {
        x += (slot % g.cols) * g.w;
        y += Math.floor(slot / g.cols) * g.h;
      } else if (mode === OVERLAY && solo < 0) {
        // Middle of the slot's wedge, matching the shader's angle mapping.
        const angle = ((slot + 0.5) / order.length - 0.5) * 2 * Math.PI;
        x = mouse[0] + Math.cos(angle) * 110 - 30;
        y = mouse[1] + Math.sin(angle) * 110 - 16;
      }
      return `<div style="left:${x}px;top:${y}px">${slot + 1} ${escapeHtml(names[order[slot]])}</div>`;
    })
    .join('');
}

// --- Chips --------------------------------------------------------------------------------------
// Click or Enter sets the reference. Dragging moves the chip live; the order commits on release.
// Alt+arrows move the focused chip.

let dragged: HTMLElement | null = null;

function chipInfo(layer: number) {
  if (layer === ref) return 'reference';
  const s = stats[layer];
  if (!s) return '…';
  const psnr = isFinite(s.psnr) ? `${s.psnr.toFixed(1)} dB` : 'identical';
  return `${psnr} · ${s.percent.toFixed(2)}%`;
}

function renderChips() {
  if (dragged) return;
  const focused = [...chips.children].indexOf(document.activeElement!);
  chips.innerHTML = order
    .map(
      (layer, slot) =>
        `<span draggable="true" data-slot="${slot}" role="button" tabindex="0" aria-pressed="${layer === ref}">` +
        `<i></i><u>${slot + 1}</u>${escapeHtml(names[layer])}<em>${chipInfo(layer)}</em></span>`,
    )
    .join('');
  (chips.children[focused] as HTMLElement | undefined)?.focus();
}

const chipSlot = (e: Event) => {
  const chip = (e.target as HTMLElement).closest<HTMLElement>('#chips span');
  return chip ? +chip.dataset.slot! : -1;
};

chips.onclick = e => {
  const slot = chipSlot(e);
  if (slot >= 0) setRef(order[slot]);
};

chips.onkeydown = e => {
  const slot = chipSlot(e);
  if (slot < 0) return;
  const step = e.altKey ? ({ ArrowLeft: -1, ArrowRight: 1 } as Record<string, number>)[e.key] : undefined;
  const target = slot + (step ?? 0);
  if (e.key === 'Enter' || e.key === ' ') {
    setRef(order[slot]);
  } else if (step && target >= 0 && target < order.length) {
    [order[slot], order[target]] = [order[target], order[slot]];
    renderChips();
    draw();
    (chips.children[target] as HTMLElement).focus();
  } else {
    return;
  }
  e.preventDefault();
};

chips.ondragstart = e => {
  dragged = e.target as HTMLElement;
  // Fade after the browser has captured the drag image.
  requestAnimationFrame(() => dragged?.classList.add('ghost'));
};

chips.ondragover = e => {
  const over = (e.target as HTMLElement).closest('span');
  if (!dragged || !over || over === dragged) return;
  const r = over.getBoundingClientRect();
  chips.insertBefore(dragged, e.clientX > r.left + r.width / 2 ? over.nextSibling : over);
};

chips.ondragend = () => {
  order = [...chips.children].map(chip => order[+(chip as HTMLElement).dataset.slot!]);
  dragged = null;
  renderChips();
  draw();
};

// --- Loading ------------------------------------------------------------------------------------
// Each file is decoded once, off the main thread, at the first image's size. The bitmap goes to the
// GPU as soon as it lands and is then handed (not copied) to the worker for stats.

function createTexture(layers: number) {
  const t = gl.createTexture();
  const target = gl.TEXTURE_2D_ARRAY;
  gl.bindTexture(target, t);
  gl.texStorage3D(target, Math.floor(Math.log2(Math.max(imageW, imageH))) + 1, gl.RGBA8, imageW, imageH, layers);
  gl.texParameteri(target, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(target, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(target, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(target, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return t;
}

async function load(list: FileList) {
  const files = [...list].filter(f => f.type.startsWith('image/')).slice(0, MAX_IMAGES);
  if (!files.length) return;

  const first = await createImageBitmap(files[0]);
  const maxSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
  const scale = Math.min(1, maxSize / first.width, maxSize / first.height);
  imageW = Math.round(first.width * scale);
  imageH = Math.round(first.height * scale);
  first.close();

  const myGen = ++gen;
  names = files.map(f => f.name);
  order = files.map((_, i) => i);
  stats = [];
  ref = 0;
  solo = -1;
  $('#empty').hidden = true;
  if (texture) gl.deleteTexture(texture);
  texture = createTexture(files.length);
  worker.postMessage({ gen, width: imageW, height: imageH, count: files.length });
  fit();
  update();

  const options: ImageBitmapOptions = {
    resizeWidth: imageW,
    resizeHeight: imageH,
    resizeQuality: 'high',
    premultiplyAlpha: 'none',
    colorSpaceConversion: 'none',
  };
  await Promise.all(
    files.map(async (file, layer) => {
      const bitmap = await createImageBitmap(file, options);
      if (myGen !== gen) return bitmap.close();
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, texture);
      gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, layer, imageW, imageH, 1, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
      gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
      draw();
      worker.postMessage({ gen: myGen, layer, bitmap }, [bitmap]);
    }),
  );
}

// --- Controls -----------------------------------------------------------------------------------

// Refreshes everything that depends on the reference or tolerance.
function update() {
  $('#tolerance-value').textContent = toleranceInput.value;
  worker.postMessage({ ref, tol: +toleranceInput.value });
  renderChips();
  draw();
}

function setRef(layer: number) {
  ref = layer;
  update();
}

function setMode(m: number) {
  mode = m;
  document.querySelectorAll<HTMLElement>('#modes button').forEach(b => {
    b.setAttribute('aria-pressed', String(+b.dataset.mode! === m));
  });
  $('#cols').inert = m !== TILE;
  if (order.length) fit();
}

function setCols(c: number) {
  cols = Math.max(0, Math.min(MAX_IMAGES, c));
  $('#cols-value').textContent = cols ? String(cols) : 'auto';
  if (order.length) fit();
}

function toggleDiff() {
  diffOn = !diffOn;
  $('#diff').setAttribute('aria-pressed', String(diffOn));
  draw();
}

$('#modes').onclick = e => {
  const m = (e.target as HTMLElement).dataset.mode;
  if (m) setMode(+m);
};
$('#cols-less').onclick = () => setCols((cols || grid().cols) - 1);
$('#cols-more').onclick = () => setCols((cols || grid().cols) + 1);
$('#diff').onclick = toggleDiff;
toleranceInput.oninput = update;
tintInput.oninput = draw;
fileInput.onchange = () => load(fileInput.files!);

onresize = () => order.length && fit();
ondragover = e => e.preventDefault();
ondrop = e => {
  e.preventDefault();
  if (e.dataTransfer?.files.length) load(e.dataTransfer.files);
};

// --- Pan and zoom -------------------------------------------------------------------------------

let panFrom: { x: number; y: number } | null = null;

canvas.onpointerdown = e => {
  canvas.setPointerCapture(e.pointerId);
  panFrom = { x: e.clientX, y: e.clientY };
};
canvas.onpointerup = canvas.onpointercancel = () => (panFrom = null);
canvas.onpointermove = e => {
  const r = canvas.getBoundingClientRect();
  mouse = [e.clientX - r.left, e.clientY - r.top];
  if (panFrom) {
    view.x += e.clientX - panFrom.x;
    view.y += e.clientY - panFrom.y;
    panFrom = { x: e.clientX, y: e.clientY };
  }
  if (panFrom || mode === OVERLAY) draw();
};

// Zoom around the cursor's position inside its tile.
canvas.onwheel = e => {
  e.preventDefault();
  const r = canvas.getBoundingClientRect(), g = grid();
  let x = e.clientX - r.left, y = e.clientY - r.top;
  if (mode === TILE) {
    x %= g.w;
    y %= g.h;
  }
  x -= GAP / 2;
  y -= GAP / 2;
  const k = Math.exp(-e.deltaY / 300);
  view = { x: x - (x - view.x) * k, y: y - (y - view.y) * k, s: view.s * k };
  draw();
};

// --- Keys ---------------------------------------------------------------------------------------
// 1–8 show one image in overlay, 0/Esc show all, t/o/s switch view, f fits, d toggles the diff.

const MODE_KEYS: Record<string, number> = { t: TILE, o: OVERLAY, s: SPREAD };

onkeydown = e => {
  if (e.target instanceof HTMLInputElement) return;
  const n = Number(e.key);
  if (n >= 1 && n <= order.length) {
    solo = solo === n - 1 ? -1 : n - 1;
    if (mode !== OVERLAY) setMode(OVERLAY);
  } else if (e.key === '0' || e.key === 'Escape') {
    solo = -1;
  } else if (e.key in MODE_KEYS) {
    setMode(MODE_KEYS[e.key]);
  } else if (e.key === 'f') {
    fit();
  } else if (e.key === 'd') {
    toggleDiff();
  } else {
    return;
  }
  draw();
};

draw();
