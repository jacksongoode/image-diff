const wasm = Buffer.from(await Bun.file('diff.wasm').arrayBuffer()).toString('base64');
const js = async (entry: string, define: Record<string, string>) => {
  const r = await Bun.build({ entrypoints: [entry], minify: true, define });
  if (!r.success) throw new AggregateError(r.logs);
  return r.outputs[0].text();
};
export async function build() {
  const worker = await js('web/worker.ts', { WASM: JSON.stringify(wasm) });
  const main = await js('web/main.ts', { WORKER: JSON.stringify(worker) });
  const html = (await Bun.file('web/index.html').text())
    .replace(/\n\s*/g, '')
    .replace('<script type="module" src="main.ts"></script>', () => `<script type="module">${main}</script>`);
  await Bun.write('docs/index.html', html);
  return html;
}
if (import.meta.main) console.log((await build()).length, 'bytes');
