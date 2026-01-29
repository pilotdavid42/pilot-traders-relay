// ============================================================
// PILOT TRADERS WEBHOOK RELAY SERVER
// ============================================================
// Cloud-hosted relay that receives webhooks from TradingView
// and broadcasts to connected Copilot clients via WebSocket
// V1.1.43: Added user-specific webhook routing
// ============================================================

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Track connected clients
const clients = new Map();
let clientIdCounter = 0;

// V1.1.43: Track clients by webhook ID for user-specific routing
const webhookClients = new Map();  // webhookId -> Set of client objects
const legacyClients = new Set();   // Admin accounts (receive all alerts)

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.text({ type: '*/*' }));

// ============================================================
// WEBSOCKET CONNECTIONS (Copilot apps connect here)
// ============================================================
wss.on('connection', (ws, req) => {
    const clientId = ++clientIdCounter;
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

    const clientObj = {
        ws,
        id: clientId,
        ip: clientIp,
        connectedAt: new Date(),
        symbol: null,
        webhookId: null,        // V1.1.43: User's unique webhook ID
        isLegacy: false,        // V1.1.43: True for admin accounts
        ignoreUntil: Date.now() + 5000
    };

    clients.set(clientId, clientObj);

    console.log(`[${new Date().toISOString()}] Client ${clientId} connected from ${clientIp}. Total: ${clients.size}`);

    // Send welcome message
    ws.send(JSON.stringify({
        type: 'connected',
        clientId,
        message: 'Connected to Pilot Traders Webhook Relay',
        version: '1.1.43',
        timestamp: new Date().toISOString()
    }));

    // Handle client messages
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);

            if (data.type === 'register') {
                // V1.1.43: Register client with their webhook ID
                const client = clients.get(clientId);
                if (client) {
                    if (data.webhookId) {
                        // User-specific mode
                        client.webhookId = data.webhookId;
                        client.isLegacy = false;
                        
                        // Add to webhookClients map
                        if (!webhookClients.has(data.webhookId)) {
                            webhookClients.set(data.webhookId, new Set());
                        }
                        webhookClients.get(data.webhookId).add(client);
                        
                        console.log(`[${new Date().toISOString()}] Client ${clientId} registered with webhookId: ${data.webhookId}`);
                        
                        ws.send(JSON.stringify({
                            type: 'registered',
                            webhookId: data.webhookId,
                            mode: 'user-specific'
                        }));
                    } else if (data.legacy === true) {
                        // Legacy mode for admin accounts
                        client.isLegacy = true;
                        client.webhookId = null;
                        legacyClients.add(client);
                        
                        console.log(`[${new Date().toISOString()}] Client ${clientId} registered as LEGACY (admin mode)`);
                        
                        ws.send(JSON.stringify({
                            type: 'registered',
                            webhookId: null,
                            mode: 'legacy'
                        }));
                    }
                }
            } else if (data.type === 'subscribe') {
                // Client wants to subscribe to specific symbol
                const client = clients.get(clientId);
                if (client) {
                    client.symbol = data.symbol;
                    console.log(`Client ${clientId} subscribed to ${data.symbol}`);
                }
            } else if (data.type === 'ping') {
                ws.send(JSON.stringify({ type: 'pong', timestamp: new Date().toISOString() }));
            } else if (data.type === 'clear_session') {
                // Client requested to clear stale data
                const client = clients.get(clientId);
                if (client) {
                    client.ignoreUntil = Date.now() + 10000;
                    console.log(`Client ${clientId} requested clear_session - ignoring alerts for 10s`);
                    ws.send(JSON.stringify({ type: 'session_cleared', timestamp: new Date().toISOString() }));
                }
            }
        } catch (e) {
            // Ignore invalid messages
        }
    });

    ws.on('close', () => {
        const client = clients.get(clientId);
        
        // V1.1.43: Remove from webhook tracking
        if (client) {
            if (client.webhookId && webhookClients.has(client.webhookId)) {
                webhookClients.get(client.webhookId).delete(client);
                if (webhookClients.get(client.webhookId).size === 0) {
                    webhookClients.delete(client.webhookId);
                }
            }
            legacyClients.delete(client);
        }
        
        clients.delete(clientId);
        console.log(`[${new Date().toISOString()}] Client ${clientId} disconnected. Total: ${clients.size}`);
    });

    ws.on('error', (error) => {
        console.error(`Client ${clientId} error:`, error.message);
        const client = clients.get(clientId);
        if (client) {
            if (client.webhookId && webhookClients.has(client.webhookId)) {
                webhookClients.get(client.webhookId).delete(client);
            }
            legacyClients.delete(client);
        }
        clients.delete(clientId);
    });
});

