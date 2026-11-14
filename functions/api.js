/**
 * mky-proxy —— 通用 CORS 代理（Cloudflare Pages Functions）
 *
 * 路由：/api?key=<密钥>&url=<编码后的目标地址>
 *       &ref=<可选，自定义 Referer>&org=<可选，自定义 Origin>
 *
 * 少数接口（如酷我波点歌单）要求同时带对 Referer 与 Origin，
 * 而浏览器不允许 JS 自行设置这两个头，只能由代理代劳。
 *
 * 分三层省请求：
 *
 *   客户端  Cache-Control 长 TTL —— 重复请求压根到不了函数，这才是省额度的主力
 *   边缘层  Cache API 共享缓存 —— 挡住重复回源，主要用来避开上游的频率限制
 *   源站层  超时 / 体积上限 —— 防挂死、防爆内存
 *
 * 密钥仍然只是"止损开关"而非"安全机制"：它躺在 URL 里，会出现在浏览器历史、
 * 日志和 Referer 中。要更干净，客户端可以改用 X-Proxy-Key 请求头（这里已支持）。
 */

// 访问密钥。改这里就等于换锁。
const AUTH_KEY = 'mky_71f344d993a2';

const CORS_HEADERS = {
    // 允许任意来源：这个代理的定位就是"给不可控环境用"，
    // 播放器可能从 file:// 或任意域名打开。
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': '*',
    // 让前端 JS 也能读到缓存命中标记，方便在 DevTools 里确认缓存是否生效。
    // X-Final-Url 是跟随重定向后的最终地址：短链的跳转参数只有服务端能读到，
    // 浏览器 fetch 跨域拿不到 Location，只能由代理带回来。
    'Access-Control-Expose-Headers': 'X-Proxy-Cache, X-Final-Url',
    'Access-Control-Max-Age': '86400'
};

const UPSTREAM_TIMEOUT_MS = 12000;
const MAX_BYTES = 12 * 1024 * 1024;

// 按接口性质给缓存时长（秒）。播放地址有时效（网易云约 20 分钟），
// 所以走默认的 5 分钟 —— 既省请求，又远早于它过期。
function ttlFor(u) {
    // 酷我详情会把“查询失败”也包成 200 + data:null，
    // 缓存它会让后续重试一直拿到同一份空结果，直接不缓存。
    if (u.hostname === 'm.kuwo.cn' &&
        u.pathname.indexOf('songinfoandlrc') >= 0) return 0;
    const type = u.searchParams.get('types');
    if (type === 'pic') return 604800;
    if (type === 'lyric') return 604800;
    if (type === 'search') return 1800;
    if (u.pathname.indexOf('suggest/keyword') >= 0) return 86400;
    if (u.pathname.indexOf('/search') >= 0) return 1800;
    if (/\.(jpe?g|png|webp|gif|avif)$/i.test(u.pathname)) return 604800;
    return 300;
}

// 缓存是"尽力而为"的装饰层，不是硬依赖：
// 拿不到 Cache API 就静默跳过，代理本身照常工作。
function safeCache() {
    try {
        return caches.default || null;
    } catch (_) {
        return null;
    }
}

