const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const app = express();
app.use('/', createProxyMiddleware({
  target: 'http://localhost:8080',
  on: {
    proxyRes: (proxyRes, req, res) => {
      delete proxyRes.headers['x-frame-options'];
    }
  }
}));
app.listen(3004);
