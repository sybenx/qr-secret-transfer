// The tests run against relays on this machine; a deployed page never may.
import { relayPolicy } from '../src/core/index.ts';
relayPolicy.loopback = true;
