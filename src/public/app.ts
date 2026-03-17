declare const io: any;
interface Window {
    getTraceRoot: any;
    getSubcall: any;
    switchTab: any;
    searchTimeout: any;
}

const socket = io();

// Data Store
let messages: any[] = []; 
let requestsById: Record<string, any> = {}; 
let traces: any[] = [];
let activeTracesByApp: Record<string, any> = {}; 

let knownApps = new Set<string>();
let appMeta: Record<string, any> = {}; 
let stats = { total: 0, errors: 0 };
let currentView = 'flow'; 
let activeTraceId: string | null = null;

// DOM Elements
const dom: Record<string, HTMLElement | any> = {
    traceList: document.getElementById('trace-list'),
    waterfall: document.getElementById('waterfall-container'),
    rawList: document.getElementById('messages-list'),
    rawListContainer: document.getElementById('raw-list-container'),
    inspectorContent: document.getElementById('inspector-content'),
    inspectorSubtitle: document.getElementById('inspector-subtitle'),
    appFilter: document.getElementById('app-filter'),
    searchBox: document.getElementById('search-box'),
    clearBtn: document.getElementById('clear-btn'),
    toggleRaw: document.getElementById('toggle-raw-mode'),
    statTotal: document.getElementById('stat-total'),
    statErrors: document.getElementById('stat-errors'),
    detailTitle: document.getElementById('detail-title'),
    detailMeta: document.getElementById('detail-meta'),
    healthCpu: document.getElementById('health-cpu'),
    healthRam: document.getElementById('health-ram'),
    healthQueue: document.getElementById('health-queue'),
    sandboxArgs: document.getElementById('sandbox-args')
};

function renderHealth(appId) {
    if (appId === 'all') {
        // Find the most recently updated app
        const apps = Object.values(appMeta).filter(m => m.cpu !== undefined);
        if (apps.length > 0) {
            const latest = apps[apps.length - 1]; // Naive way
            dom.healthCpu.textContent = `${Number(latest.cpu).toFixed(1)}%`;
            dom.healthRam.textContent = `${latest.ramMb} MB`;
            dom.healthQueue.textContent = latest.queue || 0;
        } else {
            dom.healthCpu.textContent = '--%';
            dom.healthRam.textContent = '-- MB';
            dom.healthQueue.textContent = '--';
        }
        return;
    }
    
    const meta = appMeta[appId];
    if (meta) {
        dom.healthCpu.textContent = meta.cpu !== undefined ? `${Number(meta.cpu).toFixed(1)}%` : '--%';
        dom.healthRam.textContent = meta.ramMb !== undefined ? `${meta.ramMb} MB` : '-- MB';
        dom.healthQueue.textContent = meta.queue !== undefined ? meta.queue : '--';
    }
}

