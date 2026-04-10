#!/usr/bin/env node
/**
 * TANKKAUS — Fuel Optimizer
 * Single file. No npm install. Just Node.js.
 *
 *   node tankkaus.js
 *   open http://localhost:3001
 */

const http   = require('http');
const https  = require('https');
const { exec } = require('child_process');
const PORT   = process.env.PORT || 3001;

function openBrowser(url) {
  const cmd = process.platform === 'win32' ? `start "" "${url}"`
            : process.platform === 'darwin' ? `open "${url}"`
            : `xdg-open "${url}"`;
  exec(cmd, err => { if (err) console.log('  Avaa selaimessa: ' + url); });
}

// ─── Fetch helpers ────────────────────────────────────────────────────────────

function get(hostname, path, encoding = 'utf8') {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124',
    'Accept': 'text/html,application/xhtml+xml',
    'Accept-Language': 'fi-FI,fi;q=0.9',
    'Cookie': [
      'cmplz_consent_status=optin',
      'cmplz_marketing=optin',
      'cmplz_statistics=optin',
      'cmplz_functional=optin',
      'euconsent-v2=CPvzKEAPvzKEAAKA9AFICaFsAP_gAEPgAAp',
      'IABGPP_HDR_GppString=DBABMA~BAAAAAAAAgA',
      'CookieConsent={stamp:%27-1%27%2Cnecessary:true%2Cpreferences:true%2Cstatistics:true%2Cmarketing:true}',
    ].join('; '),
    'Referer': `https://${hostname}/`,
  };

  function doReq(host, reqPath, hops) {
    return new Promise((resolve, reject) => {
      if (hops > 5) { reject(new Error('too many redirects')); return; }
      const req = https.request({ hostname: host, path: reqPath, method: 'GET', headers }, res => {
        if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
          res.resume();
          const loc = new URL(res.headers.location, `https://${host}`);
          console.log(`  redirect → ${loc.href}`);
          doReq(loc.hostname, loc.pathname + loc.search, hops + 1).then(resolve, reject);
          return;
        }
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          resolve(encoding === 'binary' ? buf : buf.toString(encoding));
        });
      });
      req.on('error', reject);
      req.setTimeout(9000, () => { req.destroy(new Error('timeout')); });
      req.end();
    });
  }

  return doReq(hostname, path, 0);
}

function stripTags(s) {
  return s.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
          .replace(/&#\d+;/g, '').replace(/\s+/g, ' ').trim();
}

function win1252(buf) {
  // Decode Windows-1252 / ISO-8859-1 Finnish characters
  return buf.toString('binary')
    .replace(/\xE4/g, 'ä').replace(/\xC4/g, 'Ä')
    .replace(/\xF6/g, 'ö').replace(/\xD6/g, 'Ö')
    .replace(/\xE5/g, 'å').replace(/\xC5/g, 'Å')
    .replace(/\xE9/g, 'é').replace(/\xEB/g, 'ë')
    .replace(/\xFC/g, 'ü').replace(/\xE8/g, 'è');
}

// ─── Scrapers ─────────────────────────────────────────────────────────────────

// ─── Region → cities mapping ──────────────────────────────────────────────────
const REGIONS = {
  'PK-Seutu':           ['Helsinki','Espoo','Vantaa','Kirkkonummi','Nurmijärvi','Järvenpää','Kerava','Tuusula','Hyvinkää','Mäntsälä'],
  'Turun_seutu':        ['Turku','Raisio','Kaarina','Naantali','Lieto','Salo','Uusikaupunki'],
  'Tampereen_seutu':    ['Tampere','Nokia','Pirkkala','Kangasala','Lempäälä','Ylöjärvi'],
  'Oulun_seutu':        ['Oulu','Kempele','Liminka','Muhos','Ii'],
  'Jyva_skyla_n_seutu': ['Jyväskylä','Muurame','Laukaa'],
  'Porin_seutu':        ['Pori','Ulvila','Nakkila','Harjavalta'],
  'Seina_joen_seutu':   ['Seinäjoki','Lapua','Ilmajoki'],
};

// ─── XML API scraper ──────────────────────────────────────────────────────────
// Single call to polttoaine.net/api/ fetches all ~350 stations with real lat/lng.
// Results are cached for 5 minutes to avoid hammering the API.
let xmlCache = null;
let xmlCacheTime = 0;
const CACHE_TTL = 5 * 60 * 1000;

async function fetchAllStations() {
  const now = Date.now();
  if (xmlCache && now - xmlCacheTime < CACHE_TTL) {
    console.log('  Using cached station data');
    return xmlCache;
  }

  console.log('  Fetching polttoaine.net/api/ ...');
  const raw  = await get('polttoaine.net', '/api/', 'binary');
  const xml  = win1252(raw);
  console.log(`  Got ${xml.length} bytes, ~${(xml.match(/<station>/g)||[]).length} stations`);

  const stations = [];
  const stationRe = /<station>([\s\S]*?)<\/station>/g;
  let sm;

  while ((sm = stationRe.exec(xml)) !== null) {
    const block = sm[1];
    const tag = name => { const m = block.match(new RegExp(`<${name}>([^<]*)<\/${name}>`)); return m ? m[1].trim() : ''; };

    const city = tag('city');
    const name = tag('n') || tag('name');
    const lat  = parseFloat(tag('lat'));
    const lng  = parseFloat(tag('lon'));
    if (!city || !name || isNaN(lat) || isNaN(lng)) continue;

    const fuels = {};
    const fuelUpdated = {};
    const fuelRe = /<fuel>([\s\S]*?)<\/fuel>/g;
    const cutoff = Date.now() - 3 * 24 * 60 * 60 * 1000;
    let fm;
    while ((fm = fuelRe.exec(block)) !== null) {
      const fb      = fm[1];
      const type    = fb.match(/<type>([^<]*)<\/type>/)?.[1]?.trim();
      const price   = parseFloat(fb.match(/<price>([^<]*)<\/price>/)?.[1]);
      // API uses <date> inside <fuel> for the price update timestamp
      const updStr  = fb.match(/<date>([^<]*)<\/date>/)?.[1]?.trim() || '';
      const updTime = updStr ? new Date(updStr.replace(' ','T')).getTime() : 0;
      if (!type || isNaN(price) || price < 0.5 || price > 5) continue;
      if (!updTime || updTime < cutoff) continue;  // skip stale or undated prices
      if (type === '95E10')  { fuels.p95    = price; fuelUpdated.p95    = updStr; }
      if (type === '98E5')   { fuels.p98    = price; fuelUpdated.p98    = updStr; }
      if (type === 'diesel') { fuels.diesel = price; fuelUpdated.diesel = updStr; }
    }

    const chain = tag('chain');
    stations.push({
      source: 'polttoaine',
      brand:  chain || name.split(',')[0].trim(),
      name:   tag('address') || name,
      full:   name,
      city, lat, lng,
      date:   tag('date') || '',
      p95:    fuels.p95    || null,
      p98:    fuels.p98    || null,
      diesel: fuels.diesel || null,
      updated: fuelUpdated,
    });
  }

  console.log(`  Parsed ${stations.length} stations with real coordinates (stale >3d filtered out)`);
  xmlCache = stations;
  xmlCacheTime = now;
  return stations;
}

async function scrapePolttoaine(query) {
  const all = await fetchAllStations();

  let stations;
  if (query.cmd === '20halvinta') {
    stations = [...all].filter(s => s.p95).sort((a,b) => a.p95 - b.p95).slice(0, 20);
  } else if (query.region) {
    const cities = REGIONS[query.region] || [];
    stations = cities.length ? all.filter(s => cities.includes(s.city)) : all;
  } else if (query.city) {
    const c = query.city.replace(/a_/g,'ä').replace(/A_/g,'Ä').replace(/o_/g,'ö').replace(/O_/g,'Ö').replace(/_/g,'');
    stations = all.filter(s => s.city.toLowerCase() === c.toLowerCase() || s.city.toLowerCase() === query.city.toLowerCase());
  } else {
    stations = all;
  }

  const avg = arr => arr.length ? +(arr.reduce((a,b)=>a+b,0)/arr.length).toFixed(3) : null;
  return {
    source: 'polttoaine.net',
    count:  stations.length,
    averages: {
      p95:    avg(stations.map(s=>s.p95).filter(Boolean)),
      p98:    avg(stations.map(s=>s.p98).filter(Boolean)),
      diesel: avg(stations.map(s=>s.diesel).filter(Boolean)),
    },
    stations,
  };
}

// ─── HTTP Server ──────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p   = url.pathname;

  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  // Tight CORS — only allow same-origin (localhost)
  const origin = req.headers['origin'] || '';
  if (origin.startsWith('http://localhost') || origin.startsWith('http://127.')) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ── /  →  serve the HTML app ──────────────────────────────────────────────
  if (p === '/' || p === '/index.html') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.writeHead(200);
    res.end(APP_HTML);
    return;
  }

  // ── /api/prices ───────────────────────────────────────────────────────────
  if (p === '/api/prices') {
    try {
      const region = url.searchParams.get('region');
      const city   = url.searchParams.get('city');
      const cmd    = url.searchParams.get('cmd');

      const data = await scrapePolttoaine({ region, city, cmd });
      data.fetchedAt = new Date().toISOString();
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, ...data }));
    } catch (e) {
      console.error('  ✗ Scrape error:', e.message);
      res.writeHead(500);
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  // ── /api/health ───────────────────────────────────────────────────────────
  if (p === '/api/health') {
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true, port: PORT, time: new Date().toISOString() }));
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: 'not found' }));
});

