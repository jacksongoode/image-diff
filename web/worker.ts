// Computes PSNR and the share of differing pixels for each image against the reference.
// Images are packed back to back in wasm memory, each padded to whole 16-byte SIMD blocks.
declare const WASM: string;

type Kernel = {
  memory: WebAssembly.Memory;
  diff(a: number, b: number, chunks: number, t2: number): number;
  sse(): number;
};

let kernel: Kernel;
let base = 0; // first free byte after the kernel's own memory
let width = 0, height = 0, stride = 0, count = 0, loaded = 0, gen = 0;
let canvas: OffscreenCanvasRenderingContext2D;
let request: { ref: number; tol: number } | null = null;
let scheduled = false;

const ready = WebAssembly.instantiate(Uint8Array.from(atob(WASM), c => c.charCodeAt(0))).then(r => {
  kernel = r.instance.exports as unknown as Kernel;
  base = kernel.memory.buffer.byteLength;
});

onmessage = async ({ data }) => {
  await ready;
  if ('count' in data) {
    ({ gen, width, height, count } = data);
    loaded = 0;
    stride = Math.ceil((width * height) / 4) * 16;
    const missing = base + count * stride - kernel.memory.buffer.byteLength;
    if (missing > 0) kernel.memory.grow(Math.ceil(missing / 65536));
    canvas = new OffscreenCanvas(width, height).getContext('2d', { willReadFrequently: true })!;
  } else if ('bitmap' in data) {
    if (data.gen === gen) addLayer(data.layer, data.bitmap);
    data.bitmap.close();
  } else {
    request = data;
  }
  // Coalesce bursts of slider updates into one run.
  if (!scheduled && request && count && loaded === count) {
    scheduled = true;
    setTimeout(run);
  }
};

function addLayer(layer: number, bitmap: ImageBitmap) {
  canvas.clearRect(0, 0, width, height);
  canvas.drawImage(bitmap, 0, 0);
  const slot = new Uint8Array(kernel.memory.buffer, base + layer * stride, stride);
  slot.set(canvas.getImageData(0, 0, width, height).data);
  slot.fill(0, width * height * 4);
  loaded++;
}

function run() {
  scheduled = false;
  const { ref, tol } = request!;
  const pixels = width * height;
  const stats = Array.from({ length: count }, (_, i) => {
    if (i === ref) return null;
    const differing = kernel.diff(base + ref * stride, base + i * stride, stride / 16, tol * tol);
    const mse = kernel.sse() / (3 * pixels);
    return { psnr: 10 * Math.log10((255 * 255) / mse), percent: (100 * differing) / pixels };
  });
  postMessage({ gen, stats });
}
