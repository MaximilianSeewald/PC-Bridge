import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';

await mkdir('dist/server', { recursive: true });
await mkdir('dist/.openai', { recursive: true });
const catalogImport = "import catalog from '../client/unity-tools.json' with { type: 'json' };";
const source = await readFile('worker/index.js', 'utf8');
if (!source.startsWith(catalogImport)) throw new Error('Der Import des Unity-Katalogs fehlt im Site-Worker.');
const catalog = JSON.parse(await readFile('client/unity-tools.json', 'utf8'));
await writeFile('dist/server/index.js', `const catalog = ${JSON.stringify(catalog)};${source.slice(catalogImport.length)}`);
await copyFile('.openai/hosting.json', 'dist/.openai/hosting.json');
