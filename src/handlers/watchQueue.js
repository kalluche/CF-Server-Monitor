// 点名单请求队列（分析员系统第 5 件）：总面板「点名单」页提交 → D1 队列 →
// 本机执行端拉取执行并回执。start/stop 由轮询器（analyst/watch_poller.py）
// 执行四开关；analyze/ask 由分析员执行器（analyst/analyst_executor.py）执行
// （组包 → 调 Test → 判断进登记队列 / 追问答回写档案），两边各认各的 action。
// POST /watch-request       页面提交。body {symbol, action, token, question?}。
//   action: start | stop | analyze | ask。ask 必须带 question（清洗后
//   非空、≤500 字，随行存 question 列）。
//   token = hex(sha256(API_SECRET + ":watch-request:v1"))：页面由 homepage
//   sync.py 从同一 API_SECRET 派生注入，本 handler 同算法校验，常量时间比对。
//   页面用 text/plain 简单请求提交（无预检），故本 handler 自行回
//   Access-Control-Allow-Origin: https://kalluche.xyz（同 /system-status 先例）。
// GET  /watch-requests      执行端拉待办，X-Api-Secret = API_SECRET（同 /part-status）。
// POST /watch-request-done  执行端回执 {id, ok, detail}，X-Api-Secret 同上。
import {
  createSuccessResponse,
  createBadRequestResponse,
  createUnauthorizedResponse
} from '../utils/errors.js';

const TABLE_DDL = `CREATE TABLE IF NOT EXISTS watch_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT NOT NULL,
  action TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  detail TEXT NOT NULL DEFAULT '',
  question TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  done_at INTEGER
)`;

const ACTIONS = ['start', 'stop', 'analyze', 'ask'];
// start/stop/analyze 同币同动作已有 pending 时幂等去重（analyze 再点一次
// 不能排两份分析）；ask 每条问题都不同，永不去重。
const DEDUP_ACTIONS = ['start', 'stop', 'analyze'];

const SYMBOL_RE = /^[A-Z0-9]{2,15}USDT$/;
const PAGE_ORIGIN = 'https://kalluche.xyz';

function constantTimeEquals(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

async function pageToken(env) {
  const raw = new TextEncoder().encode(String(env.API_SECRET || '') + ':watch-request:v1');
  const digest = await crypto.subtle.digest('SHA-256', raw);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function ensureTable(db) {
  await db.prepare(TABLE_DDL).run();
  // 旧表（2026-11-23 建）没有 question 列：查 pragma 后补 ALTER，
  // 已有列时跳过，保证重复调用安全。
  const cols = await db.prepare(
    `SELECT name FROM pragma_table_info('watch_requests')`
  ).all();
  const names = (cols.results || []).map((r) => r.name);
  if (!names.includes('question')) {
    await db.prepare(
      `ALTER TABLE watch_requests ADD COLUMN question TEXT NOT NULL DEFAULT ''`
    ).run();
  }
}

function cleanQuestion(q) {
  // 追问文本基本清洗：控制字符变空格、空白折叠、去首尾、截 500 字。
  return String(q || '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
}

function pageCors(resp) {
  const headers = new Headers(resp.headers);
  headers.set('Access-Control-Allow-Origin', PAGE_ORIGIN);
  headers.set('Vary', 'Origin');
  return new Response(resp.body, {
    status: resp.status,
    statusText: resp.statusText,
    headers
  });
}

export async function handleWatchRequestPost(request, env) {
  let data;
  try {
    data = await request.json();
  } catch (_) {
    return pageCors(createBadRequestResponse('invalidJson'));
  }
  const expected = await pageToken(env);
  const provided = String(data?.token || '');
  if (!provided || !constantTimeEquals(provided, expected)) {
    return pageCors(createUnauthorizedResponse());
  }
  const symbol = String(data?.symbol || '').toUpperCase();
  const action = String(data?.action || '');
  if (!SYMBOL_RE.test(symbol) || !ACTIONS.includes(action)) {
    return pageCors(createBadRequestResponse('invalidSymbolOrAction'));
  }
  let question = '';
  if (action === 'ask') {
    question = cleanQuestion(data?.question);
    if (!question) {
      return pageCors(createBadRequestResponse('emptyQuestion'));
    }
  }
  await ensureTable(env.DB);
  // 幂等：start/stop/analyze 同币同动作已有 pending 时直接返回那条，
  // 不重复入队（analyze 重复点不会排两份分析）；ask 永不去重。
  if (DEDUP_ACTIONS.includes(action)) {
    const dup = await env.DB.prepare(
      `SELECT id FROM watch_requests
       WHERE symbol = ?1 AND action = ?2 AND status = 'pending' ORDER BY id LIMIT 1`
    ).bind(symbol, action).first();
    if (dup) {
      return pageCors(createSuccessResponse({ ok: true, id: dup.id, deduped: true }));
    }
  }
  const now = Math.floor(Date.now() / 1000);
  const res = await env.DB.prepare(
    `INSERT INTO watch_requests (symbol, action, status, question, created_at)
     VALUES (?1, ?2, 'pending', ?3, ?4)`
  ).bind(symbol, action, question, now).run();
  return pageCors(createSuccessResponse({ ok: true, id: res.meta.last_row_id }));
}

function checkApiSecret(request, env) {
  const provided = String(request.headers.get('X-Api-Secret') || '');
  return !!provided &&
    constantTimeEquals(provided, String(env.API_SECRET || ''));
}

export async function handleWatchRequestsGet(request, env) {
  if (!checkApiSecret(request, env)) {
    return createUnauthorizedResponse();
  }
  await ensureTable(env.DB);
  const { results } = await env.DB.prepare(
    `SELECT id, symbol, action, question, created_at FROM watch_requests
     WHERE status = 'pending' ORDER BY id`
  ).all();
  return createSuccessResponse({ ok: true, requests: results || [] });
}

export async function handleWatchRequestDone(request, env) {
  if (!checkApiSecret(request, env)) {
    return createUnauthorizedResponse();
  }
  let data;
  try {
    data = await request.json();
  } catch (_) {
    return createBadRequestResponse('invalidJson');
  }
  const id = Math.floor(+data?.id);
  if (!Number.isFinite(id) || id <= 0) {
    return createBadRequestResponse('invalidId');
  }
  await ensureTable(env.DB);
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `UPDATE watch_requests
     SET status = ?1, detail = ?2, done_at = ?3 WHERE id = ?4`
  ).bind(data?.ok ? 'done' : 'failed',
         String(data?.detail || '').slice(0, 500), now, id).run();
  return createSuccessResponse({ ok: true, id });
}