// ============================================================
// V1.1.43: USER-SPECIFIC WEBHOOK ENDPOINT
// TradingView sends alerts here with user's unique webhook ID
// ============================================================
app.post('/webhook/:webhookId/alert', (req, res) => {
    const { webhookId } = req.params;
    const alert = typeof req.body === 'string' ? req.body : req.body;
    const timestamp = new Date().toISOString();

    console.log(`[${timestamp}] User webhook received for ${webhookId}:`, JSON.stringify(alert).substring(0, 200));

    // Find clients registered with this webhookId
    const targetClients = webhookClients.get(webhookId);

    if (!targetClients || targetClients.size === 0) {
        console.log(`[${timestamp}] No clients connected for webhookId: ${webhookId}`);
        return res.json({
            success: true,
            message: 'Alert received but no clients connected',
            webhookId: webhookId,
            deliveredTo: 0,
            timestamp
        });
    }

    // Send to matching clients only
    const message = JSON.stringify({
        type: 'alert',
        data: alert,
        webhookId: webhookId,
        timestamp
    });

    let delivered = 0;
    targetClients.forEach((client) => {
        // Skip if client is in ignore window
        if (client.ignoreUntil && Date.now() < client.ignoreUntil) {
            console.log(`Skipping alert for client ${client.id} - in ignore window`);
            return;
        }

        if (client.ws.readyState === WebSocket.OPEN) {
            client.ws.send(message);
            delivered++;
        }
    });

    console.log(`[${timestamp}] User alert delivered to ${delivered} client(s) for webhookId: ${webhookId}`);

    res.json({
        success: true,
        message: 'Alert delivered',
        webhookId: webhookId,
        deliveredTo: delivered,
        timestamp
    });
});

// ============================================================
// LEGACY WEBHOOK ENDPOINT (Admin accounts - David Story, Master Admin)
// TradingView sends alerts here for legacy accounts
// ============================================================
app.post('/alert', (req, res) => {
    const alert = req.body;
    const timestamp = new Date().toISOString();

    console.log(`[${timestamp}] Legacy webhook received:`, JSON.stringify(alert).substring(0, 200));

    // V1.1.43: Send to legacy clients (admin accounts)
    const message = JSON.stringify({
        type: 'alert',
        data: alert,
        legacy: true,
        timestamp
    });

    let delivered = 0;

    // Send to all legacy clients
    legacyClients.forEach((client) => {
        if (client.ignoreUntil && Date.now() < client.ignoreUntil) {
            console.log(`Skipping alert for legacy client ${client.id} - in ignore window`);
            return;
        }

        if (client.symbol && alert.symbol && client.symbol !== alert.symbol) {
            return;
        }

        if (client.ws.readyState === WebSocket.OPEN) {
            client.ws.send(message);
            delivered++;
        }
    });

    console.log(`[${timestamp}] Legacy alert delivered to ${delivered}/${legacyClients.size} legacy clients`);

    res.json({
        success: true,
        message: 'Alert received and broadcast to legacy clients',
        deliveredTo: delivered,
        timestamp
    });
});

// ============================================================
// STATUS & HEALTH ENDPOINTS
// ============================================================
app.get('/', (req, res) => {
    res.json({
        name: 'Pilot Traders Webhook Relay',
        version: '1.1.43',
        status: 'running',
        connectedClients: clients.size,
        // V1.1.43: Additional stats
        webhookIds: webhookClients.size,
        legacyClients: legacyClients.size,
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        endpoints: {
            userWebhook: 'POST /webhook/:webhookId/alert',
            legacyWebhook: 'POST /alert',
            status: 'GET /status',
            health: 'GET /health'
        }
    });
});

app.get('/status', (req, res) => {
    const clientList = [];
    clients.forEach((client, id) => {
        clientList.push({
            id,
            connectedAt: client.connectedAt,
            symbol: client.symbol,
            webhookId: client.webhookId ? client.webhookId.substring(0, 8) + '...' : null,
            isLegacy: client.isLegacy
        });
    });

    res.json({
        status: 'running',
        version: '1.1.43',
        connectedClients: clients.size,
        webhookIds: webhookClients.size,
        legacyClients: legacyClients.size,
        clients: clientList,
        uptime: process.uptime(),
        timestamp: new Date().toISOString()
    });
});

app.get('/health', (req, res) => {
    res.status(200).send('OK');
});

// Test endpoint - sends a test alert to all clients
app.get('/test', (req, res) => {
    const testAlert = {
        type: 'LEVELS',
        symbol: 'TEST',
        t1: 100.50,
        t2: 101.00,
        t3: 101.50,
        eject: 99.50,
        entry: 100.00,
        source: 'relay-test'
    };

    const timestamp = new Date().toISOString();
    const message = JSON.stringify({
        type: 'alert',
        data: testAlert,
        timestamp
    });

    let delivered = 0;
    clients.forEach((client) => {
        if (client.ws.readyState === WebSocket.OPEN) {
            client.ws.send(message);
            delivered++;
        }
    });

    res.json({
        success: true,
        message: 'Test alert sent',
        deliveredTo: delivered,
        data: testAlert
    });
});

// ============================================================
// START SERVER
// ============================================================
const PORT = process.env.PORT || 3333;

server.listen(PORT, '0.0.0.0', () => {
    console.log('============================================================');
    console.log('  PILOT TRADERS WEBHOOK RELAY V1.1.43');
    console.log('============================================================');
    console.log(`  Server running on port ${PORT}`);
    console.log('');
    console.log('  Endpoints:');
    console.log(`    POST /webhook/:id/alert - User-specific webhooks (V1.1.43)`);
    console.log(`    POST /alert             - Legacy webhooks (admin accounts)`);
    console.log(`    GET  /status            - Check server & client status`);
    console.log(`    GET  /test              - Send test alert to clients`);
    console.log(`    WS   /                  - WebSocket for Copilot clients`);
    console.log('============================================================');
});
