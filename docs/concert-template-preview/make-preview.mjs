import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const source = new URL('./index.html', import.meta.url);
const renderer = new URL('../../ui/stage/concert-graphics.js', import.meta.url);
const [html, script] = await Promise.all([readFile(source, 'utf8'), readFile(renderer, 'utf8')]);
const marker = /<!-- INLINE_RENDERER:BEGIN -->[\s\S]*?<!-- INLINE_RENDERER:END -->/;
if (!marker.test(html)) throw new Error('Inline renderer marker is missing');
const destination = resolve(process.argv[2] || 'BIT-深秋歌会包装试映.html');
await writeFile(destination, html.replace(marker, () => '<script>\n' + script.replace(/<\/script/gi, '<\\/script') + '\n</script>'), 'utf8');
console.log(destination);
