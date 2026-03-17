# Apps-Engine Analyzer

A dedicated, real-time observability tool for the Rocket.Chat Apps-Engine.

This analyzer intercepts the internal binary JSON-RPC communication (MessagePack) between the main Node.js Rocket.Chat process and the isolated Deno subprocesses, decoding and visualizing it in a rich "Execution Story" dashboard.

## Features
- **Zero-Modification Hijacking:** Uses a proxy executable to seamlessly intercept `child_process.spawn('deno')` without modifying the core Rocket.Chat codebase.
- **Real-Time Waterfall Tracing:** Groups raw JSON-RPC requests/responses into logical "Traces" (like Scheduler jobs, App Lifecycle triggers, Slashcommands).
- **Latency & Error Tracking:** Calculates duration for each subcall (bridges, accessors) and visually bubbles up errors so you don't have to hunt for them.
- **Granular Inspector:** A built-in payload inspector that automatically pairs requests with their specific responses.

## Setup & Running

You need two terminal windows to run the analyzer and the Rocket.Chat development server simultaneously.

### 1. Start the Analyzer Server
Open a terminal in the analyzer directory and start the Node.js server:
```bash
cd apps-engine-analyzer
npm install
npm run build
npm start
```
The UI is now available at: **http://localhost:4321**

### 2. Start Rocket.Chat with the Proxy
In your main terminal where you run Rocket.Chat, prepend the absolute path of the analyzer's `bin` folder to your `PATH`. This forces Node to use our proxy `deno` instead of the system `deno`.

For example, if you cloned this analyzer next to your Rocket.Chat folder:
**From inside `Rocket.Chat/apps/meteor`:**
```bash
PATH="$(pwd)/../../../apps-engine-analyzer/bin:$PATH" yarn dsv
```

When an app starts or a job triggers, you will see a purple console log (`[Analyzer Proxy] 🛸 Tapping into Deno Subprocess...`) and the trace will appear in the UI.

## Troubleshooting
- **No data in the UI?** Make sure you are using the `PATH` command exactly as shown above. Meteor strips out standard Node environment variables, so modifying the PATH is required.
- **Deno cannot be found?** The proxy automatically tries to find your system `deno` by scanning the rest of your PATH. If it fails, ensure `deno` is installed globally.
