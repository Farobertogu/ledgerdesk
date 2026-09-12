import fs from 'node:fs';
import {readPreparation} from '../../../src/contracts/intake_artifact.ts';
const chunks=[];for await(const c of process.stdin)chunks.push(c);
const parsed=readPreparation(Buffer.concat(chunks));
process.stdout.write(JSON.stringify(parsed));

