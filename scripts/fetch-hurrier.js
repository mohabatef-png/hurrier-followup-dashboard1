/**
 * fetch-hurrier.js
 * ─────────────────────────────────────────────────────────────
 * Fetches active deliveries from the Talabat dispatcher API
 * for all configured hubs, then writes one data-<slug>.json
 * file per hub into the repo root (for the dashboard to read).
 *
 * Required env var:
 *   TALABAT_TOKEN  — your Bearer token (set as a GitHub secret)
 *
 * Optional env vars (override defaults):
 *   TALABAT_API_BASE  — base URL, default: https://dispatcher.talabat.com
 *   MAX_ORDERS        — max orders per hub,  default: 10000
 *   PER_PAGE          — page size,            default: 50
 * ─────────────────────────────────────────────────────────────
 */

const fs   = require('fs');
const path = require('path');

// ── CONFIG ────────────────────────────────────────────────────
const TOKEN    = process.env.TALABAT_TOKEN;
const API_BASE = (process.env.TALABAT_API_BASE || 'https://dispatcher.talabat.com').replace(/\/$/, '');
const MAX      = parseInt(process.env.MAX_ORDERS || '10000', 10);
const PER_PAGE = parseInt(process.env.PER_PAGE   || '50',    10);
const CONCURRENCY = 6; // parallel courier-detail requests

if (!TOKEN) {
  console.error('❌  TALABAT_TOKEN env var is not set. Add it as a GitHub Secret named TALABAT_API_TOKEN.');
  process.exit(1);
}

console.log(`🔧  API base: ${API_BASE}`);
console.log(`🔑  Token: ${TOKEN.slice(0, 6)}${'*'.repeat(10)} (first 6 chars shown)`);
console.log(`📄  Node.js: ${process.version}`);

const HEADERS = {
  Authorization:   `Bearer ${TOKEN}`,
  Accept:          'application/json',
  'Content-Type':  'application/json',
};

// ── HUB DEFINITIONS ──────────────────────────────────────────
// Each hub maps a slug (→ file name, must match the dashboard's
// HUBS array in index.html) to the starting_point_ids it covers.
// Filled in from hub_report.xlsx (162 SPs across 10 hubs).
const HUBS = [
  {
    slug: 'mohandsien',
    spIds: [10237, 10195, 2, 10167, 10129, 10166, 10222, 10143, 10164, 10192,
            10045, 10104, 10063, 10092, 10238, 10193],
  },
  {
    slug: 'alexandria',
    spIds: [10200, 10199, 10027, 10202, 10201, 10028, 10203, 10204, 10085,
            10205, 10206, 10025, 10079, 10144],
  },
  {
    slug: 'delta',
    spIds: [10061, 10078, 10080, 10065, 10052, 10044, 10140, 10175, 10055,
            10176, 10054, 10154, 10042, 10043, 10168],
  },
  {
    slug: 'october',
    spIds: [10191, 10194, 10220, 10136, 10138, 10047, 10126, 10029, 10226,
            10184, 10032, 10094, 10212, 10221, 10142, 10096, 10068, 10234,
            10141, 10151],
  },
  {
    slug: 'haram',
    spIds: [10181, 10125, 10182, 10183, 10018, 10139, 10211, 10190, 10197,
            10074, 10210, 10214, 10189, 10162, 10004, 10022, 10163],
  },
  {
    slug: 'maadi-mokattam-helwan',
    spIds: [10174, 10228, 10215, 10232, 10130, 10002, 10003, 10009,
            10161, 10231, 10217, 10227, 10001, 10064, 10020],
  },
  {
    slug: 'nasr-city-heliopolis',
    spIds: [10024, 10218, 10230, 10198, 10196, 10128, 10000, 10033, 1,
            10127, 10186, 10229, 10216, 10006, 10005, 10131, 10115, 10114,
            10235, 10113, 10219],
  },
  {
    slug: 'new-cities',
    spIds: [10165, 10070, 10099, 10100, 10102, 10223, 10187, 10233, 10069,
            10101, 10177, 10179, 10159, 10180, 10067, 10207],
  },
  {
    slug: 'new-cairo-rehab-tagammoa',
    spIds: [10173, 10013, 10089, 10150, 10225, 10188, 10160, 10185, 10208,
            10224, 10091, 10012, 10011, 10010, 10209, 10090],
  },
  {
    slug: 'east-south-mid-egypt',
    spIds: [10156, 10060, 10059, 10053, 10152, 10057, 10073, 10049, 10050,
            10157, 10145, 10158],
  },
];

