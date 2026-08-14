/**
 * 天猫AI推广半自动化平台 - 后端服务
 * 纯 Node.js 内置模块实现（http/fs/path/url/crypto），无任何 npm 依赖
 * Node.js >= 18（使用内置 fetch）
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ===================== 配置 =====================
const PORT = parseInt(process.env.PORT || '8081', 10);
const HOST = process.env.HOST || '0.0.0.0';

const CONFIG = {
  appKey: process.env.TAOBAO_APP_KEY || '',
  appSecret: process.env.TAOBAO_APP_SECRET || '',
  redirectUri: process.env.TAOBAO_REDIRECT_URI || `http://localhost:${PORT}/api/auth/callback`,
  sessionSecret: process.env.SESSION_SECRET || 'tmall-ai-promotion-default-secret'
};

const OAUTH_AUTHORIZE_URL = 'https://oauth.taobao.com/authorize';
const OAUTH_TOKEN_URL = 'https://oauth.taobao.com/token';
const OPEN_API_GATEWAY = 'https://eco.taobao.com/router/rest';

// ===================== 内存存储 =====================
// OAuth state -> { shopName, createdAt }
const sessions = new Map();
// userId -> { accessToken, refreshToken, expiresAt, nick, shopName, userId, createdAt }
const tokens = new Map();

// 定期清理过期 state（30分钟）
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of sessions) {
    if (now - v.createdAt > 30 * 60 * 1000) sessions.delete(k);
  }
}, 60 * 1000).unref();

// ===================== 工具函数 =====================
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
};

function log(req, extra) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${req.method} ${req.url}${extra ? ' :: ' + extra : ''}`);
}

function sendJSON(res, statusCode, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization'
  });
  res.end(body);
}

function sendHTML(res, statusCode, html) {
  res.writeHead(statusCode, {
    'Content-Type': 'text/html; charset=utf-8',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(html);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 5 * 1024 * 1024) {
        reject(new Error('Body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        resolve({});
      }
    });
    req.on('error', reject);
  });
}

function pad2(n) { return n < 10 ? '0' + n : '' + n; }

function formatTimestamp(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
    `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/**
 * 淘宝/阿里妈妈 TOP 网关签名：HMAC-MD5(secret, sortedConcatOfAllKvPairs)，hex 大写
 * 拼接规则：按 key 排序后 key1value1key2value2...
 */
function signRequest(params, secret) {
  const keys = Object.keys(params).sort();
  const plain = keys.map((k) => k + String(params[k] == null ? '' : params[k])).join('');
  return crypto.createHmac('md5', secret).update(plain, 'utf8').digest('hex').toUpperCase();
}

async function postForm(url, params) {
  const body = new URLSearchParams(params).toString();
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8'
    },
    body
  });
  const text = await resp.text();
  try {
    return JSON.parse(text);
  } catch (e) {
    return { raw: text, parse_error: true };
  }
}

// ===================== 静态文件服务 =====================
const PUBLIC_DIR = path.join(__dirname, 'public');

function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  // 防目录穿越
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    return res.end('Forbidden');
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      // SPA fallback：非文件路径一律返回首页
      if (!path.extname(rel)) {
        return fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, d2) => {
          if (e2) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not Found'); }
          res.writeHead(200, { 'Content-Type': MIME['.html'] });
          res.end(d2);
        });
      }
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not Found');
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600'
    });
    res.end(data);
  });
}

