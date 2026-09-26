/**
 * mky-proxy —— 通用 CORS 代理（Cloudflare Pages Functions）
 *
 * 路由：/api?key=<密钥>&url=<编码后的目标地址>
 *
 * 设计要点：
 *
 * ① 带密钥才能用。放行所有域名意味着任何人拿去都能当免费跳板，
 *    而 *.pages.dev 这类子域正是扫描器的常规目标。带上密钥后，
 *    陌生人扫到也只会拿到 403，不会消耗你的免费额度。
 *
 * ② 换密钥只需改下面 AUTH_KEY 一行，然后重新部署。
 *
 * ③ 密钥不是"安全机制"，只是"止损开关"。它躺在 URL 里，
 *    会出现在浏览器历史、日志、Referer 中 —— 保持合理预期即可。
 */

// 访问密钥。改这里就等于换锁。
const AUTH_KEY = 'mky_71f344d993a2';

const CORS_HEADERS = {
    // 允许任意来源：这个代理的定位就是"给不可控环境用"，
    // 播放器可能从 file:// 或任意域名打开。
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Max-Age': '86400'
};

export async function onRequest(context) {
    const req = context.request;

    // 预检请求不需要密钥：它不转发任何东西，放行不会造成消耗
    if (req.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const params = new URL(req.url).searchParams;

    // ---- 密钥校验 ----
    if (params.get('key') !== AUTH_KEY) {
        return json({ error: 'forbidden', hint: 'missing or wrong key' }, 403);
    }

    const target = params.get('url');
    if (!target) {
        return json({
            error: 'missing url param',
            usage: '/api?key=<key>&url=<encoded target>'
        }, 400);
    }

    let targetUrl;
    try {
        targetUrl = new URL(target);
    } catch (_) {
        return json({ error: 'invalid url', got: target }, 400);
    }

    // 只允许 http/https：挡掉 file:、data: 这类协议。
    // 放行所有域名是刻意的（这就是"通用代理"的意思），
    // 但协议白名单仍有必要 —— 否则等于把 fetch 的全部能力暴露出去。
    if (targetUrl.protocol !== 'http:' && targetUrl.protocol !== 'https:') {
        return json({ error: 'protocol not allowed', got: targetUrl.protocol }, 400);
    }

    // 转发。Referer 伪装成目标站点自己，应对部分站点的防盗链检查。
    let upstream;
    try {
        upstream = await fetch(targetUrl.toString(), {
            method: 'GET',
            headers: {
                'Referer': targetUrl.origin + '/',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
                    + 'AppleWebKit/537.36 (KHTML, like Gecko) '
                    + 'Chrome/120.0.0.0 Safari/537.36'
            },
            redirect: 'follow'
        });
    } catch (e) {
        return json({ error: 'upstream fetch failed', detail: String(e) }, 502);
    }

    const body = await upstream.arrayBuffer();

    return new Response(body, {
        status: upstream.status,
        headers: {
            ...CORS_HEADERS,
            'Content-Type': upstream.headers.get('Content-Type') || 'application/octet-stream',
            // 短缓存：同一资源短时间重复请求不必回源。
            // 5 分钟是个折中 —— 够省请求，又不至于让"刚更新的内容"看不到。
            'Cache-Control': 'public, max-age=300'
        }
    });
}

function json(obj, status) {
    return new Response(JSON.stringify(obj), {
        status,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
    });
}
