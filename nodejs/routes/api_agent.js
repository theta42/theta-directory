'use strict';

module.exports = function initAgentWebSockets(app) {
    if (!app.wss) {
        console.warn("WebSocket server for agents is not initialized.");
        return;
    }

    app.wss.on('connection', (ws, req) => {
        // Parse the token from query param or header (e.g. ?token=XYZ)
        // For the beta, we will just accept it if a token is present.
        const url = new URL(req.url, `http://${req.headers.host}`);
        const token = url.searchParams.get('token') || req.headers['authorization'];

        if (!token) {
            ws.close(4001, 'Unauthorized: Missing token');
            return;
        }

        console.log(`[Theta Agent] Agent connected from ${req.socket.remoteAddress}`);

        ws.on('message', (message) => {
            try {
                const data = JSON.parse(message);
                
                // Example handling incoming telemetry
                if (data.type === 'telemetry') {
                    // Send to discovery service or log
                    // console.log(`[Theta Agent] Received telemetry from ${data.host}`);
                    
                    // We can publish it to the event bus for the UI
                    if(app.contoller && app.contoller.ps) {
                        app.contoller.ps.publish('agent.telemetry', data);
                    }
                }
            } catch (err) {
                console.error("[Theta Agent] Error parsing message:", err);
            }
        });

        ws.on('close', () => {
            console.log(`[Theta Agent] Agent disconnected`);
        });

        // Example: Send a welcome config payload to the agent
        ws.send(JSON.stringify({
            type: 'config',
            payload: {
                message: 'Welcome to SSO Manager C2'
            }
        }));
    });
};