// ===================== API 路由处理 =====================
async function handleApi(req, res, pathname, query) {
  // ---------- 健康检查 ----------
  if (req.method === 'GET' && pathname === '/api/health') {
    return sendJSON(res, 200, { status: 'ok', time: new Date().toISOString() });
  }

  // ---------- 登录：生成授权 URL ----------
  if (req.method === 'POST' && pathname === '/api/auth/login') {
    const body = await readBody(req);
    const shopName = String(body.shopName || '').trim();
    if (!CONFIG.appKey || !CONFIG.appSecret) {
      return sendJSON(res, 200, {
        status: 'not_configured',
        message: '请先配置阿里妈妈开放平台appKey/appSecret'
      });
    }
    const state = crypto.randomBytes(16).toString('hex');
    sessions.set(state, { shopName: shopName || '未命名店铺', createdAt: Date.now() });
    const authUrl = `${OAUTH_AUTHORIZE_URL}?response_type=code&client_id=${encodeURIComponent(CONFIG.appKey)}` +
      `&redirect_uri=${encodeURIComponent(CONFIG.redirectUri)}&state=${encodeURIComponent(state)}&view=web`;
    return sendJSON(res, 200, { status: 'ok', authUrl, state });
  }

  // ---------- 授权回调 ----------
  if (req.method === 'GET' && pathname === '/api/auth/callback') {
    const code = query.get('code');
    const state = query.get('state') || '';
    const error = query.get('error') || query.get('error_description');
    if (error) {
      return sendHTML(res, 400, callbackPage(false, '授权失败: ' + error));
    }
    if (!code) {
      return sendHTML(res, 400, callbackPage(false, '缺少授权code参数'));
    }
    if (!CONFIG.appKey || !CONFIG.appSecret) {
      return sendHTML(res, 500, callbackPage(false, '服务端未配置appKey/appSecret'));
    }
    try {
      const stateData = sessions.get(state);
      const shopName = (stateData && stateData.shopName) || '未命名店铺';
      sessions.delete(state);
      const tokenResp = await postForm(OAUTH_TOKEN_URL, {
        grant_type: 'authorization_code',
        code,
        client_id: CONFIG.appKey,
        client_secret: CONFIG.appSecret,
        redirect_uri: CONFIG.redirectUri,
        state
      });
      if (tokenResp.error || !tokenResp.access_token) {
        const msg = tokenResp.error_description || tokenResp.error || JSON.stringify(tokenResp).slice(0, 300);
        return sendHTML(res, 200, callbackPage(false, 'Token换取失败: ' + msg));
      }
      const userId = String(tokenResp.taobao_user_id || tokenResp.sub || ('u_' + Date.now()));
      const record = {
        userId,
        shopName,
        nick: tokenResp.taobao_user_nick || shopName,
        accessToken: tokenResp.access_token,
        refreshToken: tokenResp.refresh_token || '',
        expiresAt: Date.now() + (parseInt(tokenResp.expires_in || '86400', 10) * 1000),
        createdAt: Date.now()
      };
      tokens.set(userId, record);
      log(req, `授权成功 userId=${userId} nick=${record.nick}`);
      return sendHTML(res, 200, callbackPage(true, '授权成功', {
        userId: record.userId,
        shopName: record.shopName,
        nick: record.nick,
        expiresAt: record.expiresAt
      }));
    } catch (e) {
      return sendHTML(res, 200, callbackPage(false, '回调处理异常: ' + e.message));
    }
  }

  // ---------- 刷新 Token ----------
  if (req.method === 'POST' && pathname === '/api/auth/refresh') {
    const body = await readBody(req);
    const userId = String(body.userId || '');
    const record = tokens.get(userId);
    if (!record) return sendJSON(res, 404, { status: 'error', message: '未找到该店铺的授权记录' });
    if (!record.refreshToken) return sendJSON(res, 400, { status: 'error', message: '该记录无refresh_token，请重新授权' });
    try {
      const tokenResp = await postForm(OAUTH_TOKEN_URL, {
        grant_type: 'refresh_token',
        refresh_token: record.refreshToken,
        client_id: CONFIG.appKey,
        client_secret: CONFIG.appSecret,
        redirect_uri: CONFIG.redirectUri
      });
      if (tokenResp.error || !tokenResp.access_token) {
        return sendJSON(res, 200, { status: 'error', message: '刷新失败: ' + (tokenResp.error_description || tokenResp.error || '未知错误') });
      }
      record.accessToken = tokenResp.access_token;
      if (tokenResp.refresh_token) record.refreshToken = tokenResp.refresh_token;
      if (tokenResp.expires_in) record.expiresAt = Date.now() + parseInt(tokenResp.expires_in, 10) * 1000;
      if (tokenResp.taobao_user_nick) record.nick = tokenResp.taobao_user_nick;
      tokens.set(userId, record);
      return sendJSON(res, 200, { status: 'ok', message: 'Token已刷新', expiresAt: record.expiresAt });
    } catch (e) {
      return sendJSON(res, 200, { status: 'error', message: '刷新异常: ' + e.message });
    }
  }

  // ---------- 授权状态 ----------
  if (req.method === 'GET' && pathname === '/api/auth/status') {
    const now = Date.now();
    const stores = [];
    for (const [userId, t] of tokens) {
      stores.push({
        userId,
        shopName: t.shopName,
        nick: t.nick,
        expiresAt: t.expiresAt,
        expired: t.expiresAt <= now,
        expiresIn: Math.max(0, Math.round((t.expiresAt - now) / 1000))
      });
    }
    return sendJSON(res, 200, {
      status: 'ok',
      configured: Boolean(CONFIG.appKey && CONFIG.appSecret),
      mode: (CONFIG.appKey && CONFIG.appSecret && stores.length) ? 'real' : 'demo',
      count: stores.length,
      stores
    });
  }

  // ---------- 退出登录 ----------
  if (req.method === 'POST' && pathname === '/api/auth/logout') {
    const body = await readBody(req);
    const userId = String(body.userId || '');
    const removed = tokens.delete(userId);
    return sendJSON(res, 200, { status: removed ? 'ok' : 'not_found', message: removed ? '已退出登录' : '记录不存在' });
  }

  // ---------- 阿里妈妈开放API网关代理 ----------
  if (req.method === 'POST' && pathname === '/api/proxy/alimama') {
    const body = await readBody(req);
    const userId = String(body.userId || '');
    const method = String(body.method || '');
    const params = (body.params && typeof body.params === 'object') ? body.params : {};
    if (!method) return sendJSON(res, 400, { status: 'error', message: '缺少method参数' });
    if (!CONFIG.appKey || !CONFIG.appSecret) {
      return sendJSON(res, 200, {
        status: 'not_configured',
        message: '请先配置阿里妈妈开放平台appKey/appSecret'
      });
    }
    const record = tokens.get(userId);
    if (!record) return sendJSON(res, 401, { status: 'error', message: '该店铺未授权或授权已失效，请重新登录' });

    // 组装 TOP 公共参数 + 业务参数
    const allParams = Object.assign({}, params, {
      method,
      app_key: CONFIG.appKey,
      session: record.accessToken,
      timestamp: formatTimestamp(new Date()),
      v: '2.0',
      sign_method: 'hmac',
      format: 'json'
    });
    allParams.sign = signRequest(allParams, CONFIG.appSecret);

    try {
      const resp = await postForm(OPEN_API_GATEWAY, allParams);
      // 透传上游响应（包括未开通权限的报错，便于前端透明展示）
      return sendJSON(res, 200, { status: 'ok', method, response: resp });
    } catch (e) {
      return sendJSON(res, 200, { status: 'error', method, message: '网关请求失败: ' + e.message });
    }
  }

  // 404
  sendJSON(res, 404, { status: 'error', message: 'API not found: ' + req.method + ' ' + pathname });
}

