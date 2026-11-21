declare const WORKER: string;

const $ = <T extends HTMLElement = HTMLElement>(s: string) => document.querySelector(s) as T;
const cv = $<HTMLCanvasElement>('#c');
const lab = $('#lab');
const chips = $('#chips');
const tolInput = $<HTMLInputElement>('#tol');
const tintInput = $<HTMLInputElement>('#al');
const gl = cv.getContext('webgl2', { antialias: false, alpha: false })!;
const GAP = 8;
const MAX = 8;

// All images live in one RGBA8 texture array; one fullscreen pass draws every view and the diff,
// so pan/zoom/tolerance only touch on-screen pixels and never copy image data on the CPU.
const VS = `#version 300 es
void main() { gl_Position = vec4(vec2(gl_VertexID & 1, gl_VertexID >> 1) * 4. - 1., 0, 1); }`;

const FS = `#version 300 es
precision highp float;
precision highp sampler2DArray;
uniform sampler2DArray T;
uniform int n, mode, cols, ref, solo, hot, ord[8];
uniform vec2 res, tile, img, mouse;
uniform vec3 view;
uniform float gap, tol, tint, dpr;
out vec4 o;
const vec3 BG = vec3(.059, .059, .063), WELL = vec3(.075, .075, .08), AC = vec3(.85, .42, .44);

vec3 smp(int l, vec2 uv) { return texture(T, vec3(uv, l)).rgb; }
vec3 px(int l, vec2 uv) { return texelFetch(T, ivec3(uv * img, l), 0).rgb; }

void main() {
  vec2 f = vec2(gl_FragCoord.x, res.y - gl_FragCoord.y);
  ivec2 c = mode == 0 ? ivec2(f / tile) : ivec2(0);
  int k = c.y * cols + c.x;
  vec2 p = f - vec2(c) * tile - gap * .5;
  vec2 uv = (p - view.xy) / view.z / img;
  o = vec4(BG, 1);
  if (k >= n || c.x >= cols || any(lessThan(p, vec2(0))) || any(greaterThan(p, tile - gap))) return;
  // Tile frames: accent for the reference, soft white for the hovered or dragged chip.
  vec2 e2 = min(p, tile - gap - p);
  if (mode == 0 && min(e2.x, e2.y) < dpr && (ord[k] == ref || k == hot)) {
    o = vec4(k == hot ? vec3(.62) : AC, 1);
    return;
  }
  o = vec4(WELL, 1);
  if (any(lessThan(uv, vec2(0))) || any(greaterThanEqual(uv, vec2(1)))) return;

  // Overlay: n angular wedges around the cursor, one image per wedge.
  float edge = 1e9;
  if (mode == 1) {
    vec2 d = f - mouse;
    float a = (atan(d.y, d.x) / 6.2831853 + .5) * float(n);
    k = solo >= 0 ? solo : int(a) % n;
    float fr = fract(a);
    if (solo < 0) edge = min(fr, 1. - fr) * 6.2831853 / float(n) * length(d);
  }
  int l = ord[k];
  vec3 col = smp(l, uv);

  if (mode == 2) {
    // Spread: per-pixel RGB range across all n images, no reference needed.
    vec3 lo = vec3(1), hi = vec3(0);
    for (int i = 0; i < 8; i++) {
      if (i >= n) break;
      vec3 q = px(i, uv);
      lo = min(lo, q);
      hi = max(hi, q);
    }
    float s = length(hi - lo) * 255.;
    vec3 base = vec3(dot(smp(ref, uv), vec3(.299, .587, .114)) * .3);
    vec3 heat = mix(vec3(.35, .14, .24), vec3(1., .85, .74), sqrt(min(s / 128., 1.)));
    col = s >= tol ? mix(base, heat, max(tint, .2)) : base;
  } else if (l != ref && tint > 0. && length(px(l, uv) - px(ref, uv)) * 255. >= tol - 1e-3) {
    col = mix(col, AC, tint);
  }
  if (edge < 1.) col = mix(col, vec3(1), .35 * (1. - edge));
  o = vec4(col, 1);
}`;

function shader(type: number, src: string) {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)!);
  return s;
}
const prog = gl.createProgram()!;
gl.attachShader(prog, shader(gl.VERTEX_SHADER, VS));
gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, FS));
gl.linkProgram(prog);
gl.useProgram(prog);
const locs: Record<string, WebGLUniformLocation | null> = {};
const u = (name: string) => (locs[name] ??= gl.getUniformLocation(prog, name));

