const https = require('https');
const http = require('http');

module.exports = {
  type: 'webhook',
  category: 'messaging',
  name: 'Universal REST Webhook',
  description: 'Send a generic HTTP POST request with a custom JSON payload. Variables {{to}} and {{message}} will be replaced.',
  
  configSchema: [
    { key: 'url', label: 'Webhook URL', type: 'url', required: true, placeholder: 'https://api.example.com/send' },
    { key: 'method', label: 'HTTP Method', type: 'text', required: true, placeholder: 'POST' },
    { key: 'headers', label: 'Custom Headers (JSON)', type: 'text', required: false, placeholder: '{"Authorization": "Bearer ...", "Content-Type": "application/json"}' },
    { key: 'payloadTemplate', label: 'Payload Template', type: 'text', required: true, placeholder: '{"recipient": "{{to}}", "text": "{{message}}"}' },
    { key: 'apiSecret', label: 'API Secret / Auth Token', type: 'password', required: false, secret: true }
  ],

  validate: async (config) => {
    if (!config.url) return { ok: false, error: 'URL is required' };
    if (!config.payloadTemplate) return { ok: false, error: 'Payload template is required' };
    try {
      if (config.headers) JSON.parse(config.headers);
    } catch (e) {
      return { ok: false, error: 'Headers must be valid JSON' };
    }
    return { ok: true };
  },

  sendMessage: async (config, payload) => {
    const { to, message } = payload;
    let payloadStr = config.payloadTemplate || '{}';
    
    // Replace template variables safely
    payloadStr = payloadStr.replace(/\{\{to\}\}/g, to).replace(/\{\{message\}\}/g, message);

    // If there is an API secret, replace {{secret}} in the headers or url
    let headersObj = {};
    if (config.headers) {
      try {
        const parsed = JSON.parse(config.headers);
        for (const [k, v] of Object.entries(parsed)) {
          headersObj[k] = config.apiSecret ? String(v).replace(/\{\{secret\}\}/g, config.apiSecret) : v;
        }
      } catch(e) {}
    }

    if (!headersObj['Content-Type']) {
      headersObj['Content-Type'] = 'application/json';
    }

    const urlObj = new URL(config.url);
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method: config.method || 'POST',
      headers: headersObj
    };

    const client = urlObj.protocol === 'https:' ? https : http;

    return new Promise((resolve, reject) => {
      const req = client.request(options, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ status: res.statusCode, body });
          } else {
            reject(new Error(`Webhook failed: ${res.statusCode} ${body}`));
          }
        });
      });
      req.on('error', reject);
      req.write(payloadStr);
      req.end();
    });
  }
};
