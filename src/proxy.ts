import * as fs from 'fs';
import * as path from 'path';
import * as cp from 'child_process';
import { PassThrough } from 'stream';
import * as http from 'http';

// We dynamically require msgpack since it's installed as a dependency
let Decoder: any, ExtensionCodec: any;
try {
    // Relative to the compiled dist/proxy.js
    const msgpack = require('@msgpack/msgpack');
    Decoder = msgpack.Decoder;
    ExtensionCodec = msgpack.ExtensionCodec;
} catch (e) {
    console.error(`\x1b[31m[Analyzer Proxy Error] Cannot load @msgpack/msgpack. Did you run npm install?\x1b[0m`);
    process.exit(1);
}

const extensionCodec = new ExtensionCodec();
extensionCodec.register({ type: 0, encode: () => new Uint8Array([0]), decode: () => undefined });
extensionCodec.register({ 
    type: 1, 
    encode: (obj: any) => Buffer.isBuffer(obj) ? new Uint8Array(obj.buffer, obj.byteOffset, obj.byteLength) : null, 
    decode: (data: Uint8Array) => Buffer.from(data) 
});

const PATH = (process.env.PATH || '').split(path.delimiter);
let realDenoPath: string | null = null;
const currentScriptDir = path.resolve(__dirname, '../bin'); // It's invoked via bin/deno

for (const dir of PATH) {
    if (path.resolve(dir) === currentScriptDir) continue;
    const p = path.join(dir, 'deno');
    if (fs.existsSync(p)) {
        const realP = fs.realpathSync(p);
        // Avoid infinite loop if somehow it points back to our bin script
        if (realP !== path.resolve(currentScriptDir, 'deno')) {
            realDenoPath = realP;
            break;
        }
    }
}

if (!realDenoPath && fs.existsSync('/Users/deva/.deno/bin/deno')) {
    realDenoPath = '/Users/deva/.deno/bin/deno';
}

if (!realDenoPath) { 
    console.error("\x1b[31m[Analyzer] No real deno found.\x1b[0m"); 
    process.exit(1); 
}

const args = process.argv.slice(2);
const isAppsEngineProcess = args.includes('--subprocess');

const child = cp.spawn(realDenoPath, args);

process.stdin.pipe(child.stdin);
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);

child.on('exit', (code) => process.exit(code !== null ? code : 1));
process.on('SIGTERM', () => child.kill('SIGTERM'));
process.on('SIGINT', () => child.kill('SIGINT'));

if (!isAppsEngineProcess) {
    // If we're not intercepting an Apps-Engine process (like deno lsp), we're done here.
    // However, process needs to stay alive until child exits.
} else {
    setupInterceptor(child, args);
}

function setupInterceptor(child: cp.ChildProcess, args: string[]) {
    let appId = 'unknown';
    const idx = args.indexOf('--subprocess');
    if (idx !== -1 && args.length > idx + 1) appId = args[idx + 1];

    console.error(`\x1b[35m[Analyzer Proxy] 🛸 Tapping into Deno Subprocess for App: ${appId}\x1b[0m`);

    const sandboxArgs = args.filter(a => a.startsWith('--allow-'));

    const sendToAnalyzer = (payloadObj: any) => {
        const payload = JSON.stringify(payloadObj);
        const req = http.request({
            hostname: '127.0.0.1', port: 4321, path: '/ingest', method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
        });
        req.on('error', () => {}); // Ignore network errors if analyzer UI isn't running
        req.write(payload);
        req.end();
    };

    sendToAnalyzer({
        type: 'setup',
        appId,
        pid: child.pid,
        sandboxArgs,
        timestamp: Date.now()
    });

    const stdinTap = new PassThrough();
    const stdoutTap = new PassThrough();

    process.stdin.pipe(stdinTap);
    if (child.stdout) child.stdout.pipe(stdoutTap);

    async function processStream(stream: NodeJS.ReadableStream, direction: string) {
        let currentBufferSize = 0;
        stream.on('data', (chunk: Buffer) => {
            currentBufferSize += chunk.length;
        });

        const decoder = new Decoder({ extensionCodec });
        try {
            for await (const message of decoder.decodeStream(stream as any)) {
                sendToAnalyzer({ 
                    type: 'rpc',
                    appId, 
                    direction, 
                    timestamp: Date.now(), 
                    message,
                    byteSize: currentBufferSize
                });
                currentBufferSize = 0;
            }
        } catch (e) {
            // Decoding streams sometimes fails when process closes abruptly. Ignore.
        }
    }

    processStream(stdinTap, 'node->deno');
    processStream(stdoutTap, 'deno->node');

    // Tap STDERR for health metrics
    if (child.stderr) {
        const stderrTap = new PassThrough();
        child.stderr.pipe(stderrTap);

        let stderrBuffer = '';
        stderrTap.on('data', (chunk: Buffer) => {
            stderrBuffer += chunk.toString();
            const lines = stderrBuffer.split('\n');
            stderrBuffer = lines.pop() || ''; 
            
            for (const line of lines) {
                if (line.trim().startsWith('{') && line.includes('pid')) {
                    try {
                        const metrics = JSON.parse(line);
                        sendToAnalyzer({ type: 'deno-metrics', appId, timestamp: Date.now(), metrics });
                    } catch(e) {}
                }
            }
        });
    }

    // OS-Level Metrics Polling
    const isMac = process.platform === 'darwin';
    const isLinux = process.platform === 'linux';

    if ((isMac || isLinux) && child.pid) {
        const pidString = child.pid.toString();
        const interval = setInterval(() => {
            if (child.killed || child.exitCode !== null) {
                clearInterval(interval);
                return;
            }
            
            cp.exec(`ps -p ${pidString} -o %cpu,rss`, (err, stdout) => {
                if (err) return;
                const lines = stdout.trim().split('\n');
                if (lines.length > 1) {
                    const parts = lines[1].trim().split(/\s+/);
                    if (parts.length >= 2) {
                        const cpu = parseFloat(parts[0]);
                        const ramMb = parseInt(parts[1], 10) / 1024;
                        if (!isNaN(cpu) && !isNaN(ramMb)) {
                            sendToAnalyzer({
                                type: 'os-metrics',
                                appId,
                                timestamp: Date.now(),
                                cpu,
                                ramMb: ramMb.toFixed(2)
                            });
                        }
                    }
                }
            });
        }, 5000);
    }
}
