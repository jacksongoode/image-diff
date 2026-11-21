import { build } from './build';
Bun.serve({ port: 3000, fetch: async () => new Response(await build(), { headers: { 'content-type': 'text/html' } }) });
console.log('http://localhost:3000');
