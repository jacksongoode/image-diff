// Bundles the app into one file, docs/index.html: the wasm kernel is inlined into the worker,
// the worker into main.ts, and main.ts into the page.

async function bundle(entry: string, define: Record<string, string>) {
  const result = await Bun.build({ entrypoints: [entry], minify: true, define });
  if (!result.success) throw new AggregateError(result.logs);
  return result.outputs[0].text();
}

export async function build() {
  const wasm = Buffer.from(await Bun.file('diff.wasm').arrayBuffer()).toString('base64');
  const worker = await bundle('web/worker.ts', { WASM: JSON.stringify(wasm) });
  const main = await bundle('web/main.ts', { WORKER: JSON.stringify(worker) });
  const html = (await Bun.file('web/index.html').text())
    .replace(/\s*\n\s*/g, ' ') // collapse indentation and line breaks
    .replace('<script type="module" src="main.ts"></script>', () => `<script type="module">${main}</script>`);
  await Bun.write('docs/index.html', html);
  return html;
}

if (import.meta.main) console.log(`docs/index.html: ${(await build()).length} bytes`);
