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
    'Accept-Encoding': 'gzip, deflate',
    'Cookie': [
      'cmplz_consent_status=optin',
      'cmplz_marketing=optin',
      'cmplz_statistics=optin',
      'cmplz_functional=optin',
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

        // Handle gzip
        let stream = res;
        const ce = res.headers['content-encoding'];
        if (ce === 'gzip' || ce === 'deflate') {
          const zlib = require('zlib');
          stream = res.pipe(ce === 'gzip' ? zlib.createGunzip() : zlib.createInflate());
        }

        const chunks = [];
        stream.on('data', c => chunks.push(c));
        stream.on('end', () => {
          const buf = Buffer.concat(chunks);
          resolve(encoding === 'binary' ? buf : buf.toString(encoding));
        });
        stream.on('error', reject);
      });
      req.on('error', reject);
      req.setTimeout(60000, () => { req.destroy(new Error('timeout')); });
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
  // Autodetektoi enkoodaus: jos data on validi UTF-8, käytä sitä suoraan.
  // Muuten dekoodaa latin1/windows-1252.
  // Tämä estää double-enkoodauksen jos API palauttaakin UTF-8:n.
  try {
    const utf8 = buf.toString('utf8');
    // Tarkista onko dekoodaus onnistunut (ei replacement charactereja)
    if (!utf8.includes('�')) return utf8;
  } catch(e) {}
  // Fallback: latin1/windows-1252
  return buf.toString('latin1');
}

// ─── Scrapers ─────────────────────────────────────────────────────────────────

// ─── Region → cities mapping ──────────────────────────────────────────────────
const REGIONS = {
  'PK-Seutu':               ['Helsinki','Espoo','Vantaa','Kirkkonummi','Nurmijärvi','Järvenpää','Kerava','Tuusula','Hyvinkää','Mäntsälä'],
  'Turun_seutu':            ['Turku','Raisio','Kaarina','Naantali','Lieto','Salo','Uusikaupunki'],
  'Tampereen_seutu':        ['Tampere','Nokia','Pirkkala','Kangasala','Lempäälä','Ylöjärvi'],
  'Oulun_seutu':            ['Oulu','Kempele','Liminka','Muhos','Ii'],
  'Jyva_skyla_n_seutu':     ['Jyväskylä','Muurame','Laukaa'],
  'Porin_seutu':            ['Pori','Ulvila','Nakkila','Harjavalta'],
  'Seina_joen_seutu':       ['Seinäjoki','Lapua','Ilmajoki'],
  'Lappeenrannan_seutu':    ['Lappeenranta','Imatra','Joutseno','Taipalsaari','Lemi'],
  'Kuopion_seutu':          ['Kuopio','Siilinjärvi','Suonenjoki','Iisalmi'],
  'Joensuun_seutu':         ['Joensuu','Liperi','Kontiolahti','Outokumpu'],
  'Lahden_seutu':           ['Lahti','Heinola','Hollola','Nastola','Orimattila'],
  'Kouvolan_seutu':         ['Kouvola','Kotka','Hamina','Anjalankoski'],
  'Mikkelin_seutu':         ['Mikkeli','Savonlinna','Pieksämäki'],
  'Rovaniemen_seutu':       ['Rovaniemi','Kemi','Tornio','Kemijärvi'],
  'Vaasan_seutu':           ['Vaasa','Mustasaari','Laihia','Vähäkyrö'],
  'Hameenlinnan_seutu':     ['Hämeenlinna','Riihimäki','Forssa','Hattula'],
};

// ─── XML API scraper ──────────────────────────────────────────────────────────
// Single call to polttoaine.net/api/ fetches all ~350 stations with real lat/lng.
// Results are cached for 5 minutes to avoid hammering the API.
let xmlCache = null;
let xmlCacheTime = 0;
const CACHE_TTL = 30 * 60 * 1000; // 30 minuuttia — hinnat päivittyvät harvoin

