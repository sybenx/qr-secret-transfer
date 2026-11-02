// Starts the reference repo's test relay and prints its URL.
import { pathToFileURL } from 'node:url';
const { startRelay } = await import(pathToFileURL(`${process.argv[2]}/tools/test-relay.mjs`).href);
const r = await startRelay({});
console.log(`RELAY ${r.url}`);