// ── HELPERS ───────────────────────────────────────────────────
async function apiFetch(url, options = {}) {
  const res = await fetch(url, { headers: HEADERS, ...options });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${res.statusText} — ${url}\nResponse body: ${body.slice(0, 300)}`);
  }
  return res.json();
}

/** Fetch all active deliveries for a set of starting-point IDs */
async function fetchDeliveries(spIds) {
  const spQuery = spIds.map(id => `starting_point_id[]=${id}`).join('&');
  const all     = [];
  const seenIds = new Set();
  let page = 1, stalePages = 0;

  while (all.length < MAX) {
    const url = `${API_BASE}/api/dispatcher-dashboard/deliveries/active?${spQuery}&page=${page}&per_page=${PER_PAGE}`;
    const data = await apiFetch(url);
    const rows  = data.records || [];
    const total = data.metadata?.total_count || 0;
    const totalPages = total ? Math.ceil(total / PER_PAGE) : 1;

    if (!rows.length) break;

    const newRows = rows.filter(r => {
      const rid = r.id || r.order?.code;
      if (!rid || seenIds.has(String(rid))) return false;
      seenIds.add(String(rid));
      return true;
    });

    if (!newRows.length) {
      if (++stalePages >= 2) break;
    } else {
      stalePages = 0;
    }

    all.push(...newRows);
    if (page >= totalPages || all.length >= MAX) break;
    page++;
  }

  return all.slice(0, MAX);
}

/** Fetch courier detail + wallet balance, returns { vehicle, status, phone, balance } */
async function fetchCourierDetail(courierId) {
  try {
    const jd  = await apiFetch(`${API_BASE}/api/dispatcher-dashboard/courier/detail?courier_id=${courierId}`);
    const c   = jd.courier || {};
    const uid = c.user_id || courierId;

    let balance = null;
    try {
      const jb = await apiFetch(`${API_BASE}/api/cash-collection/v1/couriers/${uid}/balance?courier_id=${uid}`);
      if (jb?.balance != null) balance = jb.balance / 100;
    } catch { /* balance unavailable — skip */ }

    return {
      vehicle: c.vehicle        || '',
      status:  c.status         || '',
      phone:   c.phone_number   || '',
      balance,
    };
  } catch {
    return { vehicle: '', status: '', phone: '', balance: null };
  }
}

/** Run an async worker pool */
async function pool(items, fn, concurrency) {
  const results = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i  = idx++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}

// ── MAIN ──────────────────────────────────────────────────────
async function processHub({ slug, spIds }) {
  console.log(`\n📦  Hub: ${slug}`);

  // 1. Fetch all deliveries
  const deliveries = await fetchDeliveries(spIds);
  console.log(`   ${deliveries.length} deliveries fetched`);

  // 2. Collect unique courier IDs
  const courierMap = {};
  const uniqueCids = [];
  const seenCids   = new Set();

  deliveries.forEach(d => {
    const cid = d.courier_id || d.courier?.id || null;
    d._cid = cid;
    if (cid && !seenCids.has(cid)) {
      seenCids.add(cid);
      uniqueCids.push(cid);
    }
  });

  // 3. Fetch courier details concurrently
  console.log(`   Fetching details for ${uniqueCids.length} couriers…`);
  const details = await pool(uniqueCids, fetchCourierDetail, CONCURRENCY);
  uniqueCids.forEach((cid, i) => { courierMap[cid] = details[i]; });

  // 4. Build the processed records (same shape the dashboard expects)
  const now = Date.now();
  const processed = deliveries.map(d => {
    const o    = d.order || {};
    const drop = o.scheduled_dropoff_at ? new Date(o.scheduled_dropoff_at).getTime() : null;
    const dm   = drop ? Math.round((drop - now) / 60000) : null;
    const brv  = (d.business_restricted_vehicles || '').toString().trim();
    const cd   = (d._cid && courierMap[d._cid]) || null;

    return {
      id:      o.code || String(d.id),
      v:       (o.vendor_name || '').slice(0, 50),
      dm,
      c:       d.courier_name || '',
      phone:   (cd?.phone)   || '',
      vehicle: (cd?.vehicle) || brv,
      rs:      (cd?.status)  || '',
      bal:     (cd?.balance != null) ? cd.balance : null,
      s:       d.status || '',
      z:       (d.starting_points || [])[0] || '',
      vt:      o.vertical_type || '',
      cash:    o.is_cash_collection ? 1 : 0,
      ts:      now,
      agent:   'Unassigned',
    };
  });

  // 5. Write file
  const outFile = path.join(__dirname, '..', `data-${slug}.json`);
  fs.writeFileSync(outFile, JSON.stringify(processed), 'utf8');
  console.log(`   ✅  Written → data-${slug}.json  (${processed.length} orders)`);
}

(async () => {
  console.log('🚀  Hurrier data fetch starting…');
  const t0 = Date.now();

  for (const hub of HUBS) {
    await processHub(hub);
  }

  // 6. Build the "all-cairo" aggregate file (unfiltered — combines every hub)
  console.log(`\n📦  Hub: all-cairo (aggregate)`);
  const allData = [];
  for (const hub of HUBS) {
    const f = path.join(__dirname, '..', `data-${hub.slug}.json`);
    if (fs.existsSync(f)) {
      allData.push(...JSON.parse(fs.readFileSync(f, 'utf8')));
    }
  }
  fs.writeFileSync(path.join(__dirname, '..', 'data-all-cairo.json'), JSON.stringify(allData), 'utf8');
  console.log(`   ✅  Written → data-all-cairo.json  (${allData.length} orders)`);

  console.log(`\n✅  All done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
})().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