server.listen(PORT, () => {
  const url = `http://localhost:${PORT}`;
  console.log('');
  console.log('  ⛽  TANKKAUS käynnissä');
  console.log(`  →  ${url}`);
  console.log('');
  console.log('  Avataan selain automaattisesti...');
  console.log('  Sulje painamalla Ctrl+C');
  console.log('');
  // Auto-open browser after short delay so server is ready
  setTimeout(() => openBrowser(url), 500);
}).on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.log(`\n  Portti ${PORT} on jo käytössä.`);
    console.log(`  Avaa selaimessa: http://localhost:${PORT}\n`);
  } else {
    console.error(err);
  }
});

// ─── Embedded HTML app ────────────────────────────────────────────────────────
// Fetches from /api/prices on the same origin — no CORS, no proxy needed.

// ─── Embedded HTML app ────────────────────────────────────────────────────────
const APP_HTML = `<!DOCTYPE html>
<html lang="fi" data-theme="dark" data-size="normal">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Kuokkanen Pumpulla</title>
<link href="https://fonts.googleapis.com/css2?family=Bebas+Neue&family=DM+Mono:wght@300;400;500&family=DM+Sans:wght@300;400;500&display=swap" rel="stylesheet">
<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.0/chart.umd.min.js"></script>
<style>
/* ── THEMES ── */
:root,[data-theme="dark"]{
  --bg:#0d0f0e;--s1:#141714;--s2:#1c1f1c;--b1:#252825;--b2:#323532;
  --acc:#b8f542;--a2:#f5c842;--a3:#f54242;
  --txt:#e8ede8;--mut:#666d66;--m2:#8a928a;
  --good:#b8f542;--warn:#f5c842;--bad:#f54242;
  --card-bg:#1c1f1c;--inp-bg:#1c1f1c;
}
[data-theme="light"]{
  --bg:#f4f5f2;--s1:#ffffff;--s2:#f0f1ee;--b1:#d8dad4;--b2:#c5c8c0;
  --acc:#3a7d00;--a2:#8a5c00;--a3:#b30000;
  --txt:#1a1d19;--mut:#666d60;--m2:#888f82;
  --good:#2d6200;--warn:#7a5000;--bad:#9a0000;
  --card-bg:#f0f1ee;--inp-bg:#e8eae4;
}
/* ── FONT SIZES ── */
[data-size="small"] { font-size:13px; }
[data-size="normal"]{ font-size:15px; }
[data-size="large"] { font-size:18px; }
[data-size="small"]  .logo { font-size:38px; }
[data-size="normal"] .logo { font-size:52px; }
[data-size="large"]  .logo { font-size:64px; }
[data-size="small"]  .rt { font-size:24px; }
[data-size="normal"] .rt { font-size:32px; }
[data-size="large"]  .rt { font-size:42px; }
[data-size="small"]  .cp { font-size:22px; }
[data-size="normal"] .cp { font-size:28px; }
[data-size="large"]  .cp { font-size:36px; }
/* ── BASE ── */
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--txt);font-family:'DM Sans',sans-serif;min-height:100vh;transition:background .2s,color .2s}
[data-theme="dark"] body::before{content:'';position:fixed;inset:0;pointer-events:none;
  background-image:linear-gradient(rgba(184,245,66,.018) 1px,transparent 1px),
    linear-gradient(90deg,rgba(184,245,66,.018) 1px,transparent 1px);
  background-size:44px 44px}
.wrap{position:relative;z-index:1;max-width:1200px;margin:0 auto;padding:0 20px 48px}
/* ── HEADER ── */
header{padding:24px 0 16px;border-bottom:1px solid var(--b1);
  display:flex;align-items:flex-end;gap:16px;flex-wrap:wrap}
.logo{font-family:'Bebas Neue',sans-serif;line-height:1;color:var(--acc);letter-spacing:2px}
.tagline{padding-bottom:7px}
.tagline p{font-family:'DM Mono',monospace;font-size:.67em;color:var(--mut);letter-spacing:1.5px;text-transform:uppercase}
.tagline p+p{margin-top:2px;color:var(--m2)}
.hright{margin-left:auto;display:flex;gap:8px;align-items:center;padding-bottom:5px;flex-wrap:wrap}
/* ── PILLS & BUTTONS ── */
.pill{font-family:'DM Mono',monospace;font-size:.67em;letter-spacing:1px;
  padding:3px 10px;border-radius:2px;border:1px solid var(--b1);color:var(--mut)}
.pill.live{border-color:var(--acc);color:var(--acc)}
.pill.warn{border-color:var(--warn);color:var(--warn)}
.pill.err{border-color:var(--bad);color:var(--bad)}
.iconbtn{font-family:'DM Mono',monospace;font-size:.73em;font-weight:500;
  padding:3px 8px;border-radius:2px;cursor:pointer;
  background:transparent;border:1px solid var(--b1);color:var(--mut);transition:all .15s}
.iconbtn:hover{border-color:var(--acc);color:var(--acc)}
.iconbtn.active{background:var(--acc);border-color:var(--acc);color:#0a0c0a}
/* ── TABS ── */
.tabs{display:flex;gap:0;margin-top:18px;border-bottom:2px solid var(--b1)}
.tab{font-family:'DM Mono',monospace;font-size:.73em;letter-spacing:1px;text-transform:uppercase;
  padding:8px 18px;cursor:pointer;color:var(--mut);border:none;background:transparent;
  border-bottom:2px solid transparent;margin-bottom:-2px;transition:all .15s}
.tab:hover{color:var(--txt)}
.tab.active{color:var(--acc);border-bottom-color:var(--acc)}
.tabpanel{display:none;padding-top:18px}
.tabpanel.active{display:block}
/* ── GRID ── */
.grid{display:grid;grid-template-columns:320px 1fr;gap:16px}
@media(max-width:820px){.grid{grid-template-columns:1fr}}
/* ── PANELS ── */
.panel{background:var(--s1);border:1px solid var(--b1);border-radius:3px;margin-bottom:12px}
.ph{padding:10px 16px;border-bottom:1px solid var(--b1);display:flex;align-items:center;gap:8px}
.ph h2{font-family:'DM Mono',monospace;font-size:.67em;font-weight:400;letter-spacing:2px;text-transform:uppercase;color:var(--mut)}
.dot{width:5px;height:5px;border-radius:50%;flex-shrink:0;background:var(--acc)}
.dot.y{background:var(--a2)}.dot.r{background:var(--a3)}
.pb{padding:14px}
/* ── FORM ── */
label{display:block;font-family:'DM Mono',monospace;font-size:.67em;letter-spacing:1.5px;text-transform:uppercase;color:var(--mut);margin-bottom:4px}
input,select{width:100%;background:var(--inp-bg);border:1px solid var(--b1);
  border-radius:2px;color:var(--txt);font-family:'DM Mono',monospace;
  font-size:.8em;padding:7px 10px;outline:none;transition:border-color .15s}
input:focus,select:focus{border-color:var(--acc)}
input::placeholder{color:var(--mut)}
select option{background:var(--s2)}
.f{margin-bottom:12px}
.f2{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px}
input[type=range]{padding:0;height:3px;accent-color:var(--acc);cursor:pointer}
.rrow{display:flex;align-items:center;gap:10px;margin-top:5px}
.rv{font-family:'Bebas Neue',sans-serif;font-size:1.2em;color:var(--acc);min-width:40px;text-align:right}
/* ── ACTION BUTTONS ── */
.btn{font-family:'DM Mono',monospace;font-size:.73em;letter-spacing:1.5px;
  text-transform:uppercase;padding:10px 14px;border-radius:2px;
  border:none;cursor:pointer;transition:all .15s;width:100%;display:block}
.pri{background:var(--acc);color:#0a0c0a;font-weight:500}
.pri:hover{filter:brightness(1.1)}.pri:active{transform:scale(.98)}
.sec{background:transparent;color:var(--mut);border:1px solid var(--b1)}
.sec:hover{border-color:var(--acc);color:var(--acc)}
.brow{display:flex;gap:8px;margin-top:8px}
/* ── MAP ── */
#mapwrap{background:var(--s2);border:1px solid var(--b1);border-radius:2px;
  min-height:240px;position:relative;overflow:hidden;margin-bottom:14px}
#mc{display:block;width:100%}
.mhint{position:absolute;inset:0;display:flex;flex-direction:column;
  align-items:center;justify-content:center;gap:6px;
  font-family:'DM Mono',monospace;font-size:.8em;color:var(--mut);pointer-events:none}
/* ── LOADER ── */
#ldr{display:none;padding:28px;text-align:center}
#ldr.on{display:block}
.spin{width:24px;height:24px;border:2px solid var(--b1);border-top-color:var(--acc);
  border-radius:50%;animation:spin .7s linear infinite;margin:0 auto 10px}
@keyframes spin{to{transform:rotate(360deg)}}
#ltxt{font-family:'DM Mono',monospace;font-size:.8em;color:var(--mut)}
/* ── RESULTS ── */
#res{display:none}
.rh{display:flex;align-items:baseline;gap:12px;margin-bottom:12px;flex-wrap:wrap}
.rt{font-family:'Bebas Neue',sans-serif;color:var(--txt)}
.rs{font-family:'DM Mono',monospace;font-size:.8em;color:var(--mut)}
.sg{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:14px}
@media(max-width:560px){.sg{grid-template-columns:1fr 1fr}}
.sb{background:var(--s2);border:1px solid var(--b1);border-radius:2px;padding:10px 12px}
.sl{font-family:'DM Mono',monospace;font-size:.6em;color:var(--mut);margin-bottom:2px}
.sv{font-family:'Bebas Neue',sans-serif;font-size:1.6em;color:var(--acc)}
.su{font-family:'DM Mono',monospace;font-size:.6em;color:var(--m2)}
/* ── STATION CARDS ── */
.card{background:var(--card-bg);border:1px solid var(--b1);border-radius:2px;
  padding:12px 14px;margin-bottom:8px;display:grid;grid-template-columns:1fr auto;
  gap:4px;cursor:pointer;transition:border-color .15s,transform .1s;position:relative}
.card::before{content:'';position:absolute;left:0;top:0;bottom:0;
  width:3px;background:var(--b1);transition:background .15s}
.card:hover{border-color:var(--acc);transform:translateX(2px)}
.card:hover::before,.card.best::before{background:var(--good)}
.card.best{border-color:color-mix(in srgb,var(--good) 40%,transparent)}
.card.marg::before{background:var(--warn)}
.card.lose::before{background:var(--bad)}
.rank{font-family:'DM Mono',monospace;font-size:.67em;color:var(--mut);position:absolute;top:7px;right:9px}
.cn{font-size:.87em;font-weight:500;padding-right:28px;margin-bottom:2px}
.cm{font-family:'DM Mono',monospace;font-size:.67em;color:var(--mut);display:flex;flex-wrap:wrap;gap:8px;margin-top:2px}
.cp{font-family:'Bebas Neue',sans-serif;text-align:right;line-height:1}
.cu{font-family:'DM Mono',monospace;font-size:.6em;color:var(--m2);display:block}
.csav{font-family:'DM Mono',monospace;font-size:.67em;text-align:right;margin-top:2px}
.pos{color:var(--good)}.neg{color:var(--bad)}.neu{color:var(--mut)}
.bk{display:inline-block;font-family:'DM Mono',monospace;font-size:.6em;
  letter-spacing:.5px;text-transform:uppercase;padding:1px 5px;border-radius:1px;margin-left:4px}
.bk.g{background:color-mix(in srgb,var(--good) 15%,transparent);color:var(--good);border:1px solid color-mix(in srgb,var(--good) 30%,transparent)}
.bk.y{background:color-mix(in srgb,var(--warn) 15%,transparent);color:var(--warn);border:1px solid color-mix(in srgb,var(--warn) 30%,transparent)}
.bk.r{background:color-mix(in srgb,var(--bad) 15%,transparent);color:var(--bad);border:1px solid color-mix(in srgb,var(--bad) 30%,transparent)}
/* ── COST BREAKDOWN ── */
.brkd{margin-top:8px;font-family:'DM Mono',monospace;font-size:.67em;
  color:var(--m2);line-height:2;border-top:1px solid var(--b1);padding-top:6px}
.cost-grid{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:8px}
.cost-box{background:var(--bg);border:1px solid var(--b1);border-radius:2px;padding:8px 10px;text-align:center}
.cost-lbl{font-family:'DM Mono',monospace;font-size:.6em;color:var(--mut);margin-bottom:2px}
.cost-val{font-family:'Bebas Neue',sans-serif;font-size:1.3em}
/* ── LOG ── */
.log{background:var(--s2);border:1px solid var(--b1);border-radius:2px;
  padding:8px;font-family:'DM Mono',monospace;font-size:.67em;color:var(--mut);
  max-height:90px;overflow-y:auto;line-height:1.8}
.log .ok{color:var(--good)}.log .w{color:var(--warn)}.log .e{color:var(--bad)}
/* ── HISTORY TAB ── */
.hist-empty{text-align:center;padding:48px;font-family:'DM Mono',monospace;font-size:.8em;color:var(--mut)}
.chart-wrap{background:var(--s1);border:1px solid var(--b1);border-radius:3px;padding:16px;margin-bottom:14px}
.chart-title{font-family:'DM Mono',monospace;font-size:.73em;letter-spacing:1px;text-transform:uppercase;color:var(--mut);margin-bottom:12px}
.chart-wrap canvas{max-height:260px}
.weekday-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:6px;margin-top:6px}
.wd-box{background:var(--s2);border:1px solid var(--b1);border-radius:2px;padding:8px 4px;text-align:center}
.wd-name{font-family:'DM Mono',monospace;font-size:.6em;color:var(--mut);margin-bottom:3px}
.wd-price{font-family:'Bebas Neue',sans-serif;font-size:1.2em;color:var(--acc)}
.wd-count{font-family:'DM Mono',monospace;font-size:.55em;color:var(--m2)}
.wd-box.cheapest{border-color:var(--good);background:color-mix(in srgb,var(--good) 8%,transparent)}
.wd-box.cheapest .wd-price{color:var(--good)}
.hist-row{display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--b1);font-family:'DM Mono',monospace;font-size:.73em}
.hist-time{color:var(--m2);min-width:100px}
.hist-fuel{color:var(--acc);min-width:60px}
.hist-prices{color:var(--txt);flex:1}
.hist-del{cursor:pointer;color:var(--bad);padding:2px 6px;border-radius:2px}
.hist-del:hover{background:color-mix(in srgb,var(--bad) 15%,transparent)}
.disc{border-top:1px solid var(--b1);padding:10px 0;margin-top:4px;
  font-family:'DM Mono',monospace;font-size:.6em;color:var(--mut);line-height:1.9}
</style>
</head>
<body>
<div class="wrap">

<header>
  <div>
    <div class="logo" id="logo-txt">KUOKKANEN PUMPULLA</div>
    <div class="tagline">
      <p id="t-tagline">Tankkauksen kustannusoptimoija · Suomi</p>
      <p id="dataLine">Data: polttoaine.net/api · hinnat max 3pv vanhoja</p>
    </div>
  </div>
  <div class="hright">
    <div style="display:flex;gap:3px">
      <button class="iconbtn active" id="btn-fi" onclick="setLang('fi')">FI</button>
      <button class="iconbtn" id="btn-sv" onclick="setLang('sv')">SV</button>
      <button class="iconbtn" id="btn-en" onclick="setLang('en')">EN</button>
    </div>
    <div style="display:flex;gap:3px">
      <button class="iconbtn" id="btn-theme" onclick="toggleTheme()" title="Vaihda teema">☀</button>
    </div>
    <div style="display:flex;gap:3px">
      <button class="iconbtn" id="sz-s" onclick="setSize('small')">A-</button>
      <button class="iconbtn active" id="sz-n" onclick="setSize('normal')">A</button>
      <button class="iconbtn" id="sz-l" onclick="setSize('large')">A+</button>
    </div>
    <div class="pill" id="pLoc">GPS —</div>
    <div class="pill" id="pPrices">HINNAT —</div>
  </div>
</header>

<!-- TABS -->
<div class="tabs">
  <button class="tab active" id="tab-search" onclick="showTab('search')" id="t-tab-search">Haku</button>
  <button class="tab" id="tab-history" onclick="showTab('history')" id="t-tab-hist">Historia</button>
</div>

<!-- SEARCH TAB -->
<div class="tabpanel active" id="panel-search">
<div class="grid">
<div>

  <div class="panel">
    <div class="ph"><div class="dot"></div><h2 id="t-src-panel">Tietolähde</h2></div>
    <div class="pb">
      <div class="f2">
        <div>
          <label id="t-view-lbl">Näkymä</label>
          <select id="viewType" onchange="onViewChange()">
            <option value="region" id="opt-region">Alue</option>
            <option value="city" id="opt-city">Kaupunki</option>
            <option value="cheapest" id="opt-cheapest">20 halvinta koko maassa</option>
          </select>
        </div>
        <div>
          <label id="t-fuel-lbl">Polttoainetyyppi</label>
          <select id="fuelType">
            <option value="p95">95E10</option>
            <option value="p98">98E5</option>
            <option value="diesel">Diesel</option>
          </select>
        </div>
      </div>
      <div class="f" id="regionRow">
        <label id="t-region-lbl">Alue</label>
        <select id="regionVal">
          <option value="PK-Seutu">PK-seutu (Helsinki, Espoo, Vantaa…)</option>
          <option value="Turun_seutu">Turun seutu</option>
          <option value="Tampereen_seutu">Tampereen seutu</option>
          <option value="Oulun_seutu">Oulun seutu</option>
          <option value="Jyva_skyla_n_seutu">Jyväskylän seutu</option>
          <option value="Porin_seutu">Porin seutu</option>
          <option value="Seina_joen_seutu">Seinäjoen seutu</option>
        </select>
      </div>
      <div class="f" id="cityRow" style="display:none">
        <label id="t-city-lbl">Kaupunki</label>
        <select id="cityVal">
          <option>Helsinki</option><option>Espoo</option><option>Vantaa</option>
          <option>Tampere</option><option>Turku</option><option>Oulu</option>
          <option>Lahti</option><option>Kuopio</option><option>Jyväskylä</option>
          <option>Kouvola</option><option>Pori</option><option>Hämeenlinna</option>
          <option>Vaasa</option><option>Rovaniemi</option><option>Mikkeli</option>
          <option>Lappeenranta</option><option>Rauma</option><option>Kemi</option>
          <option>Hyvinkää</option><option>Järvenpää</option>
          <option>Nurmijärvi</option><option>Kirkkonummi</option>
          <option>Riihimäki</option><option>Kajaani</option>
        </select>
      </div>
    </div>
  </div>

  <div class="panel">
    <div class="ph"><div class="dot"></div><h2 id="t-vehicle-panel">Ajoneuvo &amp; tankki</h2></div>
    <div class="pb">
      <div class="f2">
        <div>
          <label id="t-tank-lbl">Tankin koko (L)</label>
          <input type="number" id="tankSize" value="55" min="20" max="120">
        </div>
        <div>
          <label>L/100km</label>
          <input type="number" id="cons" value="7.5" min="3" max="25" step="0.1">
        </div>
      </div>
      <div class="f">
        <label><span id="t-curfuel-lbl">Polttoainetta nyt</span> — <span id="lvlLbl">40% · 22L</span></label>
        <div class="rrow">
          <input type="range" id="lvl" min="0" max="100" value="10" style="flex:1" oninput="syncR()">
          <div class="rv" id="lvlV">22L</div>
        </div>
      </div>
      <div class="f">
        <label><span id="t-fillto-lbl">Täytä</span> — <span id="fillLbl">90% · +28L</span></label>
        <div class="rrow">
          <input type="range" id="fillTo" min="50" max="100" value="100" style="flex:1" oninput="syncR()">
          <div class="rv" id="fillV">28L</div>
        </div>
      </div>
    </div>
  </div>

  <div class="panel">
    <div class="ph"><div class="dot y"></div><h2 id="t-route-panel">Reitti (valinnainen)</h2></div>
    <div class="pb">
      <div class="f">
        <label><span id="t-start-lbl">Lähtöpaikka</span> <span style="color:var(--m2)" id="t-start-hint">(tyhjä = GPS)</span></label>
        <input type="text" id="startAddr" placeholder="esim. Mannerheimintie 1, Helsinki…">
      </div>
      <div class="f">
        <label id="t-dest-lbl">Määränpää</label>
        <input type="text" id="dest" placeholder="esim. Tampere, Lahti, osoite…">
      </div>
      <div class="f2">
        <div>
          <label id="t-detour-lbl">Max kiertotie (km)</label>
          <input type="number" id="detour" value="5" min="0" max="40">
        </div>
        <div>
          <label id="t-corr-lbl">Käytävä (km)</label>
          <input type="number" id="corr" value="3" min="1" max="20">
        </div>
      </div>
      <div class="f">
        <label id="t-gmap-lbl">Google Maps API-avain <span style="color:var(--m2)">(valinnainen)</span></label>
        <input type="text" id="gmapKey" placeholder="AIza…">
      </div>
    </div>
  </div>

  <button class="btn pri" id="t-find-btn" onclick="run()" style="margin-bottom:8px">▶ ETSI PARAS ASEMA</button>
  <div class="brow">
    <button class="btn sec" id="t-gps-btn" onclick="gps(true)">⊕ GPS</button>
    <button class="btn sec" id="t-prices-btn" onclick="loadPrices(true)">↻ HINNAT</button>
  </div>

  <div style="height:10px"></div>
  <div class="panel">
    <div class="ph"><div class="dot y"></div><h2 id="t-log-panel">Loki</h2></div>
    <div class="pb" style="padding:8px">
      <div class="log" id="log"><span class="ok">Käynnistetty — avaa http://localhost:3001</span></div>
    </div>
  </div>

</div>
<div>
  <div id="mapwrap">
    <canvas id="mc"></canvas>
    <div class="mhint" id="mhint">
      <div style="font-size:1.6em;opacity:.2">⛽</div>
      <div id="t-map-hint">Aja haku niin kartta ilmestyy</div>
    </div>
  </div>
  <div id="ldr"><div class="spin"></div><div id="ltxt">Ladataan…</div></div>
  <div id="res">
    <div class="rh">
      <div class="rt" id="rTitle">—</div>
      <div class="rs" id="rSub"></div>
    </div>
    <div class="sg" id="stats"></div>
    <div id="cards"></div>
  </div>
</div>
</div>
</div>

<!-- HISTORY TAB -->
<div class="tabpanel" id="panel-history">
  <div id="hist-content"></div>
</div>

<div class="disc" id="t-disc">
  Säästö = (vertailuhinta−hinta)×litrat − kiertotiepolttoainekulu. Hinnat yli 3pv vanhat suodatetaan. Tarkista hinta pumpulta. Sivu toimii samasta Node.js-prosessista — ei proxyä. © Matti Kuokkanen, mkuokkanen@gmail.com
</div>
</div>

<script>
// ═══════════════════════════════════════════════════
// STATE & STORAGE
// ═══════════════════════════════════════════════════
const ST = { loc:null, dest:null, stations:[], fetchedAt:null };
const HIST_KEY = 'kp_history_v1';

function histLoad() {
  try { return JSON.parse(localStorage.getItem(HIST_KEY)||'[]'); } catch(e){ return []; }
}
function histSave(arr) {
  try { localStorage.setItem(HIST_KEY, JSON.stringify(arr.slice(-200))); } catch(e){}
}
function histAdd(entry) {
  const arr = histLoad();
  arr.push(entry);
  histSave(arr);
}

// ═══════════════════════════════════════════════════
// TRANSLATIONS
// ═══════════════════════════════════════════════════
const LANGS = {
  fi:{
    tagline:'Tankkauksen kustannusoptimoija · Suomi',
    srcPanel:'Tietolähde',viewLbl:'Näkymä',fuelLbl:'Polttoainetyyppi',
    optRegion:'Alue',optCity:'Kaupunki',optCheapest:'20 halvinta koko maassa',
    regionLbl:'Alue',cityLbl:'Kaupunki',
    vehiclePanel:'Ajoneuvo & tankki',tankLbl:'Tankin koko (L)',
    curFuelLbl:'Polttoainetta nyt',fillToLbl:'Täytä',
    routePanel:'Reitti (valinnainen)',
    startLbl:'Lähtöpaikka',startHint:'(tyhjä = GPS)',
    startPh:'esim. Mannerheimintie 1, Helsinki…',
    destLbl:'Määränpää',destPh:'esim. Tampere, Lahti, osoite…',
    detourLbl:'Max kiertotie (km)',corrLbl:'Käytävä (km)',
    gmapLbl:'Google Maps API-avain (valinnainen)',
    findBtn:'▶ ETSI PARAS ASEMA',gpsBtn:'⊕ GPS',pricesBtn:'↻ HINNAT',
    logPanel:'Loki',mapHint:'Aja haku niin kartta ilmestyy',
    loading:'Ladataan…',fetching:'Haetaan hintoja…',
    gpsGetting:'Haetaan sijaintia…',geocoding:'Geokoodataan…',calcDist:'Lasketaan etäisyyksiä…',
    stUnit:'ASEMAA',filling:'tankataan',rangeWord:'toimintamatka',
    optimalLbl:'Paras hinta',avgLbl:'Ka. alueella',savingLbl:'Max nettoSäästö',
    afterDetour:'€ kiertotien jälkeen',
    totalCostLbl:'Kokonaiskulu',tankCostLbl:'Tankkauskulu',detourCostLbl:'Kiertotiepolttoainekulu',netSavingLbl:'NettoSäästö',
    badgeOptimal:'OPTIMAALINEN',badgeGood:'HYVÄ',badgeMarg:'MARGINAALINEN',badgeBad:'EI KANNATA',
    crowKm:'km linnuntie',roadKm:'km tie',
    fillWord:'täytä',gross:'bruttosäästö',detour:'kiertotie',net:'netto',
    noStations:'Ei asemia — tarkista suodattimet tai laajenna hakua.',
    noData:'Ei dataa — onko palvelin käynnissä?',
    tabSearch:'Haku',tabHistory:'Historia',
    histEmpty:'Ei hakuhistoriaa. Tee haku ensin.',
    histTitle:'Hakuhistoria',histWeekTitle:'Hinnat viikonpäivittäin (ka.)',
    histTimeTitle:'Hintojen kehitys',
    histClear:'Tyhjennä historia',
    weekdays:['Ma','Ti','Ke','To','Pe','La','Su'],
    cheapestDay:'Halvin päivä',
    disc:'Säästö = (vertailuhinta−hinta)×litrat − kiertotiepolttoainekulu. Hinnat yli 3pv vanhat suodatetaan. Tarkista hinta pumpulta. Sivu toimii samasta Node.js-prosessista — ei proxyä. © Matti Kuokkanen, mkuokkanen@gmail.com © Matti Kuokkanen, mkuokkanen@gmail.com',
  },
  sv:{
    tagline:'Bränslekostnadsoptimering · Finland',
    srcPanel:'Datakälla',viewLbl:'Vy',fuelLbl:'Bränsletyp',
    optRegion:'Region',optCity:'Stad',optCheapest:'20 billigaste i landet',
    regionLbl:'Region',cityLbl:'Stad',
    vehiclePanel:'Fordon & tank',tankLbl:'Tankstorlek (L)',
    curFuelLbl:'Nuv. bränsle',fillToLbl:'Fyll till',
    routePanel:'Rutt (valfritt)',
    startLbl:'Startplats',startHint:'(tom = GPS)',
    startPh:'t.ex. Mannerheimvägen 1, Helsingfors…',
    destLbl:'Destination',destPh:'t.ex. Tammerfors, Lahtis, adress…',
    detourLbl:'Max omväg (km)',corrLbl:'Korridor (km)',
    gmapLbl:'Google Maps API-nyckel (valfri)',
    findBtn:'▶ HITTA BÄSTA STATION',gpsBtn:'⊕ GPS',pricesBtn:'↻ PRISER',
    logPanel:'Logg',mapHint:'Sök för att visa kartan',
    loading:'Laddar…',fetching:'Hämtar priser…',
    gpsGetting:'Hämtar plats…',geocoding:'Geokodning…',calcDist:'Beräknar avstånd…',
    stUnit:'STATIONER',filling:'tankar',rangeWord:'räckvidd',
    optimalLbl:'Bästa pris',avgLbl:'Snitt i omr.',savingLbl:'Max nettobesparing',
    afterDetour:'€ efter omväg',
    totalCostLbl:'Totalkostnad',tankCostLbl:'Tankningskostnad',detourCostLbl:'Omvägsbränsle',netSavingLbl:'Nettobesparing',
    badgeOptimal:'OPTIMAL',badgeGood:'BRA',badgeMarg:'MARGINELL',badgeBad:'LÖNAR SIG EJ',
    crowKm:'km fågelv.',roadKm:'km väg',
    fillWord:'fyll',gross:'bruttobesparing',detour:'omväg',net:'netto',
    noStations:'Inga stationer — justera filter.',
    noData:'Ingen data — körs servern?',
    tabSearch:'Sök',tabHistory:'Historik',
    histEmpty:'Ingen sökhistorik ännu.',
    histTitle:'Sökhistorik',histWeekTitle:'Priser per veckodag (medel)',
    histTimeTitle:'Prisutveckling',histClear:'Rensa historik',
    weekdays:['Mån','Tis','Ons','Tor','Fre','Lör','Sön'],
    cheapestDay:'Billigast dag',
    disc:'Besparing = (refpris−pris)×liter − omvägsbränsle. Priser äldre än 3d filtreras. Kontrollera alltid priset vid pumpen. Sidan körs från samma Node.js-process — ingen proxy. © Matti Kuokkanen, mkuokkanen@gmail.com',
  },
  en:{
    tagline:'Fuel Cost Optimizer · Finland',
    srcPanel:'Data Source',viewLbl:'View',fuelLbl:'Fuel type',
    optRegion:'Region',optCity:'City',optCheapest:'20 cheapest nationwide',
    regionLbl:'Region',cityLbl:'City',
    vehiclePanel:'Vehicle & Tank',tankLbl:'Tank size (L)',
    curFuelLbl:'Current fuel',fillToLbl:'Fill to',
    routePanel:'Route (optional)',
    startLbl:'Starting location',startHint:'(empty = GPS)',
    startPh:'e.g. Mannerheimintie 1, Helsinki…',
    destLbl:'Destination',destPh:'e.g. Tampere, Lahti, address…',
    detourLbl:'Max detour (km)',corrLbl:'Corridor (km)',
    gmapLbl:'Google Maps API key (optional)',
    findBtn:'▶ FIND OPTIMAL STATION',gpsBtn:'⊕ GPS',pricesBtn:'↻ PRICES',
    logPanel:'Log',mapHint:'Run a search to see map',
    loading:'Loading…',fetching:'Fetching prices…',
    gpsGetting:'Getting location…',geocoding:'Geocoding…',calcDist:'Calculating distances…',
    stUnit:'STATIONS',filling:'filling',rangeWord:'range',
    optimalLbl:'Optimal price',avgLbl:'Avg in range',savingLbl:'Max net saving',
    afterDetour:'€ after detour',
    totalCostLbl:'Total cost',tankCostLbl:'Fuel cost',detourCostLbl:'Detour fuel cost',netSavingLbl:'Net saving',
    badgeOptimal:'OPTIMAL',badgeGood:'GOOD',badgeMarg:'MARGINAL',badgeBad:'NOT WORTH IT',
    crowKm:'km crow',roadKm:'km road',
    fillWord:'fill',gross:'gross saving',detour:'detour',net:'net',
    noStations:'No stations — adjust filters.',
    noData:'No data — is the server running?',
    tabSearch:'Search',tabHistory:'History',
    histEmpty:'No search history yet.',
    histTitle:'Search history',histWeekTitle:'Prices by weekday (avg)',
    histTimeTitle:'Price over time',histClear:'Clear history',
    weekdays:['Mon','Tue','Wed','Thu','Fri','Sat','Sun'],
    cheapestDay:'Cheapest day',
    disc:'Saving = (ref−price)×litres − detour fuel. Prices older than 3d filtered. Verify price at pump. Served from same Node.js process — no proxy required. © Matti Kuokkanen, mkuokkanen@gmail.com',
  },
};

let lang = 'fi';
function T(k){ return (LANGS[lang]||LANGS.fi)[k] || k; }

function setLang(l) {
  lang = l;
  ['fi','sv','en'].forEach(x=>{document.getElementById('btn-'+x).className='iconbtn'+(x===l?' active':'');});
  const set=(id,v)=>{const e=document.getElementById(id);if(e)e.textContent=v;};
  const ph=(id,v)=>{const e=document.getElementById(id);if(e)e.placeholder=v;};
  const opt=(id,v,t)=>{const s=document.getElementById(id);if(!s)return;const o=[...s.options].find(x=>x.value===v);if(o)o.textContent=t;};
  document.getElementById('t-tagline').textContent=T('tagline');
  set('t-src-panel',T('srcPanel'));set('t-view-lbl',T('viewLbl'));set('t-fuel-lbl',T('fuelLbl'));
  set('t-region-lbl',T('regionLbl'));set('t-city-lbl',T('cityLbl'));
  set('t-vehicle-panel',T('vehiclePanel'));set('t-tank-lbl',T('tankLbl'));
  set('t-curfuel-lbl',T('curFuelLbl'));set('t-fillto-lbl',T('fillToLbl'));
  set('t-route-panel',T('routePanel'));set('t-start-lbl',T('startLbl'));set('t-start-hint',T('startHint'));
  set('t-dest-lbl',T('destLbl'));set('t-detour-lbl',T('detourLbl'));set('t-corr-lbl',T('corrLbl'));set('t-gmap-lbl',T('gmapLbl'));
  set('t-find-btn',T('findBtn'));set('t-gps-btn',T('gpsBtn'));set('t-prices-btn',T('pricesBtn'));
  set('t-log-panel',T('logPanel'));set('t-map-hint',T('mapHint'));set('t-disc',T('disc'));
  set('tab-search',T('tabSearch'));set('tab-history',T('tabHistory'));
  opt('viewType','region',T('optRegion'));opt('viewType','city',T('optCity'));opt('viewType','cheapest',T('optCheapest'));
  ph('startAddr',T('startPh'));ph('dest',T('destPh'));
  syncR();
  renderHistory();
}

// ═══════════════════════════════════════════════════
// THEME & SIZE
// ═══════════════════════════════════════════════════
function toggleTheme() {
  const html = document.documentElement;
  const isDark = html.dataset.theme === 'dark';
  html.dataset.theme = isDark ? 'light' : 'dark';
  document.getElementById('btn-theme').textContent = isDark ? '🌙' : '☀';
  try { localStorage.setItem('kp_theme', html.dataset.theme); } catch(e){}
}
function setSize(s) {
  document.documentElement.dataset.size = s;
  ['s','n','l'].forEach(x=>document.getElementById('sz-'+x).className='iconbtn'+(x[0]===s[0]?' active':''));
  try { localStorage.setItem('kp_size', s); } catch(e){}
}

// ═══════════════════════════════════════════════════
// TABS
// ═══════════════════════════════════════════════════
function showTab(tab) {
  document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
  document.querySelectorAll('.tabpanel').forEach(p=>p.classList.remove('active'));
  document.getElementById('tab-'+tab).classList.add('active');
  document.getElementById('panel-'+tab).classList.add('active');
  if (tab === 'history') renderHistory();
}

// ═══════════════════════════════════════════════════
// LOG
// ═══════════════════════════════════════════════════
function log(msg, cls='') {
  const b=document.getElementById('log');
  const d=document.createElement('div');
  if(cls) d.className=cls;
  d.textContent='['+new Date().toTimeString().slice(0,8)+'] '+msg;
  b.appendChild(d); b.scrollTop=99999;
}

// ═══════════════════════════════════════════════════
// UI HELPERS
// ═══════════════════════════════════════════════════
function pill(id,t,c=''){const e=document.getElementById(id);e.textContent=t;e.className='pill'+(c?' '+c:'');}
function loader(on,t=''){const e=document.getElementById('ldr');e.className=on?'on':'';if(t)document.getElementById('ltxt').textContent=t;}
function onViewChange(){
  const v=document.getElementById('viewType').value;
  document.getElementById('regionRow').style.display=v==='region'?'':'none';
  document.getElementById('cityRow').style.display=v==='city'?'':'none';
}
function syncR(){
  const sz=+document.getElementById('tankSize').value||55;
  const lv=+document.getElementById('lvl').value;
  const ft=+document.getElementById('fillTo').value;
  const curL=sz*lv/100, addL=sz*(ft-lv)/100;
  document.getElementById('lvlLbl').textContent=lv+'% · '+curL.toFixed(0)+'L';
  document.getElementById('lvlV').textContent=curL.toFixed(0)+'L';
  document.getElementById('fillLbl').textContent=ft+'% · +'+Math.max(0,addL).toFixed(0)+'L';
  document.getElementById('fillV').textContent=Math.max(0,addL).toFixed(0)+'L';
}
document.getElementById('tankSize').addEventListener('input',syncR);

// ═══════════════════════════════════════════════════
// GPS
// ═══════════════════════════════════════════════════
function gps(manual=false){
  pill('pLoc','GPS…','');
  return new Promise(res=>{
    if(!navigator.geolocation){res(fallback());return;}
    navigator.geolocation.getCurrentPosition(
      p=>{ST.loc={lat:p.coords.latitude,lng:p.coords.longitude};
        pill('pLoc','GPS ±'+Math.round(p.coords.accuracy)+'m','live');
        log('Sijainti: '+ST.loc.lat.toFixed(4)+', '+ST.loc.lng.toFixed(4),'ok');
        res(ST.loc);},
      e=>{log('GPS: '+e.message+' — käytetään Helsinkiä','w');res(fallback());},
      {enableHighAccuracy:true,timeout:8000}
    );
  });
}
function fallback(){ST.loc={lat:60.1699,lng:24.9384};pill('pLoc','GPS fallback','warn');return ST.loc;}

// ═══════════════════════════════════════════════════
// GEOCODE
// ═══════════════════════════════════════════════════
async function geocode(text){
  if(!text.trim()) return null;
  const key=document.getElementById('gmapKey').value.trim();
  if(key){
    try{
      const r=await fetch('https://maps.googleapis.com/maps/api/geocode/json?address='+encodeURIComponent(text+',Finland')+'&key='+key);
      const d=await r.json();
      if(d.results?.[0]){const l=d.results[0].geometry.location;log('Kohde: '+d.results[0].formatted_address.split(',').slice(0,2).join(','),'ok');return{lat:l.lat,lng:l.lng};}
    }catch(e){}
  }
  try{
    const r=await fetch('https://nominatim.openstreetmap.org/search?q='+encodeURIComponent(text+',Finland')+'&format=json&limit=1',{headers:{'Accept-Language':lang}});
    const d=await r.json();
    if(d[0]){log('Kohde: '+d[0].display_name.split(',').slice(0,2).join(','),'ok');return{lat:+d[0].lat,lng:+d[0].lon};}
  }catch(e){}
  log('Kohteen geokoodaus epäonnistui','w');
  return null;
}

// ═══════════════════════════════════════════════════
// LOAD PRICES
// ═══════════════════════════════════════════════════
async function loadPrices(manual=false){
  const view=document.getElementById('viewType').value;
  const reg=document.getElementById('regionVal').value;
  const city=document.getElementById('cityVal').value;
  let url='/api/prices?';
  if(view==='region') url+='region='+encodeURIComponent(reg);
  else if(view==='city') url+='city='+encodeURIComponent(city);
  else url+='cmd=20halvinta';
  log(T('fetching'));
  loader(true,T('fetching'));
  try{
    const r=await fetch(url);
    const d=await r.json();
    if(!d.ok) throw new Error(d.error||'server error');
    ST.stations=d.stations; ST.fetchedAt=d.fetchedAt;
    pill('pPrices',d.count+' '+T('stUnit').toLowerCase(),'live');
    document.getElementById('dataLine').textContent='polttoaine.net · '+d.count+' as. · '+new Date(d.fetchedAt).toLocaleTimeString('fi-FI');
    if(d.averages) log('Ka: 95='+d.averages.p95+' 98='+d.averages.p98+' Di='+d.averages.diesel);
    log(d.count+' asemaa ladattu','ok');
    return d.stations;
  }catch(e){log('Haku epäonnistui: '+e.message,'e');pill('pPrices','ERROR','err');return[];}
  finally{loader(false);}
}

// ═══════════════════════════════════════════════════
// MATHS
// ═══════════════════════════════════════════════════
function hav(a,b,c,d){
  const R=6371,dl=(c-a)*Math.PI/180,dg=(d-b)*Math.PI/180;
  const x=Math.sin(dl/2)**2+Math.cos(a*Math.PI/180)*Math.cos(c*Math.PI/180)*Math.sin(dg/2)**2;
  return R*2*Math.atan2(Math.sqrt(x),Math.sqrt(1-x));
}
function roadEst(sl){return sl*(sl<5?1.45:sl<15?1.35:1.22);}
function ptSeg(px,py,ax,ay,bx,by){
  const dx=bx-ax,dy=by-ay,l2=dx*dx+dy*dy;
  if(!l2)return hav(py,px,ay,ax);
  const t=Math.max(0,Math.min(1,((px-ax)*dx+(py-ay)*dy)/l2));
  return hav(py,px,ay+t*dy,ax+t*dx);
}
async function googleDist(origin,stations,key){
  if(!key||!stations.length)return null;
  try{
    const dests=stations.map(s=>s.lat+','+s.lng).join('|');
    const r=await fetch('https://maps.googleapis.com/maps/api/distancematrix/json?origins='+origin.lat+','+origin.lng+'&destinations='+encodeURIComponent(dests)+'&mode=driving&key='+key);
    const d=await r.json();
    if(d.status==='OK'&&d.rows[0])return d.rows[0].elements.map(e=>e.status==='OK'?e.distance.value/1000:null);
  }catch(e){log('Google dist matrix epäonnistui','w');}
  return null;
}

// ═══════════════════════════════════════════════════
// UPDATED AGE
// ═══════════════════════════════════════════════════
function updAge(s,fuelKey){
  const str=s.updated?.[fuelKey]||'';
  if(!str)return'—';
  const h=(Date.now()-new Date(str.replace(' ','T')).getTime())/3600000;
  if(isNaN(h))return str;
  if(h<1)return lang==='sv'?'just nu':lang==='en'?'just now':'juuri nyt';
  if(h<24)return Math.round(h)+(lang==='en'?'h ago':lang==='sv'?'h sedan':'h sitten');
  return Math.round(h/24)+(lang==='en'?'d ago':lang==='sv'?'d sedan':'pv sitten');
}
function updColor(s,fuelKey){
  const str=s.updated?.[fuelKey]||'';
  if(!str)return'var(--mut)';
  const h=(Date.now()-new Date(str.replace(' ','T')).getTime())/3600000;
  return h<24?'var(--good)':h<48?'var(--warn)':'var(--bad)';
}

// ═══════════════════════════════════════════════════
// MAIN OPTIMIZER
// ═══════════════════════════════════════════════════
async function run(){
  log('═══ '+T('findBtn')+' ═══','ok');
  const startTxt=document.getElementById('startAddr').value.trim();
  if(startTxt){
    loader(true,T('geocoding'));
    const gc=await geocode(startTxt);
    if(gc){ST.loc=gc;pill('pLoc','MANUAL','warn');log('Lähtö: '+startTxt,'ok');}
    else{log('Geokoodaus epäonnistui, käytetään GPS:ää','w');if(!ST.loc)await gps();}
  }else{
    loader(true,T('gpsGetting'));
    if(!ST.loc)await gps();
  }
  loader(true,T('geocoding'));
  const destTxt=document.getElementById('dest').value.trim();
  ST.dest=destTxt?await geocode(destTxt):null;
  if(!ST.stations.length)await loadPrices();
  if(!ST.stations.length){loader(false);log(T('noData'),'e');return;}

  const fuelKey=document.getElementById('fuelType').value;
  const tankSz=+document.getElementById('tankSize').value;
  const cons=+document.getElementById('cons').value;
  const lvlPct=+document.getElementById('lvl').value;
  const fillPct=+document.getElementById('fillTo').value;
  const apiKey=document.getElementById('gmapKey').value.trim();
  const curL=tankSz*lvlPct/100;
  const fillL=Math.max(0,tankSz*(fillPct-lvlPct)/100);
  const range=curL/cons*100;
  log('Tankki: '+curL.toFixed(0)+'L, toimintamatka: '+range.toFixed(0)+'km, lisätään: '+fillL.toFixed(0)+'L');

  let pool=ST.stations.filter(s=>{
    if(s[fuelKey]==null)return false;
    if(hav(ST.loc.lat,ST.loc.lng,s.lat,s.lng)>range*0.88)return false;
    if(ST.dest){const corrKm=+document.getElementById('corr').value;if(ptSeg(s.lng,s.lat,ST.loc.lng,ST.loc.lat,ST.dest.lng,ST.dest.lat)>corrKm)return false;}
    return true;
  });
  if(!pool.length&&ST.dest){log('Ei asemia käytävässä — käytetään sädettä','w');pool=ST.stations.filter(s=>s[fuelKey]!=null&&hav(ST.loc.lat,ST.loc.lng,s.lat,s.lng)<range*0.88);}
  log(pool.length+' asemaa suodattimien läpi');
  if(!pool.length){loader(false);log(T('noStations'),'e');return;}

  loader(true,T('calcDist'));
  const rdists=apiKey?await googleDist(ST.loc,pool,apiKey):null;

  const prices=pool.map(s=>s[fuelKey]).filter(Boolean);
  const refP=Math.max(...prices);
  const fuelKmCost=cons/100;

  const scored=pool.map((s,i)=>{
    const sl=hav(ST.loc.lat,ST.loc.lng,s.lat,s.lng);
    const detour=rdists?.[i]??roadEst(sl);
    const price=s[fuelKey];
    const extra=ST.dest?Math.max(0,detour-hav(ST.dest.lat,ST.dest.lng,s.lat,s.lng)):detour;
    const gross=(refP-price)*fillL;
    const dCost=extra*fuelKmCost*refP;
    const net=gross-dCost;
    const tankCost=price*fillL;           // actual cost to fill up here
    const totalCost=tankCost+dCost;       // fill + drive there
    return{...s,price,sl,detour,extra,gross,dCost,net,tankCost,totalCost,distSrc:rdists?.[i]?'Maps':'est.'};
  }).sort((a,b)=>b.net-a.net);

  loader(false);
  log('Paras: '+scored[0].brand+' '+scored[0].city+' @ '+scored[0].price+' €/L — netto '+(scored[0].net>=0?'+':'')+scored[0].net.toFixed(2)+'€','ok');

  // Save to history
  const fl={p95:'95E10',p98:'98E5',diesel:'Diesel'}[fuelKey];
  histAdd({
    ts: Date.now(),
    fuel: fl,
    region: document.getElementById('viewType').value==='region'?document.getElementById('regionVal').value:'',
    min: scored[scored.length-1].price,
    max: scored[0].price,
    avg: +(scored.reduce((a,s)=>a+s.price,0)/scored.length).toFixed(3),
    count: scored.length,
  });

  renderResults(scored,{fillL,range,fuelKey,refP});
  drawMap(ST.loc,ST.dest,scored);
}

// ═══════════════════════════════════════════════════
// RENDER RESULTS
// ═══════════════════════════════════════════════════
function renderResults(stations,{fillL,range,fuelKey}){
  document.getElementById('res').style.display='block';
  const fl={p95:'95E10',p98:'98E5',diesel:'Diesel'}[fuelKey];
  const best=stations[0],avg=stations.reduce((a,s)=>a+s.price,0)/stations.length;
  document.getElementById('rTitle').textContent=stations.length+' '+T('stUnit');
  document.getElementById('rSub').textContent=T('filling')+' '+fillL.toFixed(0)+'L '+fl+' · '+T('rangeWord')+' '+range.toFixed(0)+'km';
  document.getElementById('stats').innerHTML=
    sbox(T('optimalLbl'),best.price.toFixed(3),'€/L · '+best.brand)+
    sbox(T('avgLbl'),avg.toFixed(3),'€/L · '+stations.length+' as.')+
    sbox(T('savingLbl'),(best.net>=0?'+':'')+best.net.toFixed(2),T('afterDetour'),best.net>0?'var(--good)':best.net<0?'var(--bad)':'var(--mut)');

  const list=document.getElementById('cards');list.innerHTML='';
  const N=Math.min(stations.length,12);
  for(let i=0;i<N;i++){
    const s=stations[i];
    const cls=i===0?'best':s.net<0?'lose':s.net<0.3?'marg':'';
    const badge=i===0?bk(T('badgeOptimal'),'g'):s.net<0?bk(T('badgeBad'),'r'):s.net<0.3?bk(T('badgeMarg'),'y'):bk(T('badgeGood'),'g');
    const isTop = i < 3;
    list.innerHTML+=\`<div class="card \${cls}" onclick="nav(\${s.lat},\${s.lng})">
      <div class="rank">#\${i+1}</div>
      <div>
        <div class="cn">\${s.brand}\${badge} <span style="color:var(--m2);font-size:.8em;font-weight:300">\${s.city||''}</span></div>
        <div style="font-size:.73em;color:var(--m2);margin-bottom:2px">\${(s.name||'').slice(0,55)}</div>
        <div class="cm">
          <span>· \${s.sl.toFixed(1)} \${T('crowKm')}</span>
          <span>· \${s.detour.toFixed(1)} \${T('roadKm')} (\${s.distSrc})</span>
          <span style="color:\${updColor(s,fuelKey)}">· \${updAge(s,fuelKey)}</span>
        </div>
        \${isTop?\`<div class="cost-grid">
          <div class="cost-box">
            <div class="cost-lbl">\${T('tankCostLbl')}</div>
            <div class="cost-val" style="color:var(--acc)">\${s.tankCost.toFixed(2)}€</div>
          </div>
          <div class="cost-box">
            <div class="cost-lbl">\${T('detourCostLbl')}</div>
            <div class="cost-val" style="color:var(--warn)">\${s.dCost.toFixed(2)}€</div>
          </div>
          <div class="cost-box" style="grid-column:1/-1;background:color-mix(in srgb,var(--acc) 8%,transparent);border-color:color-mix(in srgb,var(--acc) 30%,transparent)">
            <div class="cost-lbl">\${T('totalCostLbl')}</div>
            <div class="cost-val" style="color:var(--acc)">\${s.totalCost.toFixed(2)}€</div>
          </div>
          <div class="cost-box" style="grid-column:1/-1">
            <div class="cost-lbl">\${T('netSavingLbl')} vs. alueen kallein</div>
            <div class="cost-val" style="color:\${s.net>0?'var(--good)':s.net<0?'var(--bad)':'var(--mut)'}">\${s.net>=0?'+':''}\${s.net.toFixed(2)}€</div>
          </div>
        </div>\`:\`<div class="brkd">\${T('fillWord')} \${fillL.toFixed(0)}L · \${T('tankCostLbl')} \${s.tankCost.toFixed(2)}€ · \${T('totalCostLbl')} \${s.totalCost.toFixed(2)}€ · \${T('net')} \${s.net>=0?'+':''}\${s.net.toFixed(2)}€</div>\`}
      </div>
      <div>
        <div class="cp" style="color:\${i===0?'var(--acc)':'var(--txt)'}">\${s.price.toFixed(3)}<span class="cu">€/L</span></div>
        <div class="csav \${s.net>0.1?'pos':s.net<-0.1?'neg':'neu'}">\${T('net')} \${s.net>=0?'+':''}\${s.net.toFixed(2)}€</div>
      </div>
    </div>\`;
  }
  if(stations.length>N)list.innerHTML+='<div style="text-align:center;font-family:DM Mono,monospace;font-size:.67em;color:var(--mut);padding:10px">+'+(stations.length-N)+' muuta</div>';
}
function sbox(lbl,val,unit,color){return'<div class="sb"><div class="sl">'+lbl+'</div><div class="sv"'+(color?' style="color:'+color+'"':'')+'>'+val+'</div><div class="su">'+unit+'</div></div>';}
function bk(t,c){return'<span class="bk '+c+'">'+t+'</span>';}
function nav(lat,lng){window.open('https://www.google.com/maps/dir/?api=1&destination='+lat+','+lng,'_blank');}

// ═══════════════════════════════════════════════════
// MAP
// ═══════════════════════════════════════════════════
function drawMap(origin,dest,stations){
  const wrap=document.getElementById('mapwrap'),c=document.getElementById('mc');
  document.getElementById('mhint').style.display='none';
  c.width=wrap.offsetWidth;c.height=240;
  const ctx=c.getContext('2d');
  const isDark=document.documentElement.dataset.theme!=='light';
  const pts=[origin,...stations.slice(0,12).map(s=>({lat:s.lat,lng:s.lng}))];
  if(dest)pts.push(dest);
  const lats=pts.map(p=>p.lat),lngs=pts.map(p=>p.lng);
  const mnLa=Math.min(...lats)-.003,mxLa=Math.max(...lats)+.003;
  const mnLn=Math.min(...lngs)-.004,mxLn=Math.max(...lngs)+.004;
  const pad=26;
  function xy(la,ln){return[pad+(ln-mnLn)/(mxLn-mnLn)*(c.width-pad*2),pad+(mxLa-la)/(mxLa-mnLa)*(c.height-pad*2)];}
  ctx.fillStyle=isDark?'#141714':'#f0f1ee';ctx.fillRect(0,0,c.width,c.height);
  ctx.strokeStyle=isDark?'rgba(184,245,66,.025)':'rgba(0,0,0,.05)';ctx.lineWidth=1;
  for(let x=0;x<c.width;x+=36){ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,c.height);ctx.stroke();}
  for(let y=0;y<c.height;y+=36){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(c.width,y);ctx.stroke();}
  if(dest){
    const[ox,oy]=xy(origin.lat,origin.lng),[dx,dy]=xy(dest.lat,dest.lng);
    ctx.strokeStyle=isDark?'rgba(184,245,66,.2)':'rgba(58,125,0,.3)';ctx.lineWidth=2;ctx.setLineDash([5,4]);
    ctx.beginPath();ctx.moveTo(ox,oy);ctx.lineTo(dx,dy);ctx.stroke();ctx.setLineDash([]);
    ctx.fillStyle=isDark?'rgba(245,200,66,.15)':'rgba(138,92,0,.1)';ctx.beginPath();ctx.arc(dx,dy,11,0,Math.PI*2);ctx.fill();
    ctx.strokeStyle='#f5c842';ctx.lineWidth=2;ctx.beginPath();ctx.arc(dx,dy,6,0,Math.PI*2);ctx.stroke();
  }
  const goodC=isDark?'#b8f542':'#3a7d00', warnC='#f5c842', badC='#f54242', dimC=isDark?'#4a8a4a':'#5a9a5a';
  for(let i=Math.min(stations.length,12)-1;i>=0;i--){
    const s=stations[i],[x,y]=xy(s.lat,s.lng);
    const col=i===0?goodC:s.net<0?badC:s.net<0.3?warnC:dimC;
    const r=i===0?7:4;
    ctx.fillStyle=col+'33';ctx.beginPath();ctx.arc(x,y,r*2.5,0,Math.PI*2);ctx.fill();
    ctx.fillStyle=col;ctx.beginPath();ctx.arc(x,y,r,0,Math.PI*2);ctx.fill();
    if(i===0){ctx.fillStyle=isDark?'#0a0c0a':'#fff';ctx.font='bold 8px DM Mono,monospace';ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText('★',x,y);}
    if(i<6){ctx.fillStyle=col;ctx.font='9px DM Mono,monospace';ctx.textAlign='left';ctx.textBaseline='middle';ctx.fillText(s.price.toFixed(3),x+r+3,y);}
  }
  const[ox,oy]=xy(origin.lat,origin.lng);
  ctx.fillStyle='rgba(245,200,66,.15)';ctx.beginPath();ctx.arc(ox,oy,16,0,Math.PI*2);ctx.fill();
  ctx.strokeStyle='#f5c842';ctx.lineWidth=2;ctx.beginPath();ctx.arc(ox,oy,7,0,Math.PI*2);ctx.stroke();
  ctx.fillStyle='#f5c842';ctx.beginPath();ctx.arc(ox,oy,3,0,Math.PI*2);ctx.fill();
  ctx.font='9px DM Mono,monospace';ctx.fillStyle=isDark?'#4a504a':'#888';ctx.textAlign='left';
  ctx.fillText('● '+T('tabSearch').toUpperCase()+'  ★ PARAS  ● HYVÄ  ● MARGINAALINEN  ● EI KANNATA',10,c.height-8);
}

// ═══════════════════════════════════════════════════
// HISTORY
// ═══════════════════════════════════════════════════
let chartInstance = null;

function renderHistory(){
  const hist = histLoad();
  const cont = document.getElementById('hist-content');
  if(!hist.length){
    cont.innerHTML='<div class="hist-empty">'+T('histEmpty')+'</div>';
    return;
  }

  // ── Price over time chart ──
  const p95entries = hist.filter(h=>h.fuel==='95E10');
  const p98entries = hist.filter(h=>h.fuel==='98E5');
  const diEntries  = hist.filter(h=>h.fuel==='Diesel');

  const fmt = ts => {
    const d=new Date(ts);
    return d.toLocaleDateString('fi-FI',{month:'short',day:'numeric'})+' '+d.toLocaleTimeString('fi-FI',{hour:'2-digit',minute:'2-digit'});
  };

  // Auto-scale: show all time if <7 entries, else last 30 days
  const timeSpanMs = hist.length>1 ? hist[hist.length-1].ts - hist[0].ts : 0;
  const scaleLabel = timeSpanMs < 7*24*3600000 ? 'kaikki haut' :
                     timeSpanMs < 30*24*3600000 ? 'viimeinen kk' : 'koko historia';

  const isDark = document.documentElement.dataset.theme !== 'light';
  const gridColor = isDark ? 'rgba(255,255,255,.07)' : 'rgba(0,0,0,.08)';
  const textColor = isDark ? '#666d66' : '#666';

  // ── Weekday analysis ──
  const wdData = {}; // {0:Mon: [prices]}
  hist.forEach(h=>{
    const d=new Date(h.ts);
    const wd=(d.getDay()+6)%7; // 0=Mon
    if(!wdData[wd]) wdData[wd]=[];
    wdData[wd].push(h.avg);
  });
  const wdAvg = Array.from({length:7},(_,i)=>{
    const arr=wdData[i]||[];
    return arr.length ? +(arr.reduce((a,b)=>a+b,0)/arr.length).toFixed(3) : null;
  });
  const validAvgs = wdAvg.filter(Boolean);
  const minWdAvg = validAvgs.length ? Math.min(...validAvgs) : null;

  const wdHTML = T('weekdays').map((name,i)=>{
    const val=wdAvg[i];
    const isCheapest = val && val===minWdAvg;
    return \`<div class="wd-box \${isCheapest?'cheapest':''}">
      <div class="wd-name">\${name}</div>
      <div class="wd-price">\${val?val.toFixed(3):'—'}</div>
      <div class="wd-count">\${(wdData[i]||[]).length} hakua</div>
    </div>\`;
  }).join('');

  // ── History rows ──
  const rowsHTML = [...hist].reverse().slice(0,20).map((h,i)=>\`
    <div class="hist-row">
      <span class="hist-time">\${fmt(h.ts)}</span>
      <span class="hist-fuel">\${h.fuel}</span>
      <span class="hist-prices">ka. <strong>\${h.avg}</strong> · min \${h.min} · max \${h.max} · \${h.count} as.</span>
      <span class="hist-del" onclick="histDelete(\${hist.length-1-i})">✕</span>
    </div>
  \`).join('');

  cont.innerHTML = \`
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;flex-wrap:wrap;gap:8px">
      <div style="font-family:'Bebas Neue',sans-serif;font-size:1.8em;color:var(--txt)">\${T('histTitle')}</div>
      <button class="btn sec" style="width:auto;padding:6px 14px" onclick="histClear()">\${T('histClear')}</button>
    </div>

    <div class="chart-wrap">
      <div class="chart-title">\${T('histTimeTitle')} — \${scaleLabel}</div>
      <canvas id="chartTime"></canvas>
    </div>

    <div class="chart-wrap">
      <div class="chart-title">\${T('histWeekTitle')}</div>
      <div class="weekday-grid">\${wdHTML}</div>
    </div>

    <div class="chart-wrap">
      <div class="chart-title">\${T('histTitle')}</div>
      \${rowsHTML}
    </div>
  \`;

  // Draw time chart
  if(chartInstance){ chartInstance.destroy(); chartInstance=null; }
  const ctx2 = document.getElementById('chartTime')?.getContext('2d');
  if(!ctx2) return;

  const datasets=[];
  if(p95entries.length>1) datasets.push({label:'95E10',data:p95entries.map(h=>({x:h.ts,y:h.avg})),borderColor:'#b8f542',backgroundColor:'rgba(184,245,66,.1)',tension:.3,pointRadius:4,borderWidth:2});
  if(p98entries.length>1) datasets.push({label:'98E5',data:p98entries.map(h=>({x:h.ts,y:h.avg})),borderColor:'#f5c842',backgroundColor:'rgba(245,200,66,.1)',tension:.3,pointRadius:4,borderWidth:2});
  if(diEntries.length>1)  datasets.push({label:'Diesel',data:diEntries.map(h=>({x:h.ts,y:h.avg})),borderColor:'#6ab0f5',backgroundColor:'rgba(106,176,245,.1)',tension:.3,pointRadius:4,borderWidth:2});

  if(!datasets.length){
    ctx2.canvas.parentElement.innerHTML+='<div style="text-align:center;padding:20px;font-family:DM Mono,monospace;font-size:.8em;color:var(--mut)">Vähintään 2 hakua tarvitaan graafiin.</div>';
    return;
  }

  chartInstance = new Chart(ctx2,{
    type:'line',
    data:{datasets},
    options:{
      responsive:true,
      plugins:{legend:{labels:{color:textColor,font:{family:'DM Mono, monospace',size:11}}}},
      scales:{
        x:{type:'linear',ticks:{color:textColor,font:{family:'DM Mono, monospace',size:10},callback:v=>fmt(v)},grid:{color:gridColor}},
        y:{ticks:{color:textColor,font:{family:'DM Mono, monospace',size:10},callback:v=>v.toFixed(3)+'€'},grid:{color:gridColor}},
      },
    },
  });
}

function histDelete(idx){
  const arr=histLoad();
  arr.splice(idx,1);
  histSave(arr);
  renderHistory();
}
function histClear(){
  if(confirm(lang==='fi'?'Tyhjennetäänkö koko historia?':lang==='sv'?'Rensa all historik?':'Clear all history?')){
    try{localStorage.removeItem(HIST_KEY);}catch(e){}
    renderHistory();
  }
}

// ═══════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════
window.addEventListener('load',()=>{
  // Restore saved preferences
  try{
    const th=localStorage.getItem('kp_theme');
    if(th){document.documentElement.dataset.theme=th;document.getElementById('btn-theme').textContent=th==='light'?'🌙':'☀';}
    const sz=localStorage.getItem('kp_size');
    if(sz)setSize(sz);
  }catch(e){}
  setLang('fi');
  syncR();
  gps();
  loadPrices();
});
</script>
</body>
</html>`;
