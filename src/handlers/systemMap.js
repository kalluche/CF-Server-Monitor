// 系统全图（面板内嵌版）：GET /map，挂在面板登录/App 口令之后。
// 页面本体是 Muse Space「系统全图」导出的单文件 HTML（base64 存于 systemMapHtml.js），
// 页面打开后自行拉取 /system-status 每 60 秒刷新染色，与 Space 版看同一份实时数据。
import { checkAuth, hasAppPasswordAccess, simpleAuthResponse } from '../middleware/auth.js';
import { SYSTEM_MAP_HTML_B64 } from './systemMapHtml.js';

let cachedHtml = null;

function getHtml() {
  if (cachedHtml) return cachedHtml;
  const bin = atob(SYSTEM_MAP_HTML_B64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  cachedHtml = new TextDecoder('utf-8').decode(bytes);
  return cachedHtml;
}

export async function handleSystemMap(request, env, sys) {
  const isLoggedIn = await checkAuth(request, env, sys);
  const canView = isLoggedIn || hasAppPasswordAccess(request, sys);
  // 与面板私有数据同一口径：站点私有时，未登录且无 App 口令一律 401
  if (sys.is_public !== 'true' && !canView) {
    return simpleAuthResponse();
  }
  return new Response(getHtml(), {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store'
    }
  });
}
