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
// 万相台无界版代理网关（内部代理，支持bizParams业务参数透传）
const XCXD_PROXY_URL = process.env.XCXD_PROXY_URL || 'https://one-fmw.xcxd.cn/api/proxy/universalbp';

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

// ===================== 每日推广诊断报告 · 钉钉推送 =====================
// 架构：前端「生成今日报告」时把最新报告快照 POST 到 /api/report/snapshot；
// 推送配置（时间/星期/webhook/加签secret）由前端保存到 /api/report/config（持久化到磁盘 JSON）。
// 服务端调度器每分钟检查一次：当前 时:分 命中配置时间 且 星期启用 且 webhook 已配置，
// 则把最新快照以 markdown 消息推送到钉钉群机器人（每个时间点每天仅推一次）。
const REPORT_CONFIG_FILE = path.join(__dirname, 'report_config.json');
const REPORT_SNAPSHOT_FILE = path.join(__dirname, 'report_snapshot.json');

function readJsonFile(fp) {
  try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch (e) { return null; }
}
function writeJsonFile(fp, obj) {
  try { fs.writeFileSync(fp, JSON.stringify(obj, null, 2), 'utf8'); return true; }
  catch (e) { console.error('[report] 写入失败 ' + fp + ': ' + e.message); return false; }
}
function loadReportConfig() {
  const saved = readJsonFile(REPORT_CONFIG_FILE) || {};
  return {
    time: String(saved.time || '09:00'),
    weekdays: Array.isArray(saved.weekdays) && saved.weekdays.length ? saved.weekdays.map(Number) : [1, 2, 3, 4, 5],
    webhook: String(saved.webhook || ''),
    secret: String(saved.secret || '')
  };
}
// 钉钉加签：sign = base64(HmacSHA256(timestamp + '\n' + secret, secret))，URL 编码后追加
function dingtalkSignedUrl(webhook, secret) {
  if (!secret) return webhook;
  const ts = Date.now();
  const stringToSign = ts + '\n' + secret;
  const sign = crypto.createHmac('sha256', secret).update(stringToSign, 'utf8').digest('base64');
  const sep = webhook.indexOf('?') >= 0 ? '&' : '?';
  return webhook + sep + 'timestamp=' + ts + '&sign=' + encodeURIComponent(sign);
}
async function pushDingtalkMarkdown(webhook, secret, title, text) {
  if (!webhook) return { status: 'not_configured', message: '未配置钉钉Webhook' };
  const url = dingtalkSignedUrl(webhook, secret);
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json;charset=utf-8' },
    body: JSON.stringify({ msgtype: 'markdown', markdown: { title: title || '推广日报', text: text || '' } })
  });
  const bodyText = await resp.text();
  let parsed;
  try { parsed = JSON.parse(bodyText); } catch (e) { parsed = { raw: bodyText, parse_error: true }; }
  return { status: 'ok', httpStatus: resp.status, upstream: parsed };
}

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