// --- DATA INGESTION ---
socket.on('rpc-message', (data) => {
    try {
        if (!appMeta[data.appId]) appMeta[data.appId] = {};

        // 1. Handle non-RPC data first
        if (data.type === 'setup') {
            appMeta[data.appId].pid = data.pid;
            appMeta[data.appId].sandboxArgs = data.sandboxArgs;
            if (dom.appFilter.value === 'all' || dom.appFilter.value === data.appId) {
                renderSandboxArgs(data.appId);
            }
            return;
        }
        
        if (data.type === 'os-metrics') {
            appMeta[data.appId].cpu = data.cpu;
            appMeta[data.appId].ramMb = data.ramMb;
            if (dom.appFilter.value === 'all' || dom.appFilter.value === data.appId) {
                renderHealth(dom.appFilter.value);
            }
            return;
        }
        
        if (data.type === 'deno-metrics') {
            appMeta[data.appId].queue = data.metrics.queueSize || 0;
            if (dom.appFilter.value === 'all' || dom.appFilter.value === data.appId) {
                renderHealth(dom.appFilter.value);
            }
            return;
        }

    // It's an RPC message
    messages.unshift(data);
    stats.total++;

    if (data.appId && data.appId !== 'unknown') {
        if (!knownApps.has(data.appId)) {
            knownApps.add(data.appId);
            const option = document.createElement('option');
            option.value = data.appId;
            option.textContent = data.appId;
            dom.appFilter.appendChild(option);
        }
    }

    const msg = data.message;
    let msgType = 'unknown';
    let method = 'unknown';
    let reqId = null;
    let logs = []; // Extract console logs if they exist

    if (typeof msg === 'string') {
        if (msg === '_zPING' || msg === '_zPONG') {
            msgType = 'notification'; method = msg;
        }
    } else if (msg && typeof msg === 'object') {
        reqId = msg.id;
        if (msg.hasOwnProperty('method')) {
            msgType = msg.hasOwnProperty('id') ? 'request' : 'notification';
            method = msg.method;
            if (msgType === 'request' && reqId) {
                requestsById[reqId] = data;
            }
        } else if (msg.hasOwnProperty('result')) {
            msgType = 'success';
            if (msg.result && Array.isArray(msg.result.logs)) {
                logs = msg.result.logs;
            } else if (msg.result && msg.result.value && Array.isArray(msg.result.value.logs)) {
                 // Sometimes it's nested
                 logs = msg.result.value.logs;
            }
        } else if (msg.hasOwnProperty('error')) {
            msgType = 'error';
            stats.errors++;
            if (msg.error && msg.error.data && Array.isArray(msg.error.data.logs)) {
                logs = msg.error.data.logs;
            }
        }
    }

    if ((msgType === 'success' || msgType === 'error') && reqId && requestsById[reqId]) {
        method = requestsById[reqId].message.method;
        data.matchedRequest = requestsById[reqId];
    }

    data.enrichedType = msgType;
    data.enrichedMethod = method || 'unknown';
    data.extractedLogs = logs;

    let category = 'other';
    if (method.startsWith('app:')) category = 'app';
    else if (method.startsWith('scheduler:')) category = 'scheduler';
    else if (method.startsWith('slashcommand:')) category = 'slashcommand';
    else if (method.startsWith('api:')) category = 'api';
    else if (method.startsWith('videoconference:')) category = 'videoconference';
    else if (method.startsWith('accessor:')) category = 'accessor';
    else if (method.startsWith('bridges:')) category = 'bridges';
    data.enrichedCategory = category;

    handleTraceLogic(data);
    updateStats();

    if (currentView === 'raw' && shouldShow(data)) {
        renderRawMessage(data, true);
    } else if (currentView === 'flow') {
        renderTracesList();
        if (activeTraceId && (data.message?.id === activeTraceId || data.matchedRequest?.message?.id === activeTraceId || (activeTracesByApp[data.appId]?.id === activeTraceId))) {
            renderWaterfall(traces.find(t => t.id === activeTraceId));
        }
    }
    } catch(err) {
        console.error("Error processing message:", err);
    }
});

function handleTraceLogic(data) {
    const { direction, appId, enrichedMethod, enrichedType, enrichedCategory } = data;
    const reqId = data.message?.id;

    const triggerCategories = ['app', 'scheduler', 'slashcommand', 'api', 'videoconference'];

    // 1. Trigger Request (Start Trace)
    if (direction === 'node->deno' && enrichedType === 'request' && triggerCategories.includes(enrichedCategory)) {
        const trace = {
            id: reqId,
            appId,
            method: enrichedMethod,
            category: enrichedCategory,
            status: 'running',
            startTime: data.timestamp,
            endTime: null,
            triggerReq: data,
            triggerRes: null,
            subcalls: [],
            errorDetails: null,
            logs: []
        };
        traces.unshift(trace); 
        activeTracesByApp[appId] = trace;
        return;
    }

    // 2. Subcall Request (Accessor/Bridge)
    if (direction === 'deno->node' && enrichedType === 'request' && (enrichedCategory === 'accessor' || enrichedCategory === 'bridges')) {
        const activeTrace = activeTracesByApp[appId];
        if (activeTrace) {
            activeTrace.subcalls.push({
                id: reqId,
                method: enrichedMethod,
                req: data,
                res: null,
                status: 'running',
                startTime: data.timestamp,
                endTime: null
            });
        }
        return;
    }

    // 3. Response to Subcall
    if (direction === 'node->deno' && (enrichedType === 'success' || enrichedType === 'error')) {
        const activeTrace = activeTracesByApp[appId];
        if (activeTrace) {
            const subcall = activeTrace.subcalls.find(s => s.id === reqId);
            if (subcall) {
                subcall.res = data;
                subcall.endTime = data.timestamp;
                subcall.status = enrichedType === 'success' ? 'completed' : 'error';
                if (enrichedType === 'error' && data.message?.error) {
                    subcall.errorDetails = data.message.error.message || JSON.stringify(data.message.error);
                }
            }
        }
        return;
    }

    // 4. Response to Trigger (End Trace)
    if (direction === 'deno->node' && (enrichedType === 'success' || enrichedType === 'error')) {
        const trace = traces.find(t => t.id === reqId);
        if (trace) {
            trace.status = enrichedType === 'success' ? 'completed' : 'error';
            trace.endTime = data.timestamp;
            trace.triggerRes = data;
            if (data.extractedLogs && data.extractedLogs.length > 0) {
                trace.logs = data.extractedLogs;
            }
            if (enrichedType === 'error' && data.message?.error) {
                trace.errorDetails = data.message.error.message || JSON.stringify(data.message.error);
            }
            if (activeTracesByApp[appId]?.id === reqId) {
                delete activeTracesByApp[appId];
            }
        }
    }
}

