declare const WASM: string;
let E: any, B = 0, W = 0, H = 0, P = 0, n = 0, gen = 0, want = 0, q: any = null, busy = false;
const ready = WebAssembly.instantiate(Uint8Array.from(atob(WASM), c => c.charCodeAt(0))).then(r => {
  E = r.instance.exports;
  B = E.memory.buffer.byteLength;
});
const opt = (W: number, H: number): ImageBitmapOptions => ({ resizeWidth: W, resizeHeight: H, resizeQuality: 'high', premultiplyAlpha: 'none', colorSpaceConversion: 'none' });

onmessage = async ({ data: d }) => {
  await ready;
  if (d.files) {
    want = d.gen;
    const bs = await Promise.all(d.files.map((f: File) => createImageBitmap(f, opt(d.W, d.H))));
    if (want !== d.gen) return bs.forEach(b => b.close());
    (W = d.W), (H = d.H), (n = bs.length), (P = ((W * H + 3) & ~3) * 4);
    const need = B + (n + 1) * P - E.memory.buffer.byteLength;
    if (need > 0) E.memory.grow(Math.ceil(need / 65536));
    const cx = new OffscreenCanvas(W, H).getContext('2d', { willReadFrequently: true })!;
    bs.forEach((b, i) => {
      cx.clearRect(0, 0, W, H);
      cx.drawImage(b, 0, 0);
      b.close();
      const m = new Uint8Array(E.memory.buffer, B + i * P, P);
      m.fill(0, W * H * 4);
      m.set(cx.getImageData(0, 0, W, H).data);
    });
    gen = d.gen;
  } else q = d;
  if (!busy && gen && q) (busy = true), setTimeout(run);
};

function run() {
  busy = false;
  const { ref, tol } = q;
  if (ref >= n) return;
  const st = [];
  for (let i = 0; i < n; i++) {
    if (i === ref) { st.push(null); continue; }
    const c = E.diff(B + ref * P, B + i * P, B + n * P, P >> 4, tol * tol);
    st.push({ p: 10 * Math.log10(65025 / (E.sse() / (3 * W * H))), d: (100 * c) / W / H });
  }
  postMessage({ gen, st });
}
