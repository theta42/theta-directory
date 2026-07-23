'use strict';
const fs = require('fs');
const { spawn } = require('child_process');
const metrics = require('../utils/metrics');

function startLdapMonitor() {
    const logFile = '/var/lib/ldap/slapd.log';
    if (!fs.existsSync(logFile)) {
        setTimeout(startLdapMonitor, 5000);
        return;
    }

    const tail = spawn('tail', ['-F', logFile]);
    const connections = {}; // connID -> { ip, uid }

    tail.stdout.on('data', (data) => {
        const lines = data.toString().split('\n');
        for (const line of lines) {
            if (!line.trim()) continue;
            
            const connMatch = line.match(/conn=(\d+)/);
            if (!connMatch) continue;
            const conn = connMatch[1];
            
            if (!connections[conn]) {
                connections[conn] = {};
            }

            const ipMatch = line.match(/ACCEPT from IP=([^:]+)/);
            if (ipMatch) {
                connections[conn].ip = ipMatch[1];
            }

            const bindMatch = line.match(/BIND dn="uid=([^,]+)/i) || line.match(/BIND dn="cn=([^,]+)/i);
            if (bindMatch) {
                connections[conn].uid = bindMatch[1];
            }

            const resultMatch = line.match(/RESULT tag=\d+ err=(\d+)/);
            if (resultMatch) {
                const errCode = parseInt(resultMatch[1], 10);
                const { ip, uid } = connections[conn];
                if (errCode === 0 && uid) {
                    metrics.recordServiceUsage('LDAP Direct', uid);
                } else if (errCode === 49 || errCode === 32) {
                    metrics.recordFailedLogin(ip, uid);
                }
            }
            
            if (line.includes('closed') || line.includes('UNBIND')) {
                delete connections[conn];
            }
        }
    });

    tail.on('error', (err) => {
        console.error('Failed to start LDAP monitor', err);
    });
}

startLdapMonitor();
