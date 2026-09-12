import fs from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
const [forbiddenRead, forbiddenWrite] = process.argv.slice(2);
const result = {};
try { await fs.readFile(forbiddenRead); result.read = 'allowed'; } catch (e) { result.read = e.code; }
try { await fs.writeFile(forbiddenWrite, 'probe', { flag: 'wx' }); result.write = 'allowed'; } catch (e) { result.write = e.code; }
try { spawnSync(process.execPath, ['--version']); result.child = 'allowed'; } catch (e) { result.child = e.code; }
result.environment = Object.keys(process.env).sort();
result.network = 'Not restricted or exercised by this probe. Node filesystem permissions are not a network sandbox.';
console.log(JSON.stringify(result));