// 授权回调成功页：postMessage 通知父窗口并自动关闭
function callbackPage(success, message, shop) {
  const payload = success
    ? JSON.stringify({ type: 'auth_success', shop: shop || {} })
    : JSON.stringify({ type: 'auth_failed', message: message || '' });
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="UTF-8"><title>授权回调</title>
<style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f5f6fa}
.box{text-align:center;padding:40px;background:#fff;border-radius:12px;box-shadow:0 4px 12px rgba(0,0,0,.1)}
.ok{color:#10b981;font-size:48px}.fail{color:#ef4444;font-size:48px}</style></head>
<body><div class="box">
<div class="${success ? 'ok' : 'fail'}">${success ? '&#10004;' : '&#10006;'}</div>
<h2>${success ? '店铺授权成功' : '授权失败'}</h2>
<p style="color:#718096">${message || ''}</p>
<p style="color:#a0aec0;font-size:12px">本窗口将自动关闭...</p>
</div>
<script>
try{
  if(window.opener){window.opener.postMessage(${payload},'*');}
}catch(e){}
setTimeout(function(){try{window.close();}catch(e){}},1500);
</script>
</body></html>`;
}

// ===================== HTTP Server =====================
const server = http.createServer(async (req, res) => {
  const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = urlObj.pathname;

  // CORS 预检
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
      'Access-Control-Max-Age': '86400'
    });
    return res.end();
  }

  try {
    if (pathname.startsWith('/api/')) {
      log(req);
      return await handleApi(req, res, pathname, urlObj.searchParams);
    }
    log(req, 'static');
    return serveStatic(req, res, pathname);
  } catch (e) {
    console.error(`[ERROR] ${req.method} ${req.url}:`, e);
    return sendJSON(res, 500, { status: 'error', message: '服务器内部错误: ' + e.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log('==============================================');
  console.log('  天猫AI推广半自动化平台 后端服务已启动');
  console.log(`  地址: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(`  阿里妈妈appKey: ${CONFIG.appKey ? '已配置' : '未配置（演示模式）'}`);
  console.log(`  回调地址: ${CONFIG.redirectUri}`);
  console.log('==============================================');
});
