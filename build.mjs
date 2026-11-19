import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';

await mkdir('dist/server', { recursive: true });
await mkdir('dist/.openai', { recursive: true });
let source = await readFile('worker/index.js', 'utf8');
for (const [variable, file] of [['catalog', 'unity-tools.json'], ['gitTools', 'git-tools.json']]) {
  const statement = `import ${variable} from '../client/${file}' with { type: 'json' };`;
  if (!source.includes(statement)) throw new Error(`Der Import für ${file} fehlt im Site-Worker.`);
  const data = JSON.parse(await readFile(`client/${file}`, 'utf8'));
  source = source.replace(statement, () => `const ${variable} = ${JSON.stringify(data)};`);
}
await writeFile('dist/server/index.js', source);
await copyFile('.openai/hosting.json', 'dist/.openai/hosting.json');
