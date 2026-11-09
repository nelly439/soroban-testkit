/**
 * Starts the bundled FAKE Stellar RPC on a fixed port, hosting the demo
 * contracts, so you can try soroban-testkit without a network.
 *
 *   npm run demo:rpc            # http://127.0.0.1:8787
 *   DEMO_PORT=9000 npm run demo:rpc
 *
 * The fake RPC is a test tool (see test/fake-rpc/server.ts): contract
 * behaviour is scripted in TypeScript, not executed by the Soroban host.
 */
import { startFakeRpc } from '../test/fake-rpc/server.js';
import { buggyVault, cleanVault } from '../test/fake-rpc/contracts.js';
import { demoToken } from '../test/fake-rpc/token.js';

const port = Number(process.env.DEMO_PORT ?? 8787);
const rpc = await startFakeRpc({ contracts: [cleanVault, buggyVault, demoToken], port }).catch(
  (err: Error) => {
    process.stderr.write(`demo-rpc: cannot listen on port ${port}: ${err.message}\n`);
    process.exit(1);
  },
);
process.stdout.write(
  [
    `fake Stellar RPC (test tool) listening on ${rpc.url}`,
    `  network passphrase: Standalone Network ; February 2017`,
    `  clean vault:  ${cleanVault.id}`,
    `  buggy vault:  ${buggyVault.id}`,
    `  demo token:   ${demoToken.id}`,
    'press Ctrl+C to stop',
    '',
  ].join('\n'),
);
const stop = (): void => {
  void rpc.close().then(() => process.exit(0));
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
