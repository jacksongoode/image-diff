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
uniform int n, mode, cols, ref, solo, ord[8];
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
  vec2 e2 = min(p, tile - gap - p);
  if (mode == 0 && ord[k] == ref && min(e2.x, e2.y) < dpr) { o = vec4(AC, 1); return; }
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
let W = 0, H = 0, gen = 0, ref = 0, mode = 0, cols = 0, solo = -1, diffOn = true, raf = 0;
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
  gl.uniform1i(u('solo'), solo);
  gl.uniform1f(u('dpr'), d);
  gl.uniform1iv(u('ord'), [...ord, ...Array(MAX).fill(0)].slice(0, MAX));
  gl.uniform1f(u('tol'), +tolInput.value);
  gl.uniform1f(u('tint'), diffOn ? +tintInput.value : 0);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  labels(g);
}

function labels(g: ReturnType<typeof grid>) {
  const n = ord.length;
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

function renderChips() {
  if (dragged) return;
  chips.innerHTML = ord
    .map((l, k) => {
      const s = stats[l];
      const info = l === ref ? 'reference'
        : s ? `${isFinite(s.p) ? s.p.toFixed(1) + ' dB' : 'identical'} · ${s.d.toFixed(2)}%` : '…';
      return `<span draggable="true" data-k="${k}" class="${l === ref ? 'ref' : ''}"><i></i><u>${k + 1}</u>${esc(names[l])}<em>${info}</em></span>`;
    })
    .join('');
}

// Chips: click sets the reference; drag slides chips live and commits the order on release.
let dragged: HTMLElement | null = null;
const chipK = (e: Event) => (e.target as HTMLElement).closest<HTMLElement>('#chips span')?.dataset.k;
chips.onclick = e => {
  const k = chipK(e);
  if (k) (ref = ord[+k]), sync();
};
chips.ondragstart = e => {
  dragged = e.target as HTMLElement;
  requestAnimationFrame(() => dragged?.classList.add('ghost'));
};
chips.ondragover = e => {
  const t = (e.target as HTMLElement).closest('span');
  if (!dragged || !t || t === dragged) return;
  const r = t.getBoundingClientRect();
  chips.insertBefore(dragged, e.clientX > r.left + r.width / 2 ? t.nextSibling : t);
};
chips.ondragend = () => {
  ord = [...chips.children].map(c => ord[+(c as HTMLElement).dataset.k!]);
  dragged = null;
  renderChips();
  draw();
};

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
  (ref = 0), (solo = -1), (stats = []);
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

const track = (e: PointerEvent) => {
  const r = cv.getBoundingClientRect();
  mouse = [e.clientX - r.left, e.clientY - r.top];
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
