import { copyFile, mkdir, readdir } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const output = new URL('site/dist/', root);

await mkdir(new URL('assets/', output), { recursive: true });

await Promise.all(['index.html', 'styles.css', 'favicon.svg'].map((name) =>
    copyFile(new URL(`site/${name}`, root), new URL(name, output)),
));

await Promise.all(['conversation.png', 'tool-details.png'].map((name) =>
    copyFile(new URL(`docs/images/${name}`, root), new URL(`assets/${name}`, output)),
));

// Refuse unexpected leftovers rather than accidentally publishing them.
const files = (await readdir(output, { recursive: true }))
    .map((name) => name.replaceAll('\\', '/'))
    .sort();
const expected = [
    'assets',
    'assets/conversation.png',
    'assets/tool-details.png',
    'favicon.svg',
    'index.html',
    'styles.css',
];

if (JSON.stringify(files) !== JSON.stringify(expected)) {
    throw new Error(
        'Unexpected files in site/dist. Inspect and remove them before publishing.',
    );
}

console.info('Site ready in site/dist (5 public files).');