const worker = new Worker(URL.createObjectURL(new Blob([WORKER], { type: 'text/javascript' })), { type: 'module' });

type Stat = { p: number; d: number } | null;
let W = 0, H = 0, gen = 0, ref = 0, mode = 0, cols = 0, solo = -1, hot = -1, diffOn = true, raf = 0;
let chipEls: HTMLElement[] = [], dragging = false, held: HTMLElement | null = null;
// Hovering a chip in overlay previews that image solo.
const shownSolo = () => (mode === 1 && hot >= 0 ? ord.indexOf(hot) : solo);
let names: string[] = [], ord: number[] = [], stats: Stat[] = [];
let view = { x: 0, y: 0, s: 1 }, mouse = [0, 0];
let tex: WebGLTexture | null = null;

const esc = (s: string) => s.replace(/[&<>"]/g, c => `&#${c.charCodeAt(0)};`);

function grid() {
  const n = ord.length;
  const c = mode ? 1 : Math.min(cols || Math.ceil(Math.sqrt(n)), n);
  const r = mode ? 1 : Math.ceil(n / c);
  return { c, w: cv.clientWidth / c, h: cv.clientHeight / r };
}

function fit() {
  const g = grid(), iw = g.w - GAP, ih = g.h - GAP, s = Math.min(iw / W, ih / H);
  view = { s, x: (iw - W * s) / 2, y: (ih - H * s) / 2 };
  draw();
}

const draw = () => (raf ||= requestAnimationFrame(render));

function render() {
  raf = 0;
  const d = devicePixelRatio, w = Math.round(cv.clientWidth * d), h = Math.round(cv.clientHeight * d);
  if (cv.width !== w || cv.height !== h) (cv.width = w), (cv.height = h);
  gl.viewport(0, 0, w, h);
  gl.clearColor(0.059, 0.059, 0.063, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  if (!ord.length) return;
  const g = grid();
  gl.uniform2f(u('res'), w, h);
  gl.uniform2f(u('tile'), g.w * d, g.h * d);
  gl.uniform1f(u('gap'), GAP * d);
  gl.uniform2f(u('img'), W, H);
  gl.uniform3f(u('view'), view.x * d, view.y * d, view.s * d);
  gl.uniform2f(u('mouse'), mouse[0] * d, mouse[1] * d);
  gl.uniform1i(u('n'), ord.length);
  gl.uniform1i(u('mode'), mode);
  gl.uniform1i(u('cols'), g.c);
  gl.uniform1i(u('ref'), ref);
  gl.uniform1i(u('solo'), shownSolo());
  gl.uniform1i(u('hot'), hot >= 0 ? ord.indexOf(hot) : -1);
  gl.uniform1f(u('dpr'), d);
  gl.uniform1iv(u('ord'), [...ord, ...Array(MAX).fill(0)].slice(0, MAX));
  gl.uniform1f(u('tol'), +tolInput.value);
  gl.uniform1f(u('tint'), diffOn ? +tintInput.value : 0);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  labels(g);
}

function labels(g: ReturnType<typeof grid>) {
  const n = ord.length;
  const solo = shownSolo();
  let slots = ord.map((_, k) => k);
  if (mode === 2) slots = [];
  else if (mode === 1 && solo >= 0) slots = [solo];
  lab.innerHTML = slots
    .map(k => {
      let x = GAP / 2, y = GAP / 2;
      if (mode === 0) (x += (k % g.c) * g.w), (y += Math.floor(k / g.c) * g.h);
      else if (solo < 0) {
        const a = ((k + 0.5) / n - 0.5) * 2 * Math.PI;
        (x = mouse[0] + Math.cos(a) * 110 - 30), (y = mouse[1] + Math.sin(a) * 110 - 16);
      }
      return `<div style="left:${x}px;top:${y}px">${k + 1} ${esc(names[ord[k]])}</div>`;
    })
    .join('');
}

function makeChips() {
  chipEls = names.map((name, l) => {
    const el = document.createElement('span');
    el.innerHTML = `<i></i><u></u>${esc(name)}<em></em>`;
    el.onpointerdown = e => grab(e, l);
    el.onpointerenter = () => !dragging && setHot(l);
    el.onpointerleave = () => !dragging && setHot(-1);
    return el;
  });
  chips.replaceChildren(...chipEls);
  renderChips();
}

// Updates chips in place and keeps DOM order in sync with `ord`. The held chip never moves in the
// DOM (that would drop its pointer capture); the others are placed around it.
function renderChips() {
  const at = held ? ord.indexOf(chipEls.indexOf(held)) : -1;
  ord.forEach((l, k) => {
    const el = chipEls[l], s = stats[l];
    if (el !== held) k < at ? chips.insertBefore(el, held) : chips.append(el);
    el.classList.toggle('ref', l === ref);
    el.querySelector('u')!.textContent = String(k + 1);
    el.querySelector('em')!.textContent = l === ref ? 'reference'
      : s ? `${isFinite(s.p) ? s.p.toFixed(1) + ' dB' : 'identical'} · ${s.d.toFixed(2)}%` : '…';
  });
}

function setHot(l: number) {
  hot = l;
  chipEls.forEach((c, m) => c.classList.toggle('hot', m === l));
  draw();
}

// FLIP: move layer `l` to slot `k`, then slide the other chips from where they were.
function move(l: number, k: number) {
  const others = chipEls.filter((_, m) => m !== l);
  const first = others.map(c => c.getBoundingClientRect());
  ord.splice(k, 0, ord.splice(ord.indexOf(l), 1)[0]);
  renderChips();
  others.forEach((c, i) => {
    c.style.transition = 'none';
    c.style.transform = '';
    const b = c.getBoundingClientRect();
    c.style.transform = `translate(${first[i].left - b.left}px,${first[i].top - b.top}px)`;
  });
  chips.offsetWidth;
  others.forEach(c => ((c.style.transition = ''), (c.style.transform = '')));
  draw();
}

// Press and release sets the reference; press and drag lifts the chip and reorders live.
function grab(e: PointerEvent, l: number) {
  const el = chipEls[l], r = el.getBoundingClientRect(), x0 = e.clientX, y0 = e.clientY;
  const dx = x0 - r.left, dy = y0 - r.top;
  held = el;
  el.setPointerCapture(e.pointerId);
  el.onpointermove = e => {
    if (!dragging && Math.hypot(e.clientX - x0, e.clientY - y0) < 4) return;
    dragging = true;
    el.classList.add('lift');
    const f = chips.getBoundingClientRect();
    let best = ord.indexOf(l), bd = Infinity;
    ord.forEach((m, k) => {
      const c = chipEls[m];
      const d = Math.hypot(f.left + c.offsetLeft + c.offsetWidth / 2 - e.clientX, f.top + c.offsetTop + c.offsetHeight / 2 - e.clientY);
      if (d < bd) (bd = d), (best = k);
    });
    if (best !== ord.indexOf(l)) move(l, best);
    el.style.transform = `translate(${e.clientX - dx - f.left - el.offsetLeft}px,${e.clientY - dy - f.top - el.offsetTop}px) scale(1.04)`;
  };
  el.onpointerup = el.onpointercancel = el.onlostpointercapture = () => {
    el.onpointermove = el.onpointerup = el.onpointercancel = el.onlostpointercapture = null;
    held = null;
    if (!dragging) return (ref = l), sync();
    dragging = false;
    el.classList.remove('lift');
    el.style.transform = '';
  };
}

function sync() {
  $('#tv').textContent = tolInput.value;
  worker.postMessage({ ref, tol: +tolInput.value });
  renderChips();
  draw();
}

worker.onmessage = ({ data }) => {
  if (data.gen !== gen) return;
  stats = data.st;
  renderChips();
};

async function load(list: FileList | File[]) {
  const files = [...list].filter(f => f.type.startsWith('image/')).slice(0, MAX);
  if (!files.length) return;
  const first = await createImageBitmap(files[0]);
  const lim = gl.getParameter(gl.MAX_TEXTURE_SIZE), k = Math.min(1, lim / first.width, lim / first.height);
  W = Math.round(first.width * k);
  H = Math.round(first.height * k);
  first.close();

  gen++;
  names = files.map(f => f.name);
  ord = files.map((_, i) => i);
  (ref = 0), (solo = -1), (hot = -1), (stats = []);
  makeChips();
  $('#empty').hidden = true;
  if (tex) gl.deleteTexture(tex);
  tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex);
  gl.texStorage3D(gl.TEXTURE_2D_ARRAY, Math.floor(Math.log2(Math.max(W, H))) + 1, gl.RGBA8, W, H, files.length);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  fit();
  worker.postMessage({ files, gen, W, H });
  sync();

  // Decode in parallel off the main thread and stream each layer straight to the GPU as it lands.
  const g = gen, t = tex;
  const opt: ImageBitmapOptions = { resizeWidth: W, resizeHeight: H, resizeQuality: 'high', premultiplyAlpha: 'none', colorSpaceConversion: 'none' };
  await Promise.all(
    files.map(async (f, i) => {
      const b = await createImageBitmap(f, opt);
      if (g === gen) {
        gl.bindTexture(gl.TEXTURE_2D_ARRAY, t);
        gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, i, W, H, 1, gl.RGBA, gl.UNSIGNED_BYTE, b);
        gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
        draw();
      }
      b.close();
    }),
  );
}

function setMode(m: number) {
  mode = m;
  document.querySelectorAll<HTMLElement>('#modes a').forEach(a => a.classList.toggle('on', +a.dataset.m! === m));
  $('#colc').classList.toggle('off', m !== 0);
  if (ord.length) fit();
}

function setCols(c: number) {
  cols = Math.max(0, Math.min(MAX, c));
  $('#cn').textContent = cols ? String(cols) : 'auto';
  if (ord.length) fit();
}

function toggleDiff() {
  diffOn = !diffOn;
  $('#dt').classList.toggle('on', diffOn);
  draw();
}

$('#modes').onclick = e => {
  const m = (e.target as HTMLElement).dataset.m;
  if (m) setMode(+m);
};
$('#cm').onclick = () => setCols((cols || grid().c) - 1);
$('#cp').onclick = () => setCols((cols || grid().c) + 1);
$('#dt').onclick = toggleDiff;
tolInput.oninput = sync;
tintInput.oninput = draw;
const fileInput = $<HTMLInputElement>('#fi');
fileInput.onchange = () => load(fileInput.files!);
onresize = () => ord.length && fit();
ondragover = e => e.preventDefault();
ondrop = e => {
  e.preventDefault();
  if (e.dataTransfer?.files.length) load(e.dataTransfer.files);
};

// Slot under the pointer: the tile in tile view, the solo image in overlay.
function slotAt(e: MouseEvent) {
  const r = cv.getBoundingClientRect(), g = grid();
  if (mode === 1) return solo;
  if (mode !== 0) return -1;
  const c = Math.floor((e.clientX - r.left) / g.w), k = Math.floor((e.clientY - r.top) / g.h) * g.c + c;
  return c < g.c && k < ord.length ? k : -1;
}
cv.ondblclick = e => {
  const k = slotAt(e);
  if (k >= 0) (ref = ord[k]), sync();
};
cv.onpointerleave = () => chipEls.forEach(c => c.classList.remove('hot'));

const track = (e: PointerEvent) => {
  const r = cv.getBoundingClientRect();
  mouse = [e.clientX - r.left, e.clientY - r.top];
  if (mode === 0) {
    const k = slotAt(e);
    chipEls.forEach((c, m) => c.classList.toggle('hot', ord[k] === m));
  }
  if (mode === 1) draw();
};
cv.onpointermove = track;
cv.onpointerdown = e => {
  cv.setPointerCapture(e.pointerId);
  let x = e.clientX, y = e.clientY;
  cv.onpointermove = e => {
    track(e);
    view.x += e.clientX - x;
    view.y += e.clientY - y;
    (x = e.clientX), (y = e.clientY);
    draw();
  };
};
cv.onpointerup = () => (cv.onpointermove = track);
cv.onwheel = e => {
  e.preventDefault();
  const r = cv.getBoundingClientRect(), g = grid();
  let x = e.clientX - r.left, y = e.clientY - r.top;
  if (mode === 0) (x %= g.w), (y %= g.h);
  (x -= GAP / 2), (y -= GAP / 2);
  const k = Math.exp(-e.deltaY / 300);
  view.x = x - (x - view.x) * k;
  view.y = y - (y - view.y) * k;
  view.s *= k;
  draw();
};

onkeydown = e => {
  if (e.target instanceof HTMLInputElement) return;
  const k = e.key;
  if (k >= '1' && k <= '8' && +k <= ord.length) {
    solo = solo === +k - 1 ? -1 : +k - 1;
    if (mode !== 1) setMode(1);
  } else if (k === '0' || k === 'Escape') solo = -1;
  else if ('tos'.includes(k)) setMode('tos'.indexOf(k));
  else if (k === 'f') fit();
  else if (k === 'd') toggleDiff();
  else return;
  draw();
};
