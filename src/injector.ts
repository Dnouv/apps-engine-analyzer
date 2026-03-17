import * as cp from 'child_process';
import * as http from 'http';
import * as path from 'path';
import * as fs from 'fs';
import { PassThrough } from 'stream';

const ANALYZER_ROOT = path.resolve(__dirname, '..');
const MSGPACK_PATH = path.join(ANALYZER_ROOT, 'node_modules', '@msgpack', 'msgpack');
const INJECTOR_PATH = __filename;
const LOG_FILE = path.join(ANALYZER_ROOT, 'analyzer.log');

function logToFile(msg: string) {
    const time = new Date().toISOString();
    fs.appendFileSync(LOG_FILE, `[${time}] [PID ${process.pid}] ${msg}\n`);
}

let Decoder: any, ExtensionCodec: any;
try {
    const msgpack = require(MSGPACK_PATH);
    Decoder = msgpack.Decoder;
    ExtensionCodec = msgpack.ExtensionCodec;
} catch (e: any) {
    logToFile('Failed to load msgpack: ' + e.message);
    process.exit(0); // Safely exit if it fails to load
}

const extensionCodec = new ExtensionCodec();
extensionCodec.register({
    type: 0, encode: () => new Uint8Array([0]), decode: () => undefined,
});
extensionCodec.register({
    type: 1, encode: (obj: any) => Buffer.isBuffer(obj) ? new Uint8Array(obj.buffer, obj.byteOffset, obj.byteLength) : null, decode: (data: Uint8Array) => Buffer.from(data),
});

function sendToAnalyzer(data: any) {
    const payload = JSON.stringify(data);
    const req = http.request({
        hostname: '127.0.0.1', port: 4321, path: '/ingest', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    });
    req.on('error', () => {});
    req.write(payload);
    req.end();
}

const originalSpawn = cp.spawn;

(cp as any).spawn = function(command: string, args: string[], options: any) {
    const actualOptions = options || {};
    const env = actualOptions.env || process.env;

    // Recursive injection
    if (command === 'node' || command.endsWith('/node') || command === 'meteor') {
        const nodeOpts = env.NODE_OPTIONS || '';
        // Only inject if it's not already there
        if (!nodeOpts.includes('injector.js')) {
            actualOptions.env = { ...env, NODE_OPTIONS: `--require ${INJECTOR_PATH} ${nodeOpts}` };
            logToFile(`Re-injecting into child node process: ${command}`);
        }
    }

    const child = originalSpawn.call(this, command, args, actualOptions);

    if ((command === 'deno' || command.endsWith('/deno')) && Array.isArray(args) && args.includes('--subprocess')) {
        let appId = 'unknown';
        const idx = args.indexOf('--subprocess');
        if (idx !== -1 && args.length > idx + 1) appId = args[idx + 1];

        logToFile(`!!! SUCCESSFULLY INTERCEPTED DENO FOR APP: ${appId} !!!`);
        console.log(`\x1b[32m[Analyzer] 🛰️  Intercepting Apps-Engine Process: ${appId}\x1b[0m`);

        const stdoutTap = new PassThrough();
        if (child.stdout) child.stdout.pipe(stdoutTap);
        const stdoutDecoder = new Decoder({ extensionCodec });
        (async () => {
            try {
                for await (const message of stdoutDecoder.decodeStream(stdoutTap as any)) {
                    sendToAnalyzer({ appId, direction: 'deno->node', timestamp: Date.now(), message });
                }
            } catch (e: any) { logToFile('Error decoding stdout: ' + e.message); }
        })();

        if (child.stdin) {
            const originalWrite = child.stdin.write;
            const stdinDecoder = new Decoder({ extensionCodec });
            child.stdin.write = function(chunk: any) {
                try {
                    const message = stdinDecoder.decode(chunk);
                    sendToAnalyzer({ appId, direction: 'node->deno', timestamp: Date.now(), message });
                } catch (e) {}
                return originalWrite.apply(this, arguments as any);
            };
        }
    }

    return child;
};

if (!process.env[`ANALYZER_LOGGED_${process.pid}`]) {
    console.log(`\x1b[36m[Analyzer] ⚡ Hook Active in PID ${process.pid}\x1b[0m`);
    process.env[`ANALYZER_LOGGED_${process.pid}`] = 'true';
}