// --- RENDERING ---
function updateStats() {
    dom.statTotal.textContent = `${stats.total} Msgs`;
    dom.statErrors.textContent = `${stats.errors} Errs`;
}

function renderSandboxArgs(appId) {
    if (appId === 'all') {
        dom.sandboxArgs.style.display = 'none';
        return;
    }
    const meta = appMeta[appId];
    if (meta && meta.sandboxArgs && meta.sandboxArgs.length > 0) {
        dom.sandboxArgs.style.display = 'flex';
        dom.sandboxArgs.innerHTML = meta.sandboxArgs.map(arg => `<span class="sandbox-arg-badge">${arg}</span>`).join('');
    } else {
        dom.sandboxArgs.style.display = 'none';
    }
}

function shouldShow(data) {
    const appIdFilter = dom.appFilter.value;
    if (appIdFilter !== 'all' && data.appId !== appIdFilter) return false;
    const search = dom.searchBox.value.toLowerCase();
    if (search && !data.enrichedMethod.toLowerCase().includes(search)) return false;
    return true;
}

function formatBytes(bytes) {
    if (!bytes) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function getByteSizeClass(bytes) {
    if (!bytes) return '';
    if (bytes > 1024 * 1024) return 'huge'; // > 1MB
    if (bytes > 100 * 1024) return 'large'; // > 100KB
    return '';
}

function renderTracesList() {
    dom.traceList.innerHTML = '';
    const filteredTraces = traces.filter(t => {
        const appF = dom.appFilter.value;
        const search = dom.searchBox.value.toLowerCase();
        if (appF !== 'all' && t.appId !== appF) return false;
        if (search && !t.method.toLowerCase().includes(search)) return false;
        return true;
    });

    filteredTraces.forEach(trace => {
        const el = document.createElement('div');
        el.className = `trace-item ${trace.id === activeTraceId ? 'active' : ''}`;
        
        const duration = trace.endTime ? `${trace.endTime - trace.startTime}ms` : '...';
        
        el.innerHTML = `
            <div class="trace-item-header">
                <span class="trace-method">${trace.method.replace('app:', '').replace('scheduler:', '')}</span>
                <span class="trace-status status-${trace.status}">${trace.status}</span>
            </div>
            <div class="trace-meta-row">
                <span>${new Date(trace.startTime).toLocaleTimeString()}</span>
                <span class="trace-duration">${duration}</span>
            </div>
        `;

        el.addEventListener('click', () => {
            activeTraceId = trace.id;
            renderTracesList(); 
            renderWaterfall(trace);
        });

        dom.traceList.appendChild(el);
    });
}

function renderWaterfall(trace) {
    if (!trace) {
        dom.waterfall.innerHTML = '<div class="empty-state">Select a trace to view its execution flow.</div>';
        dom.detailTitle.textContent = 'Trace Details';
        dom.detailMeta.textContent = '';
        return;
    }

    dom.detailTitle.textContent = trace.method;
    dom.detailMeta.textContent = `App: ${trace.appId} | Start: ${new Date(trace.startTime).toLocaleTimeString()}`;

    let html = `<div class="waterfall-flow">`;

    // Root node
    const rootDuration = trace.endTime ? `${trace.endTime - trace.startTime}ms` : 'pending...';
    const rootIcon = trace.category === 'scheduler' ? '⏰' : '🚀';
    
    let rootErrorHtml = '';
    if (trace.errorDetails) {
        rootErrorHtml = `<div class="wf-error-box"><strong>ERROR:</strong> ${trace.errorDetails}</div>`;
    }

    html += `
        <div class="wf-item root-node" onclick="showInspector(window.getTraceRoot('${trace.id}'))">
            <div class="wf-header">
                <div class="wf-left">
                    <span class="wf-icon">${rootIcon}</span>
                    <span class="wf-method">${trace.method}</span>
                </div>
                <div class="wf-right">
                    <span>${rootDuration}</span>
                    <span class="wf-status-badge ${trace.status === 'error' ? 'err' : ''}">${trace.status}</span>
                </div>
            </div>
            ${rootErrorHtml}
        </div>
    `;

    // Subcalls
    trace.subcalls.forEach((sub, idx) => {
        const sDur = sub.endTime ? `${sub.endTime - sub.startTime}ms` : '...';
        const sMethod = sub.method.split(':').pop(); 
        
        let sErrorHtml = '';
        if (sub.errorDetails) {
            sErrorHtml = `<div class="wf-error-box">${sub.errorDetails}</div>`;
        }
        
        const reqSize = sub.req?.byteSize || 0;
        const resSize = sub.res?.byteSize || 0;
        const totalSize = reqSize + resSize;
        let sizeHtml = '';
        if (totalSize > 0) {
            sizeHtml = `<span class="msg-size ${getByteSizeClass(totalSize)}">${formatBytes(totalSize)}</span>`;
        }

        html += `
            <div class="wf-item sub-node ${sub.status === 'error' ? 'error-node' : ''}" onclick="showInspector(window.getSubcall('${trace.id}', ${idx}))">
                <div class="wf-header">
                    <div class="wf-left">
                        <span class="wf-icon" style="color:var(--accent); font-size: 0.9rem;">➜</span>
                        <span class="wf-method">${sMethod}</span>
                    </div>
                    <div class="wf-right">
                        ${sizeHtml}
                        <span>${sDur}</span>
                        <span class="wf-status-badge ${sub.status === 'error' ? 'err' : ''}">${sub.status}</span>
                    </div>
                </div>
                ${sErrorHtml}
            </div>
        `;
    });

    html += `</div>`;
    dom.waterfall.innerHTML = html;
    showInspector(window.getTraceRoot(trace.id));
}

window.getTraceRoot = (traceId) => {
    const t = traces.find(x => x.id === traceId);
    return { title: 'Trace Root Trigger', req: t.triggerReq, res: t.triggerRes, logs: t.logs };
};
window.getSubcall = (traceId, idx) => {
    const t = traces.find(x => x.id === traceId);
    const s = t.subcalls[idx];
    return { title: `Subcall: ${s.method.split(':').pop()}`, req: s.req, res: s.res, logs: [] };
};

// --- INSPECTOR ---
function showInspector(dataObj) {
    if (!dataObj) return;
    
    const { title, req, res, logs } = dataObj;
    dom.inspectorSubtitle.textContent = title;

    const reqSize = req && req.byteSize ? ` <span style="font-size:0.7rem; color:var(--text-secondary)">(${formatBytes(req.byteSize)})</span>` : '';
    const resSize = res && res.byteSize ? ` <span style="font-size:0.7rem; color:var(--text-secondary)">(${formatBytes(res.byteSize)})</span>` : '';

    let reqHtml = req ? `<pre>${syntaxHighlight(req.message)}</pre>` : '<div class="empty-state">No request payload</div>';
    let resHtml = res ? `<pre>${syntaxHighlight(res.message)}</pre>` : '<div class="empty-state">Awaiting response...</div>';
    
    let logsHtml = '<div class="empty-state">No console logs</div>';
    if (logs && logs.length > 0) {
        logsHtml = logs.map(l => {
            const time = new Date(l.timestamp || Date.now()).toLocaleTimeString();
            const sev = (l.severity || 'info').toLowerCase();
            const caller = l.caller ? l.caller.split('/').pop() : 'app';
            const msg = typeof l.args[0] === 'string' ? l.args[0] : JSON.stringify(l.args);
            return `
                <div class="console-log-item log-severity-${sev}">
                    <span class="log-time">[${time}]</span>
                    <span class="log-caller">${caller}</span>
                    <span class="log-msg">${msg}</span>
                </div>
            `;
        }).join('');
    }

    dom.inspectorContent.innerHTML = `
        <div class="inspector-tabs">
            <button class="tab-btn active" onclick="switchTab(this, 'req')">Request${reqSize}</button>
            <button class="tab-btn" onclick="switchTab(this, 'res')">Response${resSize}</button>
            <button class="tab-btn" onclick="switchTab(this, 'logs')">Console (${logs?.length || 0})</button>
        </div>
        <div id="pane-req" class="tab-pane active">${reqHtml}</div>
        <div id="pane-res" class="tab-pane">${resHtml}</div>
        <div id="pane-logs" class="tab-pane" style="padding:0;">${logsHtml}</div>
    `;
}

window.switchTab = (btn, type) => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`pane-${type}`).classList.add('active');
};

