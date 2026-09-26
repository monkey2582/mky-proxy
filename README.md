# mky-proxy

一个**通用 CORS 代理**，部署在 Cloudflare Pages Functions 上。带密钥保护，放行所有域名。

30 行代码，免费额度 10 万次/天，零成本自建 —— 用来替代那些已经全部阵亡的公共 CORS 代理。

**自测页 →** https://mky-proxy.pages.dev

---

## 它解决什么问题

浏览器有同源策略：网页里的 JS 无法读取跨域响应，除非对方返回 `Access-Control-Allow-Origin`。

很多有价值的接口（比如网易云的歌词接口 `music.163.com/api/song/lyric`）不返回这个头，于是网页直接 `fetch` 必然失败。传统解法是找一个公共 CORS 代理中转，但**公共代理 2026 年已全军覆没**：要么关停、要么限流、要么要求付费 token、要么返回垃圾数据。

自己搭一个，30 行代码，永久可用。

---

## 用法

```
GET https://mky-proxy.pages.dev/api?key=<密钥>&url=<URL 编码的目标地址>
```

**示例**

```bash
# 取网易云歌词
curl "https://mky-proxy.pages.dev/api?key=YOUR_KEY&url=https%3A%2F%2Fmusic.163.com%2Fapi%2Fsong%2Flyric%3Fos%3Dpc%26id%3D347230"

# 任意域名都可以
curl "https://mky-proxy.pages.dev/api?key=YOUR_KEY&url=https%3A%2F%2Fhttpbin.org%2Fget"
```

**前端调用**

```js
const CF_PROXY = 'https://mky-proxy.pages.dev/api';
const CF_PROXY_KEY = 'your_key_here';

const target = 'https://music.163.com/api/song/lyric?os=pc&lv=-1&id=347230';
const res = await fetch(
  CF_PROXY + '?key=' + encodeURIComponent(CF_PROXY_KEY) +
  '&url=' + encodeURIComponent(target)
);
const data = await res.json();
```

---

## 参数

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `key` | ✅ | 访问密钥，须与 `functions/api.js` 里的 `AUTH_KEY` 一致 |
| `url` | ✅ | 目标地址，须 URL 编码。只允许 `http:` / `https:` 协议 |

**响应**

- 成功：原样转发目标响应体，状态码与上游一致，附 `Access-Control-Allow-Origin: *`
- `403`：密钥缺失或错误 — `{"error":"forbidden","hint":"missing or wrong key"}`
- `400`：缺少 `url` 参数，或协议不被允许（如 `file:` / `data:`）
- `502`：回源失败 — `{"error":"upstream fetch failed","detail":"..."}`

---

## 部署

### 1. 建仓库

把本仓库 Fork 到你自己的 GitHub 账号。

### 2. 改密钥

打开 `functions/api.js`，修改这一行：

```js
const AUTH_KEY = 'mky_your_own_random_string';
```

换成一个只有你知道的随机字符串。**这一步很重要** —— 默认密钥是公开的，不改等于没有保护。

### 3. 连 Cloudflare Pages

Cloudflare Dashboard → **Workers & Pages** → **Create** → **Pages** → **Connect to Git**

选中本仓库，构建配置全部留空：

| 字段 | 值 |
| --- | --- |
| Framework preset | None |
| Build command | *留空* |
| Build output directory | *留空* |

**必须留空。** 没有构建步骤，Cloudflare 会直接把 `functions/` 目录编译成 Functions，根目录当静态资源发布。

### 4. 部署

Save and Deploy。约 1 分钟后访问 `https://<你的项目名>.pages.dev`，应该能看到自测页。

---

## 文件结构

```
.
├── index.html            自测页，浏览器打开可随时验活
├── functions/
│   └── api.js            代理本体，路由 /api
└── README.md
```

`functions/api.js` 导出 `onRequest`，Cloudflare Pages 会按文件路径自动路由：`functions/api.js` → `/api`。

---

## 为什么用 Pages 而不是 Worker

**因为 `*.workers.dev` 在中国大陆被 DNS 污染。**

实测：`*.workers.dev` 解析到 `2a03:2880:...:face:b00c` —— 一个 Facebook 的 IPv6 地址段。直连必然 `ERR_CONNECTION_TIMED_OUT`。

而 `*.pages.dev` 解析到真实的 Cloudflare IP（`172.66.x.x` / `2606:4700::`），国内可直连。

这是本项目唯一选择 Pages 的原因。功能上两者都能做 CORS 代理。

---

## 安全说明

**这个代理放行所有域名** —— 这是设计意图（"跳过所有 CORS"），但也意味着**一旦密钥泄露，任何人都能拿它当免费跳板**，消耗你的每日 10 万次额度。

所以：

- **必须修改 `AUTH_KEY`**，别用默认值
- 密钥只放在前端代码里就意味着会泄露（前端没有秘密）。这道防护的意义是**挡住自动化扫描器**，不是挡住看源码的人
- 真被刷爆了：改 `AUTH_KEY` → 提交 → 自动重新部署，再同步改前端

**已做的最小防护**

- 密钥校验（`403`）
- 协议白名单（只允许 `http:` / `https:`，挡掉 `file:` / `data:`）
- `URL` 构造校验（非法 URL 直接 `400`）

**未做（有意为之）**

- 域名白名单 —— 与"通用代理"的定位冲突
- Referer 校验 —— 可以一行代码伪造，挡不住真正的威胁，只增加复杂度
- 速率限制 —— 免费额度本来就够个人用，加限流是过度设计

---

## 免费额度

Cloudflare 免费版：

| 项目 | 额度 |
| --- | --- |
| **Functions 调用** | **10 万次 / 天**（账号级，所有项目共享） |
| 静态资源请求 | 无限 |
| 构建 | 500 次 / 月 |
| 带宽 | 无限 |

额度按 **UTC 0 点**（北京时间早 8 点）重置。

个人使用量级参考：一天听 1000 首歌 = 1000 次调用 = 用掉 1%。

---

## 踩坑记录

### Direct Upload 不编译 Functions

用 API 直接上传文件（Direct Upload / `ad_hoc`）的项目，**Functions 不会被编译**，`uses_functions` 恒为 `false`，即使 `functions/api.js` 确实出现在文件清单里。

只有 Git 连接的项目才启用 Functions，且 Direct Upload 项目**无法通过 API 转换**为 Git 项目（返回 `8000069`）。

**结论：functions 必须走 Git 部署。**

### 上传 API 的两个细节

若用 API 上传：

1. `manifest` 必须是**内联 JSON 字符串**表单字段，当文件上传会报 `8000096`
2. manifest 的 key **不能有前导斜杠** —— `"functions/api.js"` ✅，`"/functions/api.js"` ❌

### 别用 Python 脚本测

Cloudflare 的 WAF 会把默认 UA `Python-urllib/3.x` 判定为机器人，直接返回 `403 error code: 1010`。这个 `403` **不是你的 Functions 返回的**，请求根本没到。测试时带上浏览器 UA：

```bash
curl -A "Mozilla/5.0 ... Chrome/120.0.0.0 Safari/537.36" "https://..."
```

---

## 许可

MIT