export async function onRequest(context) {
    const req = context.request;

    // 预检请求不需要密钥：它不转发任何东西，放行不会造成消耗
    if (req.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // POST 静默回退成 GET：目标地址完全由 url 参数决定，请求体不参与转发，
    // 所以方法本身不影响结果。为习惯用 POST 发只读请求的客户端报 405 只是添乱。
    if (req.method !== 'GET' && req.method !== 'POST') {
        return json({ error: 'method not allowed', allow: 'GET, POST, OPTIONS' }, 405);
    }

    const params = new URL(req.url).searchParams;

    // ---- 密钥校验 ----
    // 优先读请求头，兼容旧的 ?key= 形式。
    const key = req.headers.get('x-proxy-key') || params.get('key');
    if (key !== AUTH_KEY) {
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

    // 可选的头覆盖：浏览器禁止 JS 设置 Referer/Origin，
    // 需要防盗链校验的接口只能靠代理转发。只接受 http(s)，挡掉 header 注入。
    const refParam = params.get('ref') || '';
    const orgParam = params.get('org') || '';
    let refHeader = '';
    let orgHeader = '';
    try {
        if (refParam) {
            const u = new URL(refParam);
            if (u.protocol === 'http:' || u.protocol === 'https:') refHeader = u.toString();
        }
        if (orgParam) {
            const u = new URL(orgParam);
            if (u.protocol === 'http:' || u.protocol === 'https:') orgHeader = u.origin;
        }
    } catch (_) {
        return json({ error: 'invalid ref/org' }, 400);
    }

    const ttl = ttlFor(targetUrl);
    // 缓存键用"上游 URL"而不是"代理 URL" —— 这样密钥变了缓存依然有效，
    // 不同用户请求同一资源也能共享命中。ref/org 会改变上游返回，必须一起进键。
    let cacheUrl = targetUrl.toString();
    if (refHeader) cacheUrl += (cacheUrl.indexOf('?') >= 0 ? '&' : '?') + '__ref=' + encodeURIComponent(refHeader);
    if (orgHeader) cacheUrl += (cacheUrl.indexOf('?') >= 0 ? '&' : '?') + '__org=' + encodeURIComponent(orgHeader);
    const cacheKey = new Request(cacheUrl, { method: 'GET' });
    const cache = safeCache();

    const hit = cache
        ? await cache.match(cacheKey).catch(function () { return null; })
        : null;
    if (hit) {
        const h = new Headers(hit.headers);
        h.set('X-Proxy-Cache', 'HIT');
        return new Response(hit.body, { status: hit.status, headers: h });
    }

    // 转发。Referer 伪装成目标站点自己，应对部分站点的防盗链检查。
    // 加超时：上游挂死时不能把函数一起拖住。
    let upstream;
    try {
        upstream = await fetch(targetUrl.toString(), {
            method: 'GET',
            headers: (function () {
                const h = {
                    'Referer': refHeader || (targetUrl.origin + '/'),
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
                        + 'AppleWebKit/537.36 (KHTML, like Gecko) '
                        + 'Chrome/120.0.0.0 Safari/537.36'
                };
                if (orgHeader) h['Origin'] = orgHeader;
                return h;
            })(),
            redirect: 'follow',
            signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
        });
    } catch (e) {
        return json({ error: 'upstream fetch failed', detail: String(e).slice(0, 200) }, 502);
    }

    // 体积上限。Content-Length 不总是存在，拿不到就交给流式转发。
    const size = Number(upstream.headers.get('Content-Length') || 0);
    if (size > MAX_BYTES) {
        return json({ error: 'response too large', size: size }, 413);
    }

    const headers = new Headers(CORS_HEADERS);
    headers.set('Content-Type', upstream.headers.get('Content-Type') || 'application/octet-stream');
    // 重定向已跟随，upstream.url 是最终落点。酷狗 t1.kugou.com 这类短链
    // 把 global_specialid 放在 302 的 Location 里，只能靠这个头交给前端。
    headers.set('X-Final-Url', upstream.url || targetUrl.toString());

    // 只缓存成功的响应。把 4xx/5xx 缓存 5 分钟会让故障"粘住"，
    // 上游一恢复用户却还在看旧错误。
    const cacheable = upstream.ok && ttl > 0;
    headers.set('X-Proxy-Cache', cacheable ? 'MISS' : 'BYPASS');
    headers.set('Cache-Control', cacheable
        ? 'public, max-age=' + ttl + ', stale-while-revalidate=' + ttl
        : 'no-store');

    const res = new Response(upstream.body, { status: upstream.status, headers });

    // 放到后台写缓存，别让用户等它写完。
    // waitUntil 缺失（或缓存层不可用）时直接放弃写入，不影响这次响应。
    if (cacheable && cache && typeof context.waitUntil === 'function') {
        context.waitUntil(
            cache.put(cacheKey, res.clone()).catch(function () {})
        );
    }

    return res;
}

function json(obj, status) {
    return new Response(JSON.stringify(obj), {
        status,
        headers: {
            ...CORS_HEADERS,
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store'
        }
    });
}