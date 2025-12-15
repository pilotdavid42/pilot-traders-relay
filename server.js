// ============================================================
// PILOT TRADERS WEBHOOK RELAY SERVER
// ============================================================
// Cloud-hosted relay that receives webhooks from TradingView
// and broadcasts to connected Copilot clients via WebSocket
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

// Middleware
app.use(cors());
app.use(express.json());

// ============================================================
// WEBSOCKET CONNECTIONS (Copilot apps connect here)
// ============================================================
wss.on('connection', (ws, req) => {
    const clientId = ++clientIdCounter;
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

    clients.set(clientId, {
        ws,
        ip: clientIp,
        connectedAt: new Date(),
        symbol: null // Can filter by symbol later
    });

    console.log(`[${new Date().toISOString()}] Client ${clientId} connected from ${clientIp}. Total: ${clients.size}`);

    // Send welcome message
    ws.send(JSON.stringify({
        type: 'connected',
        clientId,
        message: 'Connected to Pilot Traders Webhook Relay',
        timestamp: new Date().toISOString()
    }));

    // Handle client messages (for filtering, heartbeat, etc.)
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);

            if (data.type === 'subscribe') {
                // Client wants to subscribe to specific symbol
                const client = clients.get(clientId);
                if (client) {
                    client.symbol = data.symbol;
                    console.log(`Client ${clientId} subscribed to ${data.symbol}`);
                }
            } else if (data.type === 'ping') {
                ws.send(JSON.stringify({ type: 'pong', timestamp: new Date().toISOString() }));
            }
        } catch (e) {
            // Ignore invalid messages
        }
    });

    ws.on('close', () => {
        clients.delete(clientId);
        console.log(`[${new Date().toISOString()}] Client ${clientId} disconnected. Total: ${clients.size}`);
    });

    ws.on('error', (error) => {
        console.error(`Client ${clientId} error:`, error.message);
        clients.delete(clientId);
    });
});

// ============================================================
// WEBHOOK ENDPOINT (TradingView sends alerts here)
// ============================================================
app.post('/alert', (req, res) => {
    const alert = req.body;
    const timestamp = new Date().toISOString();

    console.log(`[${timestamp}] Webhook received:`, JSON.stringify(alert).substring(0, 200));

    // Broadcast to all connected clients
    let delivered = 0;
    const message = JSON.stringify({
        type: 'alert',
        data: alert,
        timestamp
    });

    clients.forEach((client, clientId) => {
        // Optional: filter by symbol
        if (client.symbol && alert.symbol && client.symbol !== alert.symbol) {
            return; // Skip if client subscribed to different symbol
        }

        if (client.ws.readyState === WebSocket.OPEN) {
            client.ws.send(message);
            delivered++;
        }
    });

    console.log(`[${timestamp}] Alert delivered to ${delivered}/${clients.size} clients`);

    res.json({
        success: true,
        message: 'Alert received and broadcast',
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
        status: 'running',
        connectedClients: clients.size,
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        endpoints: {
            webhook: 'POST /alert',
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
            symbol: client.symbol
        });
    });

    res.json({
        status: 'running',
        connectedClients: clients.size,
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
    console.log('  PILOT TRADERS WEBHOOK RELAY');
    console.log('============================================================');
    console.log(`  Server running on port ${PORT}`);
    console.log('');
    console.log('  Endpoints:');
    console.log(`    POST /alert    - Receive TradingView webhooks`);
    console.log(`    GET  /status   - Check server & client status`);
    console.log(`    GET  /test     - Send test alert to clients`);
    console.log(`    WS   /         - WebSocket for Copilot clients`);
    console.log('============================================================');
});