function parseStations(xml) {
  const stations = [];
  const stationRe = /<station>([\s\S]*?)<\/station>/g;
  let sm;
  while ((sm = stationRe.exec(xml)) !== null) {
    const block = sm[1];
    const tag = name => {
      const m = block.match(new RegExp(`<${name}>([^<]*)<\/${name}>`));
      if (!m) return '';
      // Pura HTML-entiteetit (API voi palauttaa &auml; &#228; jne.)
      return m[1].trim()
        .replace(/&auml;/g,'ä').replace(/&Auml;/g,'Ä')
        .replace(/&ouml;/g,'ö').replace(/&Ouml;/g,'Ö')
        .replace(/&aring;/g,'å').replace(/&Aring;/g,'Å')
        .replace(/&#228;/g,'ä').replace(/&#196;/g,'Ä')
        .replace(/&#246;/g,'ö').replace(/&#214;/g,'Ö')
        .replace(/&#229;/g,'å').replace(/&#197;/g,'Å')
        .replace(/&amp;/g,'&').replace(/&apos;/g,"'");
    };
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
      const updStr  = fb.match(/<date>([^<]*)<\/date>/)?.[1]?.trim() || '';
      const updTime = updStr ? new Date(updStr.replace(' ','T')).getTime() : 0;
      if (!type || isNaN(price) || price < 0.5 || price > 5) continue;
      if (!updTime || updTime < cutoff) continue;
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
  return stations;
}

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

  const stations = parseStations(xml);

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
  } else if (query.city) {
    const c = query.city.toLowerCase();
    stations = all.filter(s => s.city && s.city.toLowerCase() === c);
    console.log(`  City filter "${query.city}": ${stations.length} stations`);
  } else if (query.region) {
    const cities = REGIONS[query.region] || [];
    stations = cities.length ? all.filter(s => cities.includes(s.city)) : all;
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
      // Estä selaimen välimuisti — hinnat muuttuvat jatkuvasti
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      res.writeHead(200);
      const json = JSON.stringify({ ok: true, ...data });
      res.end(Buffer.from(json, 'utf8'));
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
#kp-logo-svg g{stroke:var(--acc);transition:stroke .2s}
[data-theme="dark"] #kp-logo-svg{filter:drop-shadow(0 0 4px var(--acc))}
[data-size="small"]  #kp-logo-svg{width:80px;height:44px}
[data-size="normal"] #kp-logo-svg{width:110px;height:60px}
[data-size="large"]  #kp-logo-svg{width:140px;height:76px}
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
.rank{font-family:'DM Mono',monospace;font-size:.67em;color:var(--mut);display:inline-block;margin-right:6px;vertical-align:middle}
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
.cost-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:0}
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
.cost-formula{font-family:'DM Mono',monospace;font-size:.6em;color:var(--m2);margin-top:3px;letter-spacing:.3px}
.card-best-highlight{border-color:var(--acc)!important;border-width:2px!important;
  box-shadow:0 0 0 1px color-mix(in srgb,var(--acc) 25%,transparent),0 4px 16px color-mix(in srgb,var(--acc) 12%,transparent)!important}
.card-best-highlight::before{background:var(--acc)!important;width:4px!important}
.disc{border-top:1px solid var(--b1);padding:10px 0;margin-top:4px;
  font-family:'DM Mono',monospace;font-size:.6em;color:var(--mut);line-height:1.9}
</style>
</head>
<body>
<div class="wrap">

<header>
  <div>
    <div style="display:flex;align-items:center;gap:12px">
      <div class="logo" id="logo-txt">KUOKKANEN PUMPULLA</div>
      <svg id="kp-logo-svg" width="110" height="60" viewBox="0 0 220 120" xmlns="http://www.w3.org/2000/svg">
      <g stroke-width="3.5" fill="none" stroke-linecap="round" stroke-linejoin="round">
        <path d="M20 90 L60 50 L50 100 Z"/>
        <line x1="55" y1="80" x2="150" y2="40"/>
        <rect x="140" y="30" width="25" height="20" rx="4"/>
        <path d="M165 35 Q190 30 200 40"/>
        <path d="M150 50 Q130 90 100 80"/>
        <path d="M205 45 Q210 55 200 55 Q195 55 205 45 Z"/>
      </g>
    </svg>
    </div>
    <div class="tagline">
      <p id="t-tagline">Tankkauksen kustannusoptimoija · Suomi</p>
      <p id="dataLine">Hintadata: polttoaine.net</p>
      <p style="color:var(--acc);opacity:.7;font-size:.85em;letter-spacing:.5px;margin-top:3px">säästö = (vertailuhinta − hinta) × litrat − kiertotiepolttoainekulu</p>
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

  <!-- PIKAHAKU -->
  <div class="panel" style="border-color:var(--acc);box-shadow:0 0 0 1px color-mix(in srgb,var(--acc) 20%,transparent)">
    <div class="ph" style="background:color-mix(in srgb,var(--acc) 8%,transparent)">
      <div class="dot"></div><h2 id="t-quick-panel" style="color:var(--acc)">Pikahaku</h2>
    </div>
    <div class="pb">
      <div class="f">
        <label id="t-fuel-lbl">Polttoainetyyppi</label>
        <select id="fuelType" style="font-size:1em;padding:10px">
          <option value="p95">⛽ 95E10</option>
          <option value="p98">⛽ 98E5</option>
          <option value="diesel">⛽ Diesel</option>
        </select>
      </div>
      <div class="f">
        <label><span id="t-curfuel-lbl">Polttoainetta nyt</span> — <span id="lvlLbl">10% · 6L</span></label>
        <div class="rrow">
          <input type="range" id="lvl" min="0" max="100" value="10" style="flex:1" oninput="syncR()">
          <div class="rv" id="lvlV">6L</div>
        </div>
      </div>
      <div class="f">
        <label><span id="t-start-lbl">Sijaintisi</span> <span style="color:var(--m2)" id="t-start-hint">(tyhjä = automaattinen GPS)</span></label>
        <div style="position:relative">
          <input type="text" id="startAddr" placeholder="esim. Mannerheimintie 1, Helsinki…"
            style="padding-right:32px">
          <button onclick="locateMe()" title="Hae GPS-sijainti"
            style="position:absolute;right:4px;top:50%;transform:translateY(-50%);
                   background:transparent;border:none;cursor:pointer;font-size:16px;
                   color:var(--acc);padding:2px 4px;line-height:1">⊕</button>
        </div>
        <div id="locStatus" style="font-family:'DM Mono',monospace;font-size:.67em;color:var(--m2);margin-top:3px;min-height:1.2em"></div>
      </div>
      <button class="btn pri" id="t-find-btn" onclick="run()" style="font-size:1em;padding:14px;margin-top:4px">⛽ ETSI OPTIMAALISIN ASEMA LÄHELTÄ</button>
    </div>
  </div>

  <!-- LISÄASETUKSET -->
  <div style="margin-bottom:12px">
    <button onclick="toggleAdv()" id="adv-btn"
      style="width:100%;background:transparent;border:1px solid var(--b1);border-radius:3px;
             padding:10px 16px;color:var(--mut);cursor:pointer;font-family:'DM Mono',monospace;
             font-size:.73em;letter-spacing:1px;text-align:left;display:flex;justify-content:space-between;align-items:center;transition:all .15s"
      onmouseover="this.style.borderColor='var(--acc)';this.style.color='var(--acc)'"
      onmouseout="this.style.borderColor='var(--b1)';this.style.color='var(--mut)'">
      <span id="t-adv-lbl">LISÄASETUKSET</span>
      <span id="adv-arrow">▼</span>
    </button>
  </div>

  <div id="adv-panel" style="display:none">

    <div class="panel">
      <div class="ph"><div class="dot"></div><h2 id="t-src-panel">Hakualue</h2></div>
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
            <label id="t-tank-lbl">Tankin koko (L)</label>
            <input type="number" id="tankSize" value="55" min="20" max="120">
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
            <option value="Lappeenrannan_seutu">Lappeenrannan seutu (+ Imatra)</option>
            <option value="Kuopion_seutu">Kuopion seutu</option>
            <option value="Joensuun_seutu">Joensuun seutu</option>
            <option value="Lahden_seutu">Lahden seutu</option>
            <option value="Kouvolan_seutu">Kouvolan seutu (+ Kotka)</option>
            <option value="Mikkelin_seutu">Mikkelin seutu</option>
            <option value="Rovaniemen_seutu">Rovaniemen seutu</option>
            <option value="Vaasan_seutu">Vaasan seutu</option>
            <option value="Hameenlinnan_seutu">Hämeenlinnan seutu</option>
          </select>
        </div>
        <div class="f" id="cityRow" style="display:none">
          <label id="t-city-lbl">Kaupunki</label>
          <select id="cityVal">
            <option value="Akaa">Akaa</option>
            <option value="Alajärvi">Alajärvi</option>
            <option value="Alavus">Alavus</option>
            <option value="Espoo">Espoo</option>
            <option value="Forssa">Forssa</option>
            <option value="Hanko">Hanko</option>
            <option value="Heinola">Heinola</option>
            <option value="Helsinki">Helsinki</option>
            <option value="Hämeenlinna">Hämeenlinna</option>
            <option value="Iisalmi">Iisalmi</option>
            <option value="Imatra">Imatra</option>
            <option value="Joensuu">Joensuu</option>
            <option value="Jyväskylä">Jyväskylä</option>
            <option value="Järvenpää">Järvenpää</option>
            <option value="Kajaani">Kajaani</option>
            <option value="Kangasala">Kangasala</option>
            <option value="Kemi">Kemi</option>
            <option value="Kirkkonummi">Kirkkonummi</option>
            <option value="Kokkola">Kokkola</option>
            <option value="Kotka">Kotka</option>
            <option value="Kouvola">Kouvola</option>
            <option value="Kuopio">Kuopio</option>
            <option value="Kuusamo">Kuusamo</option>
            <option value="Lahti">Lahti</option>
            <option value="Lappeenranta">Lappeenranta</option>
            <option value="Lempäälä">Lempäälä</option>
            <option value="Lohja">Lohja</option>
            <option value="Mikkeli">Mikkeli</option>
            <option value="Naantali">Naantali</option>
            <option value="Nokia">Nokia</option>
            <option value="Nurmijärvi">Nurmijärvi</option>
            <option value="Oulu">Oulu</option>
            <option value="Pori">Pori</option>
            <option value="Raasepori">Raasepori</option>
            <option value="Raisio">Raisio</option>
            <option value="Rauma">Rauma</option>
            <option value="Riihimäki">Riihimäki</option>
            <option value="Rovaniemi">Rovaniemi</option>
            <option value="Salo">Salo</option>
            <option value="Savonlinna">Savonlinna</option>
            <option value="Seinäjoki">Seinäjoki</option>
            <option value="Tampere">Tampere</option>
            <option value="Tornio">Tornio</option>
            <option value="Turku">Turku</option>
            <option value="Tuusula">Tuusula</option>
            <option value="Ulvila">Ulvila</option>
            <option value="Uusikaupunki">Uusikaupunki</option>
            <option value="Vaasa">Vaasa</option>
            <option value="Vantaa">Vantaa</option>
            <option value="Vihti">Vihti</option>
            <option value="Äänekoski">Äänekoski</option>
          </select>
        </div>
        <div class="f2">
          <div>
            <label>L/100km</label>
            <input type="number" id="cons" value="7.5" min="3" max="25" step="0.1">
          </div>
          <div>
            <label><span id="t-fillto-lbl">Täytä</span> — <span id="fillLbl">100% · +50L</span></label>
            <div class="rrow">
              <input type="range" id="fillTo" min="50" max="100" value="100" style="flex:1" oninput="syncR()">
              <div class="rv" id="fillV">50L</div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="panel">
      <div class="ph"><div class="dot y"></div><h2 id="t-route-panel">Reitti</h2></div>
      <div class="pb">
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
        <!-- Google Maps API -avain poistettu — käytetään ilmaista OSRM-reititystä -->
        <input type="hidden" id="gmapKey" value="">
      </div>
    </div>

    <div class="brow" style="margin-bottom:12px">
      <button class="btn sec" id="t-prices-btn" onclick="loadPrices(true)">↻ Päivitä hinnat</button>
    </div>

  </div><!-- /adv-panel -->

  <div class="panel">
    <div class="ph"><div class="dot y"></div><h2 id="t-log-panel">Loki</h2></div>
    <div class="pb" style="padding:8px">
      <div class="log" id="log"><span class="ok">Käynnistetty — avaa http://localhost:3001</span></div>
    </div>
  </div>

</div>
<div>
  <div id="mapwrap" style="cursor:grab;position:relative">
    <canvas id="mc" style="display:block;width:100%"></canvas>
    <div class="mhint" id="mhint">
      <div style="font-size:1.6em;opacity:.2">⛽</div>
      <div id="t-map-hint">Aja haku niin kartta ilmestyy</div>
    </div>
    <div style="position:absolute;top:8px;right:8px;display:flex;flex-direction:column;gap:3px;z-index:10">
      <button onclick="zoomMap(1)" style="width:28px;height:28px;background:rgba(255,255,255,.9);border:1px solid #ccc;border-radius:3px;cursor:pointer;font-size:16px;line-height:1;font-weight:bold;color:#333">+</button>
      <button onclick="zoomMap(-1)" style="width:28px;height:28px;background:rgba(255,255,255,.9);border:1px solid #ccc;border-radius:3px;cursor:pointer;font-size:16px;line-height:1;font-weight:bold;color:#333">−</button>
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

<div class="disc" id="t-disc"></div>
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
    logoTxt:'KUOKKANEN PUMPULLA',
    tagline:'Tankkauksen kustannusoptimoija',
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
    findBtn:'▶ ETSI OPTIMAALISIN ASEMA',gpsBtn:'⊕ GPS',pricesBtn:'↻ HINNAT',
    logPanel:'Loki',mapHint:'Aja haku niin kartta ilmestyy',
    loading:'Ladataan…',fetching:'Haetaan hintoja…',
    gpsGetting:'Haetaan sijaintia…',geocoding:'Geokoodataan…',calcDist:'Haetaan tieverkkoetäisyydet (OSRM)…',
    stUnit:'ASEMAA',filling:'tankataan',rangeWord:'ajoneuvon toimintasäde',
    quickPanel:'Pikahaku',advLbl:'LISÄASETUKSET',
    cheapestLbl:'Halvin hinta',
    optimalLbl:'Paras nettohinta',avgLbl:'Ka. alueella',savingLbl:'Max nettosäästö',
    afterDetour:'€ kiertotien jälkeen',
    totalCostLbl:'Kokonaiskulu',tankCostLbl:'Tankkauskulu',detourCostLbl:'Kiertotiepolttoainekulu',netSavingLbl:'Nettosäästö',
    badgeOptimal:'OPTIMAALISIN',badgeGood:'HYVÄ',badgeMarg:'MARGINAALINEN',badgeBad:'EI KANNATA',
    crowKm:'km linnuntietä',roadKm:'km tie',
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
    disc:'Säästö = (vertailuhinta−hinta)×litrat − kiertotiepolttoainekulu. Hinnat yli 3pv vanhat suodatetaan. Tarkista hinta pumpulta. Sivu toimii samasta Node.js-prosessista — ei proxyä. © Matti Kuokkanen, mkuokkanen@gmail.com',
  },
  sv:{
    logoTxt:'LITEN HACKA VID PUMPEN',
    tagline:'Bränslekostnadsoptimerare',
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
    findBtn:'▶ HITTA OPTIMALA STATION',gpsBtn:'⊕ GPS',pricesBtn:'↻ PRISER',
    logPanel:'Logg',mapHint:'Sök för att visa kartan',
    loading:'Laddar…',fetching:'Hämtar priser…',
    gpsGetting:'Hämtar plats…',geocoding:'Geokodning…',calcDist:'Hämtar vägavstånd (OSRM)…',
    stUnit:'STATIONER',filling:'tankar',rangeWord:'fordonets räckvidd',
    quickPanel:'Snabbsökning',advLbl:'AVANCERADE INSTÄLLNINGAR',
    cheapestLbl:'Billigaste pris',
    optimalLbl:'Bästa nettopris',avgLbl:'Snitt i omr.',savingLbl:'Max nettobesparing',
    afterDetour:'€ efter omväg',
    totalCostLbl:'Totalkostnad',tankCostLbl:'Tankningskostnad',detourCostLbl:'Omvägsbränsle',netSavingLbl:'Nettobesparing',
    badgeOptimal:'OPTIMAL',badgeGood:'BRA',badgeMarg:'MARGINELL',badgeBad:'LÖNAR SIG EJ',
    crowKm:'km fågelväg',roadKm:'km väg',
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
    logoTxt:'LITTLE MATTOCK AT THE PUMP',
    tagline:'Fuel cost optimizer',
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
    gpsGetting:'Getting location…',geocoding:'Geocoding…',calcDist:'Fetching road distances (OSRM)…',
    stUnit:'STATIONS',filling:'filling',rangeWord:'vehicle range',
    quickPanel:'Quick Search',advLbl:'ADVANCED SETTINGS',
    cheapestLbl:'Cheapest price',
    optimalLbl:'Best net price',avgLbl:'Avg in range',savingLbl:'Max net saving',
    afterDetour:'€ after detour',
    totalCostLbl:'Total cost',tankCostLbl:'Fuel cost',detourCostLbl:'Detour fuel cost',netSavingLbl:'Net saving',
    badgeOptimal:'OPTIMAL',badgeGood:'GOOD',badgeMarg:'MARGINAL',badgeBad:'NOT WORTH IT',
    crowKm:'km as the crow flies',roadKm:'km road',
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
  document.getElementById('logo-txt').textContent=T('logoTxt');
  set('t-quick-panel',T('quickPanel'));
  set('t-adv-lbl',    T('advLbl'));
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
function toggleAdv() {
  const p = document.getElementById('adv-panel');
  const arr = document.getElementById('adv-arrow');
  const open = p.style.display === 'none';
  p.style.display = open ? 'block' : 'none';
  arr.textContent = open ? '▲' : '▼';
  try { localStorage.setItem('kp_adv', open ? '1' : '0'); } catch(e){}
}

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
document.getElementById('fuelType').addEventListener('change',()=>{try{localStorage.setItem('kp_fuel',document.getElementById('fuelType').value);}catch(e){}});
document.getElementById('tankSize').addEventListener('change',()=>{try{localStorage.setItem('kp_tank',document.getElementById('tankSize').value);}catch(e){}});
document.getElementById('cons').addEventListener('change',()=>{try{localStorage.setItem('kp_cons',document.getElementById('cons').value);}catch(e){}});

// ═══════════════════════════════════════════════════
// GPS
// ═══════════════════════════════════════════════════
async function reverseGeocode(lat, lng) {
  try {
    const ctrl = new AbortController();
    const tid = setTimeout(()=>ctrl.abort(), 5000);
    const r = await fetch(
      'https://nominatim.openstreetmap.org/reverse?lat='+lat+'&lon='+lng+'&format=json&accept-language=fi',
      {headers:{'Accept-Language':'fi','User-Agent':'KuokkanenPumpulla/1.0'}, signal:ctrl.signal}
    );
    clearTimeout(tid);
    const d = await r.json();
    if(d?.address) {
      const a = d.address;
      // Build a short readable address
      const street = a.road || a.pedestrian || a.footway || '';
      const num = a.house_number || '';
      const city = a.city || a.town || a.village || a.municipality || '';
      return [street + (num?' '+num:''), city].filter(Boolean).join(', ');
    }
  } catch(e){}
  return null;
}

function setLocStatus(txt, color) {
  const el = document.getElementById('locStatus');
  if(el) { el.textContent = txt; el.style.color = color || 'var(--m2)'; }
}

async function locateMe() {
  setLocStatus('Haetaan sijaintia…', 'var(--warn)');
  const loc = await gps(true);
  if(loc) {
    setLocStatus('Haetaan osoitetta…', 'var(--m2)');
    const addr = await reverseGeocode(loc.lat, loc.lng);
    if(addr) {
      setLocStatus('📍 ' + addr, 'var(--good)');
      // Don't fill startAddr — keep it empty so GPS is used
      // Just show it as status
    } else {
      setLocStatus('📍 ' + loc.lat.toFixed(4) + ', ' + loc.lng.toFixed(4), 'var(--good)');
    }
  }
}

function gps(manual=false){
  pill('pLoc','GPS…','');
  return new Promise(res=>{
    if(!navigator.geolocation){res(fallback());return;}
    // First try cached position (instant) then refine
    navigator.geolocation.getCurrentPosition(
      p=>{
        ST.loc={lat:p.coords.latitude,lng:p.coords.longitude};
        pill('pLoc','GPS ±'+Math.round(p.coords.accuracy)+'m','live');
        log('Sijainti: '+ST.loc.lat.toFixed(4)+', '+ST.loc.lng.toFixed(4),'ok');
        reverseGeocode(ST.loc.lat, ST.loc.lng).then(addr=>{
          setLocStatus('📍 '+(addr||(ST.loc.lat.toFixed(4)+', '+ST.loc.lng.toFixed(4))),'var(--good)');
        });
        res(ST.loc);
      },
      e=>{log('GPS: '+e.message+' — käytetään Helsinkiä','w');res(fallback());},
      {enableHighAccuracy:false, timeout:3000, maximumAge:60000}  // fast cached first
    );
    // Also request high-accuracy in background, update if we get it
    navigator.geolocation.getCurrentPosition(
      p=>{
        const newLoc={lat:p.coords.latitude,lng:p.coords.longitude};
        if(Math.abs(newLoc.lat-(ST.loc?.lat||0))>0.0001 || Math.abs(newLoc.lng-(ST.loc?.lng||0))>0.0001){
          ST.loc=newLoc;
          pill('pLoc','GPS ±'+Math.round(p.coords.accuracy)+'m','live');
        }
      },
      ()=>{},
      {enableHighAccuracy:true, timeout:15000, maximumAge:0}
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
    const ctrl = new AbortController();
    const tid = setTimeout(()=>ctrl.abort(), 5000);
    const r=await fetch('https://nominatim.openstreetmap.org/search?q='+encodeURIComponent(text+',Finland')+'&format=json&limit=1',{
      headers:{'Accept-Language':lang,'User-Agent':'KuokkanenPumpulla/1.0'},
      signal: ctrl.signal,
    });
    clearTimeout(tid);
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
  // Pikahaku (ja run()-kutsu) hakee AINA kaikki asemat — GPS+säde-suodatus hoitaa rajauksen.
  // Lisäasetuksista "↻ Päivitä hinnat" -nappi (manual=true) käyttää valittua aluetta/kaupunkia.
  if(manual && view==='region') url+='region='+encodeURIComponent(reg);
  else if(manual && view==='city') url+='city='+encodeURIComponent(city);
  else if(manual && view==='cheapest') url+='cmd=20halvinta';
  else url='/api/prices'; // kaikki asemat
  log(T('fetching'));
  loader(true,T('fetching'));
  try{
    const r=await fetch(url,{cache:'no-store'});
    const d=await r.json();
    if(!d.ok) throw new Error(d.error||'server error');
    ST.stations=d.stations; ST.fetchedAt=d.fetchedAt;
    // Merkitään onko data aluerajoitettua — run() hakee uudelleen jos on
    ST.stationsFiltered = manual && (view==='region' || view==='city');
    pill('pPrices',d.count+' '+T('stUnit').toLowerCase(),'live');
    // dataLine pysyy staattisena
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
// OSRM Table API — ilmainen, ei API-avainta. Max ~100 dest per kutsu.
// Koordinaatit muodossa lng,lat (OSRM-järjestys!)
async function osrmDist(origin, stations) {
  if (!stations.length) return null;
  try {
    const CHUNK = 80;
    const results = new Array(stations.length).fill(null);
    for (let i = 0; i < stations.length; i += CHUNK) {
      const chunk = stations.slice(i, i + CHUNK);
      const coords = [origin, ...chunk].map(s => s.lng+','+s.lat).join(';');
      const dstIdx = chunk.map((_,j) => j+1).join(';');
      const url = 'https://router.project-osrm.org/table/v1/driving/'+coords
                + '?sources=0&destinations='+dstIdx+'&annotations=distance';
      const ctrl = new AbortController();
      const tid = setTimeout(() => ctrl.abort(), 8000);
      const r = await fetch(url, { signal: ctrl.signal });
      clearTimeout(tid);
      const d = await r.json();
      if (d.code === 'Ok' && d.distances?.[0]) {
        d.distances[0].forEach((m, j) => {
          results[i + j] = m != null ? m / 1000 : null;
        });
      }
    }
    log('OSRM: tieverkkoetäisyydet haettu (' + stations.length + ' as.)', 'ok');
    return results;
  } catch(e) {
    log('OSRM epäonnistui: ' + e.message + ' — käytetään linnuntietä', 'w');
    return null;
  }
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
  // Pakota uudelleenhaku jos välimuistissa on aluerajoitettu data (esim. vanha PK-seutu-haku)
  // tai jos asemia ei ole lainkaan. Näin Lappeenranta ja muut alueet toimivat aina.
  if(!ST.stations.length || ST.stationsFiltered) await loadPrices();
  if(!ST.stations.length){loader(false);log(T('noData'),'e');return;}

  const fuelKey=document.getElementById('fuelType').value;
  const tankSz=+document.getElementById('tankSize').value;
  const cons=+document.getElementById('cons').value;
  const lvlPct=+document.getElementById('lvl').value;
  const fillPct=+document.getElementById('fillTo').value;
  const curL=tankSz*lvlPct/100;
  const fillL=Math.max(0,tankSz*(fillPct-lvlPct)/100);
  const range=curL/cons*100;
  log('Tankki: '+curL.toFixed(0)+'L, toimintasäde: '+range.toFixed(0)+'km, lisätään: '+fillL.toFixed(0)+'L');

  let pool=ST.stations.filter(s=>{
    if(s[fuelKey]==null)return false;
    // Linnuntie-esikarsinta — nopea, karsii epärealistiset asemat ennen OSRM-kutsua
    if(hav(ST.loc.lat,ST.loc.lng,s.lat,s.lng)>range*0.88)return false;
    if(ST.dest){const corrKm=+document.getElementById('corr').value;if(ptSeg(s.lng,s.lat,ST.loc.lng,ST.loc.lat,ST.dest.lng,ST.dest.lat)>corrKm)return false;}
    return true;
  });
  if(!pool.length&&ST.dest){log('Ei asemia käytävässä — käytetään sädettä','w');pool=ST.stations.filter(s=>s[fuelKey]!=null&&hav(ST.loc.lat,ST.loc.lng,s.lat,s.lng)<range*0.88);}
  log(pool.length+' asemaa linnuntiesuodatuksen läpi — haetaan tieverkkoetäisyydet OSRM:stä');
  if(!pool.length){loader(false);log(T('noStations'),'e');return;}

  loader(true,T('calcDist'));
  // OSRM: tarkka tieverkkoetäisyys, ilmainen. Fallback: roadEst(linnuntie) × kerroin
  const rdists = await osrmDist(ST.loc, pool);

  const prices=pool.map(s=>s[fuelKey]).filter(Boolean);
  const refP=Math.max(...prices);
  // Keskihinta ajokustannuslaskentaan (realistisempi kuin kallein)
  const avgP=prices.reduce((a,b)=>a+b,0)/prices.length;
  const fuelKmCost=cons/100;
  // Minimikynnys: alle tämän nettosäästön asemat karsitaan pois
  const MIN_NET_EUR = 0.50;

  const scored=pool.map((s,i)=>{
    const sl=hav(ST.loc.lat,ST.loc.lng,s.lat,s.lng); // linnuntie — näyttöön
    const detour=rdists?.[i]??roadEst(sl);            // tieverkko tai arvio
    const price=s[fuelKey];
    const extra=ST.dest
      ? Math.max(0,detour-hav(ST.dest.lat,ST.dest.lng,s.lat,s.lng))
      : detour*2;
    const gross=(refP-price)*fillL;
    // #1: ajokustannus käyttää alueen keskihintaa, ei kalleinta
    const dCost=extra*fuelKmCost*avgP;
    const net=gross-dCost;
    const tankCost=price*fillL;
    const totalCost=tankCost+dCost;
    // #5: pisteytysfunktio penalisoi pitkiä kiertoteitä pehmeästi
    const score=net/(1+extra);
    const distSrc=rdists?.[i]!=null?'tie':'linnuntie';
    return{...s,price,sl,detour,extra,gross,dCost,net,score,tankCost,totalCost,distSrc};
  })
  // #4: karsitaan alle kynnyksen olevat (ellei kaikki alle — otetaan silti paras)
  .filter((s,_,arr)=>s.net>=MIN_NET_EUR||arr.every(x=>x.net<MIN_NET_EUR))
  // #5: järjestetään score-funktiolla (net / (1+extra))
  .sort((a,b)=>b.score-a.score);

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
  const resEl=document.getElementById('res');
  resEl.style.display='block';
  // Scrollaa tuloksiin automaattisesti mobiililla
  setTimeout(()=>resEl.scrollIntoView({behavior:'smooth',block:'start'}),80);
  const fl={p95:'95E10',p98:'98E5',diesel:'Diesel'}[fuelKey];
  const best=stations[0];
  const cheapest=[...stations].sort((a,b)=>a.price-b.price)[0];
  const avg=stations.reduce((a,s)=>a+s.price,0)/stations.length;
  document.getElementById('rTitle').textContent=stations.length+' '+T('stUnit');
  document.getElementById('rSub').textContent=T('filling')+' '+fillL.toFixed(0)+'L '+fl+' · '+T('rangeWord')+' '+range.toFixed(0)+'km';
  // Näytä: halvin hinta, ka, max säästö — 3 tilaruutua
  document.getElementById('stats').innerHTML=
    sbox(T('cheapestLbl'),cheapest.price.toFixed(3),'€/L · '+cheapest.brand)+
    sbox(T('optimalLbl'),best.price.toFixed(3),'€/L · '+best.brand)+
    sbox(T('savingLbl'),(best.net>=0?'+':'')+best.net.toFixed(2),T('afterDetour'),best.net>0?'var(--good)':best.net<0?'var(--bad)':'var(--mut)');

  const list=document.getElementById('cards');list.innerHTML='';
  const N=Math.min(stations.length,12);
  for(let i=0;i<N;i++){
    const s=stations[i];
    const isBest=i===0;
    const cls=isBest?'best':s.net<0?'lose':s.net<0.3?'marg':'';
    const badge=isBest?bk(T('badgeOptimal'),'g'):s.net<0?bk(T('badgeBad'),'r'):s.net<0.3?bk(T('badgeMarg'),'y'):bk(T('badgeGood'),'g');
    // Kaavat auki
    const fuelFormula=s.price.toFixed(3)+' €/L × '+fillL.toFixed(0)+'L';
    const detourKm=ST.dest?s.extra.toFixed(1):(s.detour*2).toFixed(1);
    const fuelPer100=(+document.getElementById('cons').value||7.5);
    const avgPriceForFormula=ST.stations.filter(x=>x[fuelKey]).reduce((a,x)=>a+x[fuelKey],0)/ST.stations.filter(x=>x[fuelKey]).length||s.price;
    const detourFormula=detourKm+' km × '+(fuelPer100/100*avgPriceForFormula).toFixed(3)+' €/km (ka-hinta)';

    list.innerHTML+='<div class="card '+cls+(isBest?' card-best-highlight':'')+'" onclick="nav('+s.lat+','+s.lng+')">'+
      '<div style="display:grid;grid-template-columns:1fr auto;gap:8px;align-items:start">'+
        '<div>'+
          '<div class="cn" style="'+(isBest?'font-size:1.05em':'')+'">'+
            '<span class="rank">#'+(i+1)+'</span>'+s.brand+badge+
            '<span style="color:var(--m2);font-size:.8em;font-weight:300">'+(s.city||'')+'</span>'+
          '</div>'+
          '<div style="font-size:.73em;color:var(--m2);margin-bottom:4px">'+((s.name||'').slice(0,55))+'</div>'+
          '<div class="cm">'+
            '<span>· '+s.sl.toFixed(1)+' '+T('crowKm')+'</span>'+
            '<span>· '+(ST.dest?s.detour.toFixed(1)+' '+T('roadKm'):(s.detour*2).toFixed(1)+' '+T('roadKm'))+' ('+s.distSrc+(ST.dest?'':' edestakainen')+')</span>'+
            '<span style="color:'+updColor(s,fuelKey)+'">· '+updAge(s,fuelKey)+'</span>'+
          '</div>'+
        '</div>'+
        '<div style="text-align:right;min-width:80px">'+
          '<div class="cp" style="color:'+(isBest?'var(--acc)':'var(--txt)')+'">'+s.price.toFixed(3)+'<span class="cu">€/L</span></div>'+
          '<div class="csav '+(s.net>0.1?'pos':s.net<-0.1?'neg':'neu')+'">'+T('net')+' '+(s.net>=0?'+':'')+s.net.toFixed(2)+'€</div>'+
        '</div>'+
      '</div>'+
      '<div class="cost-grid" style="margin-top:10px">'+
        '<div class="cost-box">'+
          '<div class="cost-lbl">'+T('tankCostLbl')+'</div>'+
          '<div class="cost-val" style="color:var(--acc)">'+s.tankCost.toFixed(2)+'€</div>'+
          '<div class="cost-formula">'+fuelFormula+'</div>'+
        '</div>'+
        '<div class="cost-box">'+
          '<div class="cost-lbl">'+T('detourCostLbl')+'</div>'+
          '<div class="cost-val" style="color:var(--warn)">'+s.dCost.toFixed(2)+'€</div>'+
          '<div class="cost-formula">'+detourFormula+'</div>'+
        '</div>'+
        '<div class="cost-box" style="background:color-mix(in srgb,var(--acc) 8%,transparent);border-color:color-mix(in srgb,var(--acc) 30%,transparent)">'+
          '<div class="cost-lbl">'+T('totalCostLbl')+'</div>'+
          '<div class="cost-val" style="color:var(--acc)">'+s.totalCost.toFixed(2)+'€</div>'+
        '</div>'+
        '<div class="cost-box">'+
          '<div class="cost-lbl">'+T('netSavingLbl')+' vs. kallein</div>'+
          '<div class="cost-val" style="color:'+(s.net>0?'var(--good)':s.net<0?'var(--bad)':'var(--mut)')+'">'+(s.net>=0?'+':'')+s.net.toFixed(2)+'€</div>'+
        '</div>'+
      '</div>'+
    '</div>';
  }
  if(stations.length>N)list.innerHTML+='<div style="text-align:center;font-family:DM Mono,monospace;font-size:.67em;color:var(--mut);padding:10px">+'+(stations.length-N)+' muuta</div>';
}
function sbox(lbl,val,unit,color){return'<div class="sb"><div class="sl">'+lbl+'</div><div class="sv"'+(color?' style="color:'+color+'"':'')+'>'+val+'</div><div class="su">'+unit+'</div></div>';}
function bk(t,c){return'<span class="bk '+c+'">'+t+'</span>';}
function nav(lat,lng){
  const base='https://www.google.com/maps/dir/?api=1';
  const dest='&destination='+lat+','+lng;
  const orig=ST.loc?'&origin='+ST.loc.lat+','+ST.loc.lng:'';
  window.open(base+orig+dest,'_blank');
}

// ═══════════════════════════════════════════════════
// MAP
// ═══════════════════════════════════════════════════
// ── OSM tile helpers ──────────────────────────────
function latLngToTile(lat,lng,z){
  const n=Math.pow(2,z);
  const x=Math.floor((lng+180)/360*n);
  const latR=lat*Math.PI/180;
  const y=Math.floor((1-Math.log(Math.tan(latR)+1/Math.cos(latR))/Math.PI)/2*n);
  return{x,y};
}
function tileToLatLng(tx,ty,z){
  const n=Math.pow(2,z);
  const lng=tx/n*360-180;
  const latR=Math.atan(Math.sinh(Math.PI*(1-2*ty/n)));
  return{lat:latR*180/Math.PI,lng};
}
function latLngToPixel(lat,lng,z,tileX0,tileY0,tileSize){
  const n=Math.pow(2,z);
  const px=(lng+180)/360*n*tileSize - tileX0*tileSize;
  const latR=lat*Math.PI/180;
  const py=(1-Math.log(Math.tan(latR)+1/Math.cos(latR))/Math.PI)/2*n*tileSize - tileY0*tileSize;
  return[px,py];
}

function drawMap(origin, dest, stations, forceZoom, panX, panY){
  const wrap=document.getElementById('mapwrap'), c=document.getElementById('mc');
  document.getElementById('mhint').style.display='none';
  c.width=wrap.offsetWidth; c.height=280;
  const ctx=c.getContext('2d');
  const isDark=document.documentElement.dataset.theme!=='light';
  panX=panX||0; panY=panY||0;

  // All points to determine bounding box
  const pts=[origin,...stations.slice(0,20).map(s=>({lat:s.lat,lng:s.lng}))];
  if(dest) pts.push(dest);
  const lats=pts.map(p=>p.lat), lngs=pts.map(p=>p.lng);
  const mnLat=Math.min(...lats), mxLat=Math.max(...lats);
  const mnLng=Math.min(...lngs), mxLng=Math.max(...lngs);

  // Pick zoom level that fits all points with padding
  const TILESIZE=256;
  let zoom = forceZoom || 13;
  if(!forceZoom) {
    for(let z=14;z>=8;z--){
      const t0=latLngToTile(mxLat,mnLng,z);
      const t1=latLngToTile(mnLat,mxLng,z);
      const tilesW=t1.x-t0.x+1, tilesH=t1.y-t0.y+1;
      if(tilesW*TILESIZE<=c.width*1.2 && tilesH*TILESIZE<=c.height*1.2){zoom=z;break;}
    }
  }

  // Tile range to cover canvas
  const centerLat=(mnLat+mxLat)/2, centerLng=(mnLng+mxLng)/2;
  const centerTile=latLngToTile(centerLat,centerLng,zoom);
  const tilesX=Math.ceil(c.width/TILESIZE)+2;
  const tilesY=Math.ceil(c.height/TILESIZE)+2;
  const tileX0=centerTile.x-Math.floor(tilesX/2);
  const tileY0=centerTile.y-Math.floor(tilesY/2);

  // Offset so center tile is centered on canvas, plus user pan
  const centerPx=latLngToPixel(centerLat,centerLng,zoom,tileX0,tileY0,TILESIZE);
  const offX=c.width/2-centerPx[0] + panX;
  const offY=c.height/2-centerPx[1] + panY;

  function toXY(lat,lng){
    const[px,py]=latLngToPixel(lat,lng,zoom,tileX0,tileY0,TILESIZE);
    return[px+offX,py+offY];
  }

  // Draw background first
  ctx.fillStyle=isDark?'#1a1d1a':'#e8e8e8';
  ctx.fillRect(0,0,c.width,c.height);

  // Load and draw OSM tiles
  // Use both light and dark-friendly tile servers
  const tileUrl = isDark
    ? (z,x,y) => \`https://tiles.stadiamaps.com/tiles/alidade_smooth_dark/\${z}/\${x}/\${y}.png\`
    : (z,x,y) => \`https://tile.openstreetmap.org/\${z}/\${x}/\${y}.png\`;

  let tilesLoaded=0, tilesTotal=0;

  function drawOverlay(){
    // Dark tint for dark mode
    if(isDark){ctx.fillStyle='rgba(0,0,0,.25)';ctx.fillRect(0,0,c.width,c.height);}

    // Route line
    if(dest){
      const[ox,oy]=toXY(origin.lat,origin.lng),[dx,dy]=toXY(dest.lat,dest.lng);
      ctx.strokeStyle=isDark?'rgba(184,245,66,.5)':'rgba(58,125,0,.6)';
      ctx.lineWidth=2;ctx.setLineDash([6,4]);
      ctx.beginPath();ctx.moveTo(ox,oy);ctx.lineTo(dx,dy);ctx.stroke();ctx.setLineDash([]);
      // Dest marker
      ctx.fillStyle=isDark?'rgba(245,200,66,.2)':'rgba(138,92,0,.15)';
      ctx.beginPath();ctx.arc(dx,dy,12,0,Math.PI*2);ctx.fill();
      ctx.strokeStyle='#f5c842';ctx.lineWidth=2.5;
      ctx.beginPath();ctx.arc(dx,dy,6,0,Math.PI*2);ctx.stroke();
    }

    // Station dots
    const goodC=isDark?'#b8f542':'#2a6000';
    const warnC=isDark?'#f5c842':'#a06000';
    const badC='#f54242';
    const dimC=isDark?'#4a8a4a':'#6aaa6a';
    const N=Math.min(stations.length,20);
    for(let i=N-1;i>=0;i--){
      const s=stations[i],[x,y]=toXY(s.lat,s.lng);
      if(x<-20||x>c.width+20||y<-20||y>c.height+20) continue;
      const col=i===0?goodC:s.net<0?badC:s.net<0.3?warnC:dimC;
      const r=i===0?9:5;
      // Shadow
      ctx.fillStyle='rgba(0,0,0,.3)';ctx.beginPath();ctx.arc(x+1,y+1,r,0,Math.PI*2);ctx.fill();
      // Glow
      ctx.fillStyle=col+'44';ctx.beginPath();ctx.arc(x,y,r*2.2,0,Math.PI*2);ctx.fill();
      // Dot
      ctx.fillStyle=col;ctx.beginPath();ctx.arc(x,y,r,0,Math.PI*2);ctx.fill();
      // White border
      ctx.strokeStyle='rgba(255,255,255,.8)';ctx.lineWidth=1.5;
      ctx.beginPath();ctx.arc(x,y,r,0,Math.PI*2);ctx.stroke();
      // Star for best
      if(i===0){
        ctx.fillStyle='#fff';ctx.font='bold 9px sans-serif';
        ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText('★',x,y);
      }
      // Price label for top 6
      if(i<6){
        ctx.font='bold 10px DM Mono,monospace';
        ctx.fillStyle=isDark?'#fff':'#111';
        ctx.strokeStyle=isDark?'rgba(0,0,0,.7)':'rgba(255,255,255,.9)';
        ctx.lineWidth=3;ctx.textAlign='left';ctx.textBaseline='middle';
        ctx.strokeText(s.price.toFixed(3),x+r+4,y);
        ctx.fillText(s.price.toFixed(3),x+r+4,y);
      }
    }

    // Origin marker (you are here)
    const[ox,oy]=toXY(origin.lat,origin.lng);
    ctx.fillStyle='rgba(245,200,66,.25)';ctx.beginPath();ctx.arc(ox,oy,18,0,Math.PI*2);ctx.fill();
    ctx.fillStyle='#f5c842';ctx.beginPath();ctx.arc(ox,oy,8,0,Math.PI*2);ctx.fill();
    ctx.strokeStyle='#fff';ctx.lineWidth=2;ctx.beginPath();ctx.arc(ox,oy,8,0,Math.PI*2);ctx.stroke();
    ctx.fillStyle='#fff';ctx.font='bold 9px sans-serif';
    ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText('◉',ox,oy);

    // OSM attribution (required!)
    ctx.fillStyle=isDark?'rgba(0,0,0,.6)':'rgba(255,255,255,.75)';
    const attr='© OpenStreetMap contributors';
    ctx.font='9px sans-serif';
    const aw=ctx.measureText(attr).width;
    ctx.fillRect(c.width-aw-12,c.height-16,aw+8,14);
    ctx.fillStyle=isDark?'#aaa':'#555';
    ctx.textAlign='right';ctx.textBaseline='bottom';
    ctx.fillText(attr,c.width-4,c.height-3);

    // Legend
    ctx.fillStyle=isDark?'rgba(0,0,0,.5)':'rgba(255,255,255,.75)';
    ctx.fillRect(4,c.height-16,250,14);
    ctx.font='9px DM Mono,monospace';ctx.textAlign='left';
    ctx.fillStyle=isDark?'#aaa':'#555';
    ctx.fillText('◉ SINÄ  ★ OPTIMAALISIN  ● HYVÄ  ● MARGINAALINEN  ● EI KANNATA',8,c.height-4);
  }

  const isFirstDraw = !forceZoom && panX===0 && panY===0;

  // Kerätään tiilit listaan — piirretään overlay VASTA kun kaikki tiilit ladattu,
  // jotta tiilit eivät ylikirjoita asemapisteitä
  const tileQueue = [];
  for(let tx=tileX0;tx<tileX0+tilesX;tx++){
    for(let ty=tileY0;ty<tileY0+tilesY;ty++){
      if(ty<0) continue;
      tilesTotal++;
      const img=new Image();
      img.crossOrigin='anonymous';
      const cornerLatLng=tileToLatLng(tx,ty,zoom);
      const[cx2,cy2]=latLngToPixel(cornerLatLng.lat,cornerLatLng.lng,zoom,tileX0,tileY0,TILESIZE);
      const finalX=Math.round(cx2+offX);
      const finalY=Math.round(cy2+offY);
      tileQueue.push({img,finalX,finalY});
      const tryFinish=()=>{
        if(tilesLoaded>=tilesTotal){
          // Piirrä tausta + kaikki tiilit + overlay järjestyksessä
          ctx.fillStyle=isDark?'#1a1d1a':'#e8e8e8';
          ctx.fillRect(0,0,c.width,c.height);
          tileQueue.forEach(t=>{try{ctx.drawImage(t.img,t.finalX,t.finalY,TILESIZE,TILESIZE);}catch(e){}});
          drawOverlay();
        }
      };
      img.onload=()=>{ tilesLoaded++; tryFinish(); };
      img.onerror=()=>{ tilesLoaded++; tryFinish(); };
      img.src=tileUrl(zoom,tx,ty);
    }
  }
  // Fallback: jos tiilit eivät lataudu 2.5s:ssa, piirretään overlay ilman niitä
  setTimeout(()=>{ if(tilesLoaded<tilesTotal){ tilesLoaded=tilesTotal; drawOverlay(); } }, 2500);
  if(isFirstDraw) initMapInteraction(origin, dest, stations, zoom, offX-panX, offY-panY);
}

// ── Map interaction state ─────────────────────────
let mapState = null; // {origin, dest, stations, zoom, panX, panY}

function zoomMap(delta) {
  if(!mapState) return;
  mapState.zoom = Math.max(8, Math.min(16, mapState.zoom + delta));
  mapState.panX = 0; mapState.panY = 0;
  redrawMap();
}

function initMapInteraction(origin, dest, stations, zoom, offX, offY) {
  mapState = {origin, dest, stations, zoom, panX:0, panY:0, baseOffX:offX, baseOffY:offY};
  const c = document.getElementById('mc');
  const wrap = document.getElementById('mapwrap');

  // Remove old listeners
  const c2 = c.cloneNode(true);
  c.parentNode.replaceChild(c2, c);
  const canvas = document.getElementById('mc');

  let dragging=false, lastX=0, lastY=0;

  canvas.addEventListener('mousedown', e=>{
    dragging=true; lastX=e.clientX; lastY=e.clientY;
    wrap.style.cursor='grabbing';
  });
  window.addEventListener('mouseup', ()=>{ dragging=false; wrap.style.cursor='grab'; });
  window.addEventListener('mousemove', e=>{
    if(!dragging||!mapState) return;
    mapState.panX += e.clientX-lastX;
    mapState.panY += e.clientY-lastY;
    lastX=e.clientX; lastY=e.clientY;
    redrawMap();
  });

  // Touch pan
  let lastTX=0, lastTY=0;
  canvas.addEventListener('touchstart', e=>{ lastTX=e.touches[0].clientX; lastTY=e.touches[0].clientY; e.preventDefault(); },{passive:false});
  canvas.addEventListener('touchmove', e=>{
    if(!mapState) return;
    mapState.panX += e.touches[0].clientX-lastTX;
    mapState.panY += e.touches[0].clientY-lastTY;
    lastTX=e.touches[0].clientX; lastTY=e.touches[0].clientY;
    redrawMap(); e.preventDefault();
  },{passive:false});

  // Scroll to zoom
  canvas.addEventListener('wheel', e=>{
    e.preventDefault();
    if(!mapState) return;
    const oldZoom = mapState.zoom;
    mapState.zoom = Math.max(8, Math.min(16, mapState.zoom + (e.deltaY<0?1:-1)));
    if(mapState.zoom !== oldZoom){ mapState.panX=0; mapState.panY=0; redrawMap(); }
  },{passive:false});
}

function redrawMap() {
  if(!mapState) return;
  drawMap(mapState.origin, mapState.dest, mapState.stations, mapState.zoom, mapState.panX, mapState.panY);
}


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
    const adv=localStorage.getItem('kp_adv');
    if(adv==='1'){document.getElementById('adv-panel').style.display='block';document.getElementById('adv-arrow').textContent='▲';}
    const fuel=localStorage.getItem('kp_fuel');
    if(fuel)document.getElementById('fuelType').value=fuel;
    const tank=localStorage.getItem('kp_tank');
    if(tank)document.getElementById('tankSize').value=tank;
    const cons=localStorage.getItem('kp_cons');
    if(cons)document.getElementById('cons').value=cons;
  }catch(e){}
  setLang('fi');
  syncR();
  gps();
  loadPrices();
});
</script>
</body>
</html>`;
