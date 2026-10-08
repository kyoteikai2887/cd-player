import path from 'node:path';
import { createAudioFolder } from '../tests/helpers/audioFiles.ts';
const directory = path.resolve(process.argv[2] ?? '.cache/audio-check');
await createAudioFolder(directory, 6);
console.log(directory);