async function postJSON(url, payload) {
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json;charset=utf-8' },
    body: JSON.stringify(payload)
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

  // ---------- 万相台无界版API代理（经xcxd代理网关，bizParams格式） ----------
  if (req.method === 'POST' && pathname === '/api/proxy/alimama') {
    const body = await readBody(req);
    const method = String(body.method || '');
    const session = String(body.session || '');
    const bizParams = (body.bizParams && typeof body.bizParams === 'object') ? body.bizParams : {};
    const params = (body.params && typeof body.params === 'object') ? body.params : {};
    if (!method) return sendJSON(res, 400, { status: 'error', message: '缺少method参数' });
    if (!session) return sendJSON(res, 401, { status: 'error', message: '缺少session（店铺授权令牌）' });
    if (!CONFIG.appKey || !CONFIG.appSecret) {
      return sendJSON(res, 200, {
        status: 'not_configured',
        message: '请先配置阿里妈妈开放平台appKey/appSecret'
      });
    }

    // 合并 bizParams 与 params（params为兼容旧格式：扁平业务参数）
    const mergedBiz = Object.assign({}, params, bizParams);
    // 兼容：若未显式传 top_service_context，自动补充默认业务线上下文
    if (!mergedBiz.top_service_context) {
      mergedBiz.top_service_context = JSON.stringify({ biz_code: 'onebpSearch', login_type: 1 });
    }

    const proxyPayload = {
      appid: CONFIG.appKey,
      appsecret: CONFIG.appSecret,
      session: session,
      method: method,
      bizParams: mergedBiz
    };

    try {
      const resp = await postJSON(XCXD_PROXY_URL, proxyPayload);
      // 透传上游响应（包括未开通权限的报错，便于前端透明展示）
      return sendJSON(res, 200, { status: 'ok', method, response: resp });
    } catch (e) {
      return sendJSON(res, 200, { status: 'error', method, message: '代理请求失败: ' + e.message });
    }
  }

  // ---------- 推广日报：推送配置（持久化 report_config.json） ----------
  if (req.method === 'GET' && pathname === '/api/report/config') {
    return sendJSON(res, 200, { status: 'ok', config: loadReportConfig() });
  }
  if (req.method === 'POST' && pathname === '/api/report/config') {
    const body = await readBody(req);
    const cur = loadReportConfig();
    const cfg = {
      time: /^\d{2}:\d{2}$/.test(String(body.time || '')) ? String(body.time) : cur.time,
      weekdays: Array.isArray(body.weekdays) && body.weekdays.length ? body.weekdays.map(Number).filter(n => n >= 0 && n <= 6) : cur.weekdays,
      webhook: body.webhook !== undefined ? String(body.webhook).trim() : cur.webhook,
      secret: body.secret !== undefined ? String(body.secret).trim() : cur.secret
    };
    writeJsonFile(REPORT_CONFIG_FILE, cfg);
    log(req, `报告推送配置已保存 time=${cfg.time} weekdays=${cfg.weekdays.join(',')} webhook=${cfg.webhook ? '已配置' : '未配置'}`);
    return sendJSON(res, 200, { status: 'ok', config: cfg });
  }

  // ---------- 推广日报：报告快照（前端每次生成后同步，供定时推送） ----------
  if (req.method === 'POST' && pathname === '/api/report/snapshot') {
    const body = await readBody(req);
    const snap = {
      title: String(body.title || '天猫推广日报'),
      markdown: String(body.markdown || body.text || ''),
      savedAt: new Date().toISOString()
    };
    if (!snap.markdown) return sendJSON(res, 400, { status: 'error', message: '缺少 markdown 内容' });
    writeJsonFile(REPORT_SNAPSHOT_FILE, snap);
    log(req, `报告快照已保存（${snap.markdown.length}字符）`);
    return sendJSON(res, 200, { status: 'ok', savedAt: snap.savedAt });
  }

  // ---------- 推广日报：立即推送（前端「测试推送」/手动推送） ----------
  if (req.method === 'POST' && pathname === '/api/report/push') {
    const body = await readBody(req);
    const cfg = loadReportConfig();
    const webhook = String(body.webhook || cfg.webhook || '').trim();
    const secret = String(body.secret !== undefined ? body.secret : cfg.secret || '').trim();
    if (!webhook) return sendJSON(res, 200, { status: 'not_configured', message: '未配置钉钉Webhook，请在前端「推送设置」中填写并保存' });
    try {
      const r = await pushDingtalkMarkdown(webhook, secret, body.title || '天猫推广日报', body.markdown || body.text || '');
      log(req, `手动推送: ${JSON.stringify(r.upstream || {}).slice(0, 200)}`);
      return sendJSON(res, 200, r);
    } catch (e) {
      return sendJSON(res, 200, { status: 'error', message: '推送失败: ' + e.message });
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

// ===================== 推广日报定时推送调度器 =====================
// 每分钟检查：now 的 HH:MM === config.time 且 今天星期在 config.weekdays 内 且 webhook 已配置
// → 将前端最新同步的报告快照（report_snapshot.json）以 markdown 消息推送到钉钉群机器人。
// 快照不存在时仅记录提醒（请打开平台生成一次报告）。同一时间点每天只推一次。
let lastReportPushKey = '';
setInterval(async () => {
  try {
    const cfg = loadReportConfig();
    if (!cfg.webhook) return;
    const now = new Date();
    const hm = pad2(now.getHours()) + ':' + pad2(now.getMinutes());
    if (hm !== cfg.time) return;
    if (!cfg.weekdays.includes(now.getDay())) return;
    const pushKey = now.toDateString() + '_' + hm;
    if (lastReportPushKey === pushKey) return;
    lastReportPushKey = pushKey;
    const snap = readJsonFile(REPORT_SNAPSHOT_FILE);
    if (!snap || !snap.markdown) {
      console.log(`[报告调度] ${now.toLocaleString('zh-CN')} 命中推送时间，但暂无报告快照（请在平台「决策驾驶舱」生成一次日报以更新快照），本次跳过`);
      return;
    }
    const r = await pushDingtalkMarkdown(cfg.webhook, cfg.secret, snap.title || '天猫推广日报', snap.markdown);
    console.log(`[报告调度] ${now.toLocaleString('zh-CN')} 推送结果: ` + JSON.stringify(r).slice(0, 300));
  } catch (e) {
    console.error('[报告调度] 异常:', e.message);
  }
}, 60 * 1000).unref();
