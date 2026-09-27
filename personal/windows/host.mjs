// A launcher-owned stdin channel gives Windows a graceful stop without changing upstream's CLI.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';

const [codeDir, officeDir, port] = process.argv.slice(2);
if (!codeDir || !officeDir || !/^\d+$/.test(port ?? '')) throw new Error('Missing launcher configuration');
const cli = path.join(codeDir, 'dist/server/server/cli.js');
process.argv = [process.execPath, cli, officeDir, '--port', port];
await import(pathToFileURL(cli).href);
const input = createInterface({ input: process.stdin });
input.on('line', line => { if (line === 'stop') process.emit('SIGINT', 'SIGINT'); });
input.on('close', () => process.emit('SIGINT', 'SIGINT'));
