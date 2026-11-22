// 系统全图实时状态：零件状态写入（看门狗/聚合器）与公开读出（全图页面）。
// POST /part-status   鉴权：请求头 X-Api-Secret 或 body.secret 与 env.API_SECRET 常量时间比对
// GET  /system-status 公开只读，Access-Control-Allow-Origin: *（全图页面跨域 fetch 用）
import {
  createSuccessResponse,
  createBadRequestResponse,
  createUnauthorizedResponse
} from '../utils/errors.js';

const TABLE_DDL = `CREATE TABLE IF NOT EXISTS part_status (
  part TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  ts INTEGER NOT NULL
)`;

const VALID_STATES = new Set(['ok', 'warn', 'fault']);
const PART_RE = /^[A-Z][A-Za-z0-9-]{0,15}$/;

// 与 middleware/auth.js 同款常量时间比较，避免逐位试探口令
function constantTimeEquals(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

async function ensureTable(db) {
  await db.prepare(TABLE_DDL).run();
}

export async function handlePartStatusPost(request, env) {
  let data;
  try {
    data = await request.json();
  } catch (_) {
    return createBadRequestResponse('invalidJson');
  }
  const provided = String(
    request.headers.get('X-Api-Secret') || data?.secret || '');
  if (!provided ||
      !constantTimeEquals(provided, String(env.API_SECRET || ''))) {
    return createUnauthorizedResponse();
  }
  const part = String(data?.part || '');
  const state = String(data?.state || '');
  const detail = String(data?.detail || '').slice(0, 500);
  const ts = Number.isFinite(+data?.ts)
    ? Math.floor(+data.ts)
    : Math.floor(Date.now() / 1000);
  if (!PART_RE.test(part) || !VALID_STATES.has(state)) {
    return createBadRequestResponse('invalidPartOrState');
  }
  await ensureTable(env.DB);
  await env.DB.prepare(
    `INSERT INTO part_status (part, state, detail, ts) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT(part) DO UPDATE SET
       state = excluded.state, detail = excluded.detail, ts = excluded.ts`
  ).bind(part, state, detail, ts).run();
  return createSuccessResponse({ ok: true, part, state, ts });
}

export async function handleSystemStatus(request, env) {
  await ensureTable(env.DB);
  const { results } = await env.DB.prepare(
    'SELECT part, state, detail, ts FROM part_status ORDER BY part'
  ).all();
  const parts = {};
  let latest = 0;
  for (const r of results || []) {
    // state 与 status 双写：图侧解析器主形态认 status，生产者/文档口径认 state，
    // 两边都给，免得字段名打架导致图永远进不了实时模式（2026-11-23 对齐）
    parts[r.part] = { state: r.state, status: r.state, detail: r.detail, ts: r.ts };
    if (r.ts > latest) latest = r.ts;
  }
  // 不走 applyCors 的来源白名单：本端点按设计公开，固定回 * 并禁缓存
  return new Response(JSON.stringify({ ok: true, updated: latest, updatedAt: latest, parts }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store'
    }
  });
}