function syntaxHighlight(json) {
    if (typeof json !== 'string') json = JSON.stringify(json, undefined, 2);
    json = json.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return json.replace(/("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g, function (match) {
        let cls = 'number';
        if (/^"/.test(match)) cls = (/:$/.test(match)) ? 'key' : 'string';
        else if (/true|false/.test(match)) cls = 'boolean';
        else if (/null/.test(match)) cls = 'null';
        return '<span class="' + cls + '">' + match + '</span>';
    });
}

// --- RAW MODE ---
function renderRawMessage(data, isNew = false) {
    const el = document.createElement('div');
    el.className = 'message-item';
    const dirIcon = data.direction === 'node->deno' ? '⬇ Deno' : '⬆ Node';
    const time = new Date(data.timestamp).toLocaleTimeString();
    
    let sizeHtml = data.byteSize ? `<span class="msg-size ${getByteSizeClass(data.byteSize)}">${formatBytes(data.byteSize)}</span>` : '';

    el.innerHTML = `
        <span class="msg-dir">${dirIcon}</span>
        <span class="msg-type type-${data.enrichedType}">${data.enrichedType.toUpperCase()}</span>
        <span class="msg-app">${data.appId.substring(0,8)}...</span>
        <span class="msg-method">${data.enrichedMethod}</span>
        ${sizeHtml}
        <span style="margin-left: auto; font-size: 0.7rem; color: var(--text-secondary);">${time}</span>
    `;

    el.addEventListener('click', () => {
        document.querySelectorAll('.message-item').forEach(e => e.classList.remove('active'));
        el.classList.add('active');
        dom.inspectorSubtitle.textContent = 'Raw Message';
        dom.inspectorContent.innerHTML = `<div class="tab-pane active"><pre>${syntaxHighlight(data.message)}</pre></div>`;
    });

    if (isNew) {
        dom.rawList.prepend(el);
    } else {
        dom.rawList.appendChild(el);
    }
}

// --- EVENTS ---
dom.toggleRaw.addEventListener('change', (e) => {
    if (e.target.checked) {
        currentView = 'raw';
        dom.waterfall.classList.add('hidden');
        dom.rawListContainer.classList.remove('hidden');
        dom.rawList.innerHTML = '';
        messages.filter(shouldShow).forEach(m => renderRawMessage(m, false));
    } else {
        currentView = 'flow';
        dom.rawListContainer.classList.add('hidden');
        dom.waterfall.classList.remove('hidden');
        renderTracesList();
        renderWaterfall(traces.find(t => t.id === activeTraceId));
    }
});

dom.appFilter.addEventListener('change', () => {
    renderSandboxArgs(dom.appFilter.value);
    if (currentView === 'flow') renderTracesList();
    else { dom.rawList.innerHTML = ''; messages.filter(shouldShow).forEach(m => renderRawMessage(m, false)); }
});

dom.searchBox.addEventListener('input', () => {
    clearTimeout(window.searchTimeout);
    window.searchTimeout = setTimeout(() => {
        if (currentView === 'flow') renderTracesList();
        else { dom.rawList.innerHTML = ''; messages.filter(shouldShow).forEach(m => renderRawMessage(m, false)); }
    }, 300);
});

dom.clearBtn.addEventListener('click', () => {
    messages = []; requestsById = {}; traces = []; activeTracesByApp = {};
    stats = { total: 0, errors: 0 }; activeTraceId = null;
    updateStats();
    dom.traceList.innerHTML = '';
    dom.rawList.innerHTML = '';
    dom.waterfall.innerHTML = '<div class="empty-state">Select a trace to view its execution flow.</div>';
    dom.inspectorContent.innerHTML = '<div class="empty-state">Select a trace or subcall to view payload.</div>';
    dom.inspectorSubtitle.textContent = '';
    dom.detailTitle.textContent = 'Trace Details';
    dom.detailMeta.textContent = '';
});
