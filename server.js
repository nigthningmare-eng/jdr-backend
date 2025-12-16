// ==== JDR Backend (spécial GPT personnalisé / Render / Neon) ====
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const crypto = require('crypto'); // ✅ AJOUT
const { Pool } = require('pg');

require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

function log(...args) {
  console.log('[JDR]', ...args);
}

// ---------- Middlewares ----------
app.use(cors());
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));

// ---------- DB ----------

// ⚠️ Évite de logger DATABASE_URL complet en prod (ça contient user/pass)
// Si tu veux garder un log, log juste le host:
try {
  const u = new URL(process.env.DATABASE_URL || '');
  console.log('DB host =', u.host);
} catch {
  console.log('DB configured =', Boolean(process.env.DATABASE_URL));
}

const shouldUseSSL =
  process.env.DATABASE_URL &&
  /neon\.tech|render\.com|supabase\.co/i.test(process.env.DATABASE_URL);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: shouldUseSSL ? { rejectUnauthorized: false } : false,
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

// ---------- Mémoire légère ----------
let narrativeStyle = { styleText: '' }; // depuis DB
let contentSettings = { explicitLevel: 'mature' }; // 'safe' | 'mature' | 'fade'

// ---------- Utils simples ----------
function deepMerge(base, update) {
  if (Array.isArray(base) || Array.isArray(update)) return update;
  if (base && typeof base === 'object' && update && typeof update === 'object') {
    const out = { ...base };
    for (const k of Object.keys(update)) out[k] = deepMerge(base[k], update[k]);
    return out;
  }
  return update === undefined ? base : update;
}

// ✅ AJOUT : helper de sécurité pour commit/patch GPT
function stripLockedPatch(current, patch) {
  const locked = new Set(
    Array.isArray(current?.lockedTraits)
      ? current.lockedTraits.map(String)
      : []
  );

  if (!patch || typeof patch !== 'object') return patch;

  const cleaned = Array.isArray(patch) ? [...patch] : { ...patch };

  // Respect des traits verrouillés (top-level)
  for (const key of Object.keys(cleaned)) {
    if (locked.has(key)) delete cleaned[key];
  }

  // garde-fous anti-destruction
  if ('id' in cleaned) delete cleaned.id;
  if ('name' in cleaned) {
    const n = cleaned.name;
    if (n == null || !String(n).trim()) delete cleaned.name;
    else cleaned.name = String(n).trim();
  }

  return cleaned;
}

function fingerprint(text = '') {
  const s = String(text).toLowerCase().replace(/\s+/g, ' ').slice(0, 500);
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return String(h >>> 0);
}

// petit hash déterministe
function hashToInt(str) {
  const s = String(str || '');
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) >>> 0;
  }
  return h;
}

const DECOR_EMOJIS = [
  '🙂','😏','😠','🤔','🤗','😇','😎','🤨','🥴','🤡',
  '🔥','⚔️','❄️','🌸','🦊','🐉','🦋','🛡️','📜','💫'
];

// ... le reste inchangé



function decorateEmojiForPnj(p) {
  const traits = Array.isArray(p.personalityTraits) ? p.personalityTraits.map(t => t.toLowerCase()) : [];
  const name = p.name || p.id || 'pnj';

  if (traits.some(t => t.includes('feu') || t.includes('colère') || t.includes('dragon'))) {
    return '🔥';
  }
  if (traits.some(t => t.includes('froid') || t.includes('glace') || t.includes('calme'))) {
    return '❄️';
  }
  if (traits.some(t => t.includes('noble') || t.includes('royal') || t.includes('princesse'))) {
    return '🦋';
  }
  if (traits.some(t => t.includes('farceur') || t.includes('espiègle') || t.includes('voleur'))) {
    return '😏';
  }

  const h = hashToInt(name);
  const idx = h % DECOR_EMOJIS.length;
  return DECOR_EMOJIS[idx];
}

function compactCard(p) {
  return {
    id: p.id,
    name: p.name,
    emoji: decorateEmojiForPnj(p),
    appearance: p.appearance,
    personalityTraits: p.personalityTraits,
    backstoryHint: (p.backstory || '').split('\n').slice(-2).join(' ').slice(0, 300),
    skills: Array.isArray(p.skills) ? p.skills.map(s => s.name).slice(0, 8) : [],
    locationId: p.locationId,
    canonId: p.canonId,
    lockedTraits: p.lockedTraits,
  };
}

function continuityDossier(p) {
  return {
    id: p.id,
    name: p.name,
    coreFacts: [
      p.raceName || p.raceId ? `Race: ${p.raceName || p.raceId}` : null,
      Array.isArray(p.personalityTraits) && p.personalityTraits.length
        ? `Traits: ${p.personalityTraits.slice(0, 5).join(', ')}`
        : null,
      p.locationId ? `Loc: ${p.locationId}` : null,
    ].filter(Boolean),
  };
}

// ---------- Init tables ----------
(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS pnjs (
        id   TEXT  PRIMARY KEY,
        data JSONB NOT NULL
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS sessions (
        id   TEXT  PRIMARY KEY,
        data JSONB NOT NULL
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS settings (
        key   TEXT PRIMARY KEY,
        value JSONB NOT NULL
      );
    `);

    // recharger style narratif
    try {
      const r = await pool.query(`SELECT value FROM settings WHERE key = 'narrativeStyle'`);
      if (r.rows.length) {
        narrativeStyle = r.rows[0].value || { styleText: '' };
        console.log('Style narratif rechargé depuis la base.');
      } else {
        console.log('Aucun style narratif trouvé en base (style vide).');
      }
    } catch (e) {
      console.log('Impossible de lire settings.narrativeStyle, on continue quand même.', e.message);
    }

    console.log('Tables pnjs, sessions, settings OK');
  } catch (e) {
    console.error('DB init failed:', e);
  }
})();

// ---------- Session helpers ----------
async function getOrInitSession(sid) {
  const s = String(sid || '').trim();
  if (!s) return { id: 'default', data: { lastReplies: [], notes: [], dossiersById: {}, turn: 0 } };
  const r = await pool.query('SELECT data FROM sessions WHERE id=$1', [s]);
  if (!r.rows.length) {
    const data = { lastReplies: [], notes: [], dossiersById: {}, turn: 0 };
    await pool.query('INSERT INTO sessions (id, data) VALUES ($1, $2::jsonb)', [s, JSON.stringify(data)]);
    return { id: s, data };
  }
  const data = r.rows[0].data || { lastReplies: [], notes: [], dossiersById: {}, turn: 0 };
  if (!data.dossiersById) data.dossiersById = {};
  return { id: s, data };
}

async function saveSession(sid, data) {
  await pool.query(
    `INSERT INTO sessions (id, data) VALUES ($1,$2::jsonb)
     ON CONFLICT (id) DO UPDATE SET data=EXCLUDED.data`,
    [sid, JSON.stringify(data)]
  );
}

async function loadPnjsByIds(ids = []) {
  const out = [];
  for (const id of ids) {
    const r = await pool.query('SELECT data FROM pnjs WHERE id=$1', [String(id)]);
    if (r.rows.length) out.push(r.rows[0].data);
  }
  return out;
}

async function hydrateSessionPnjs(sess) {
  sess.data = sess.data || {};
  sess.data.dossiersById = sess.data.dossiersById || {};

  const knownIds = Object.keys(sess.data.dossiersById);
  const idsToLoad = knownIds.slice(0, 50);
  if (!idsToLoad.length) return { loaded: 0, missing: [] };

  const r = await pool.query('SELECT data FROM pnjs WHERE id = ANY($1::text[])', [idsToLoad]);
  const rows = r.rows || [];
  const foundIds = new Set();

  for (const row of rows) {
    const p = row.data;
    if (!p || !p.id) continue;
    foundIds.add(p.id);
    sess.data.dossiersById[p.id] = continuityDossier(p);
  }

  const missing = idsToLoad.filter(id => !foundIds.has(id));
  return { loaded: rows.length, missing };
}

// =================== PNJ (PostgreSQL) ====================

app.get('/api/pnjs/names', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '100', 10), 1000);
  const offset = Math.max(parseInt(req.query.offset || '0', 10), 0);

  const totalR = await pool.query('SELECT COUNT(*)::int AS n FROM pnjs');
  const total = totalR.rows[0].n;

  const r = await pool.query(
    `SELECT data->>'id' AS id, data->>'name' AS name
     FROM pnjs
     ORDER BY (data->>'name') NULLS LAST, id
     LIMIT $1 OFFSET $2`,
    [limit, offset]
  );

  res.json({
    total,
    limit,
    offset,
    hasMore: offset + r.rows.length < total,
    items: r.rows.map(x => ({ id: x.id, name: x.name }))
  });
});



// LISTE
app.get('/api/pnjs', async (req, res) => {
  res.set('Content-Type', 'application/json; charset=utf-8');
  const limitMax = 1000;
  const limit = Math.min(parseInt(req.query.limit || '50', 10), limitMax);
  const offset = Math.max(parseInt(req.query.offset || '0', 10), 0);
  const q = (req.query.q || '').toString().trim();
  const fields = (req.query.fields || '').toString().trim();

  try {
    let total = 0;
    if (q) {
      const cr = await pool.query(
        `SELECT COUNT(*)::int AS n FROM pnjs
         WHERE lower(data->>'name') LIKE lower($1) OR lower(data->>'description') LIKE lower($1)`,
        [`%${q}%`]
      );
      total = cr.rows[0].n;
    } else {
      const cr = await pool.query('SELECT COUNT(*)::int AS n FROM pnjs');
      total = cr.rows[0].n;
    }

    const params = [limit, offset];
    let where = '';
    if (q) {
      params.push(`%${q}%`, `%${q}%`);
      where = `WHERE lower(data->>'name') LIKE lower($3) OR lower(data->>'description') LIKE lower($4)`;
    }

    const { rows } = await pool.query(
      `SELECT data FROM pnjs ${where} ORDER BY (data->>'name') NULLS LAST, id LIMIT $1 OFFSET $2`,
      params
    );

    let items = rows.map(r => r.data);
    if (fields) {
      const pickSet = new Set(fields.split(',').map(s => s.trim()).filter(Boolean));
      items = items.map(p => {
        const out = {};
        for (const k of pickSet) out[k] = p?.[k];
        return out;
      });
    }

    res.status(200).json({ total, limit, offset, hasMore: offset + items.length < total, items });
  } catch (e) {
    console.error('GET /api/pnjs error:', e);
    res.status(500).json({ message: 'DB error' });
  }
});


// ✅ Resolve name (DOIT être avant /:id)
app.get('/api/pnjs/resolve', async (req, res) => {
  res.set('Content-Type', 'application/json; charset=utf-8');
  const raw = (req.query.name || '').toString().trim();
  if (!raw) return res.status(200).json({ matches: [], exact: false });

  const norm = raw
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .replace(/[^\p{L}\p{N}\s'-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const toKey = s => String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .replace(/[^\p{L}\p{N}\s'-]/gu, ' ')
    .replace(/\s+/g,' ')
    .trim()
    .toLowerCase();

  try {
    let rows = [];

    // 1) exact brut
    rows = (await pool.query(
      `SELECT data FROM pnjs
       WHERE trim(lower(data->>'name')) = trim(lower($1))
       LIMIT 1`,
      [raw]
    )).rows;

    // 2) prefix normalisé
    if (!rows.length) {
      rows = (await pool.query(
        `SELECT data FROM pnjs
         WHERE lower(data->>'name') LIKE lower($1)
         ORDER BY data->>'name'
         LIMIT 30`,
        [norm + '%']
      )).rows;
    }

    // 3) tokens AND
    if (!rows.length) {
      const tokens = norm.toLowerCase().split(/\s+/).filter(Boolean);
      if (tokens.length) {
        const wheres = tokens.map((_, i) => `lower(data->>'name') LIKE $${i+1}`);
        const params = tokens.map(t => `%${t}%`);
        rows = (await pool.query(
          `SELECT data FROM pnjs
           WHERE ${wheres.join(' AND ')}
           ORDER BY data->>'name'
           LIMIT 50`,
          params
        )).rows;
      }
    }

    // 4) contains
    if (!rows.length) {
      rows = (await pool.query(
        `SELECT data FROM pnjs
         WHERE lower(data->>'name') LIKE lower($1)
         ORDER BY data->>'name'
         LIMIT 50`,
        [`%${norm}%`]
      )).rows;
    }

    const qKey = toKey(norm);
    const qTokens = qKey.split(/\s+/).filter(Boolean);

    const score = (name) => {
      const k = toKey(name);
      const tokens = k.split(/\s+/).filter(Boolean);
      const starts = k.startsWith(qKey) ? 50 : 0;
      const exact  = (k === qKey) ? 100 : 0;
      const allAnd = qTokens.every(t => k.includes(t)) ? 20 : 0;
      const firstMatch = (tokens[0] && qTokens[0] && tokens[0] === qTokens[0]) ? 15 : 0;
      const lenPenalty = Math.min(10, Math.abs(k.length - qKey.length));
      return exact + starts + firstMatch + allAnd - lenPenalty;
    };

    const dedup = new Map();
    for (const r of rows) {
      if (!r?.data?.id) continue;
      if (!dedup.has(r.data.id)) dedup.set(r.data.id, r.data);
    }

    const candidates = Array.from(dedup.values());
    candidates.sort((a, b) => score(b.name) - score(a.name));

    const matches = candidates
      .map(p => ({ id: String(p.id), name: String(p.name || '') }))
      .slice(0, 10);

    const exact = matches.some(m => toKey(m.name) === qKey);
    return res.status(200).json({ matches, exact });
  } catch (e) {
    console.error('GET /api/pnjs/resolve error:', e);
    return res.status(500).json({ matches: [], exact: false, message: 'DB error' });
  }
});


// ✅ Recherche simple par nom (friendly GPT) (DOIT être avant /:id)
app.get('/api/pnjs/by-name', async (req, res) => {
  const q = (req.query.q || '').toString().trim();
  if (!q) return res.json({ matches: [] });

  try {
    const { rows } = await pool.query(
      `SELECT data FROM pnjs
       WHERE lower(data->>'name') LIKE lower($1)
       ORDER BY data->>'name'
       LIMIT 20`,
      [`%${q}%`]
    );

    const matches = rows
      .map(r => ({ id: r?.data?.id, name: r?.data?.name }))
      .filter(m => m.id);

    res.json({ matches });
  } catch (e) {
    console.error('GET /api/pnjs/by-name error:', e);
    res.status(500).json({ matches: [], message: 'DB error' });
  }
});


// ✅ GET par id (APRÈS les routes statiques)
// Garde-fou : si quelqu’un appelle /api/pnjs/resolve par erreur, on renvoie 404 proprement.
app.get('/api/pnjs/:id', async (req, res) => {
  try {
    const id = String(req.params.id || '').trim();

    // optionnel mais utile pour éviter les collisions si l’ordre est un jour cassé
    if (id === 'resolve' || id === 'by-name' || id === 'search') {
      return res.status(404).json({ message: 'Route PNJ invalide.' });
    }

    const r = await pool.query('SELECT data FROM pnjs WHERE id = $1', [id]);
    if (!r.rows.length) return res.status(404).json({ message: 'PNJ non trouvé.' });
    res.json(r.rows[0].data);
  } catch (e) {
    console.error('GET /api/pnjs/:id error:', e);
    res.status(500).json({ message: 'DB error' });
  }
});


// ✅ CREATE (INSERT only, pas d’upsert silencieux, UUID par défaut)
app.post('/api/pnjs', async (req, res) => {
  try {
    const p = req.body || {};

    // id robuste
    p.id = (p.id && String(p.id).trim()) ? String(p.id).trim() : crypto.randomUUID();

    // garde-fous minimum (évite PNJ "invisible")
    if (!p.name || !String(p.name).trim()) {
      return res.status(400).json({ message: "Champ 'name' obligatoire." });
    }
    p.name = String(p.name).trim();

    if (!p.level) p.level = 1;
    if (!Number.isFinite(p.xp)) p.xp = 0;
    p.stats = p.stats || {};

    await pool.query(
      'INSERT INTO pnjs (id, data) VALUES ($1, $2::jsonb)',
      [p.id, JSON.stringify(p)]
    );

    res.status(201).json(p);
  } catch (e) {
    // 23505 = unique_violation (id déjà existant)
    if (e && e.code === '23505') {
      return res.status(409).json({ message: "ID déjà existant. Utilise PUT/PATCH pour modifier, pas POST." });
    }
    console.error('POST /api/pnjs error:', e);
    res.status(500).json({ message: 'DB error' });
  }
});


// PATCH (deep merge, respecte lockedTraits)
app.patch('/api/pnjs/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const { rows } = await pool.query('SELECT data FROM pnjs WHERE id = $1', [id]);
    if (!rows.length) return res.status(404).json({ message: 'PNJ non trouvé.' });

    const current = rows[0].data;
    const incoming = req.body || {};

    // protection: on ne change jamais l'id, et on évite name null/vide
    if ('id' in incoming) delete incoming.id;
    if ('name' in incoming && (incoming.name == null || !String(incoming.name).trim())) delete incoming.name;

    const locks = new Set(current.lockedTraits || []);
    for (const f of locks) if (f in incoming) delete incoming[f];

    const merged = deepMerge(current, incoming);

    await pool.query(
      'UPDATE pnjs SET data = $2::jsonb WHERE id = $1',
      [id, JSON.stringify(merged)]
    );

    res.json(merged);
  } catch (e) {
    console.error('PATCH /api/pnjs/:id error:', e);
    res.status(500).json({ message: 'DB error' });
  }
});


// PUT (shallow merge, respecte lockedTraits)
app.put('/api/pnjs/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const { rows } = await pool.query('SELECT data FROM pnjs WHERE id = $1', [id]);
    if (!rows.length) return res.status(404).json({ message: 'PNJ non trouvé.' });

    const current = rows[0].data;
    const incoming = req.body || {};

    // protection: on ne change jamais l'id, et on évite name null/vide
    if ('id' in incoming) delete incoming.id;
    if ('name' in incoming && (incoming.name == null || !String(incoming.name).trim())) delete incoming.name;

    const locks = new Set(current.lockedTraits || []);
    for (const f of locks) if (f in incoming) delete incoming[f];

    const merged = { ...current, ...incoming, id };

    await pool.query(
      'UPDATE pnjs SET data = $2::jsonb WHERE id = $1',
      [id, JSON.stringify(merged)]
    );

    res.json(merged);
  } catch (e) {
    console.error('PUT /api/pnjs/:id error:', e);
    res.status(500).json({ message: 'DB error' });
  }
});


// DELETE unitaire
app.delete('/api/pnjs/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const r = await pool.query('DELETE FROM pnjs WHERE id = $1 RETURNING data', [id]);
    if (!r.rows.length) return res.status(404).json({ message: 'PNJ non trouvé.' });
    res.json({ deleted: r.rows[0].data });
  } catch (e) {
    console.error('DELETE /api/pnjs/:id error:', e);
    res.status(500).json({ message: 'DB error' });
  }
});


// =================== ENGINE (contexte pour GPT) ====================

// preload PNJ dans session
app.post('/api/engine/preload', async (req, res) => {
  const limit = Math.max(1, Math.min(parseInt(req.body?.limit ?? '100', 10), 200));
  const cursor = Math.max(0, parseInt(req.body?.cursor ?? '0', 10));
  const fields = (req.body?.fields || '').toString().trim();

  try {
    const totalRes = await pool.query('SELECT COUNT(*)::int AS n FROM pnjs');
    const total = totalRes.rows[0].n;

    const { rows } = await pool.query(
      `SELECT data FROM pnjs
       ORDER BY (data->>'name') NULLS LAST, id
       LIMIT $1 OFFSET $2`,
      [limit, cursor]
    );

    let items = rows.map(r => r.data);
    if (fields) {
      const pickSet = new Set(fields.split(',').map(s => s.trim()).filter(Boolean));
      items = items.map(p => {
        const out = {};
        for (const k of pickSet) out[k] = p[k];
        return out;
      });
    }

    const nextCursor = (cursor + items.length < total) ? cursor + items.length : null;

    const sid = String(req.body?.sid || 'default');
    const sess = await getOrInitSession(sid);
    sess.data.dossiersById = sess.data.dossiersById || {};
    for (const p of rows.map(r => r.data)) {
      sess.data.dossiersById[p.id] = continuityDossier(p);
    }
    await saveSession(sid, sess.data);

    res.json({ total, loaded: items.length, nextCursor, items });
  } catch (e) {
    console.error('POST /api/engine/preload error:', e);
    res.status(500).json({ message: 'DB error' });
  }
});

// PIN roster
app.post('/api/engine/pin', async (req, res) => {
  try {
    const sid = String(req.body?.sid || 'default');
    const pnjIds = Array.isArray(req.body?.pnjIds) ? req.body.pnjIds.map(String) : [];
    const sess = await getOrInitSession(sid);
    sess.data.pinRoster = pnjIds.slice(0, 8);
    await saveSession(sid, sess.data);
    res.json({ ok: true, pinRoster: sess.data.pinRoster });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'engine/pin error' });
  }
});

// Refresh roster épinglé
app.post('/api/engine/refresh', async (req, res) => {
  try {
    const sid = String(req.body?.sid || 'default');
    const sess = await getOrInitSession(sid);
    const ids = Array.isArray(sess.data.pinRoster) ? sess.data.pinRoster : [];
    const pnjs = await loadPnjsByIds(ids);
    const pnjCards = pnjs.map(compactCard);

    sess.data.dossiersById = sess.data.dossiersById || {};
    for (const p of pnjs) {
      sess.data.dossiersById[p.id] = continuityDossier(p);
    }
    await saveSession(sid, sess.data);

    res.json({
      ok: true,
      pnjCards,
      dossiers: ids.map(id => sess.data.dossiersById[id]).filter(Boolean),
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'engine/refresh error' });
  }
});

// CONTEXT (tour de jeu) — renvoie un gros systemHint pour le GPT
app.post('/api/engine/context', async (req, res) => {
  let sid = 'default';
  try {
    const body = req.body || {};
    sid = body.sid || 'default';
    const userText = String(body.userText || '');

    const pnjIds = Array.isArray(body.pnjIds) ? body.pnjIds : [];
    const pnjNamesFromClient = Array.isArray(body.pnjNames)
      ? body.pnjNames
      : (body.name ? [String(body.name)] : []);

    const mentioned = [];
    const nameRegex = /\b([A-ZÀÂÄÇÉÈÊËÎÏÔÖÙÛÜŸ][\w’'\-]+(?:\s+[A-ZÀÂÄÇÉÈÊËÎÏÔÖÙÛÜŸ][\w’'\-]+)*)\b/g;
    let m;
    while ((m = nameRegex.exec(userText)) !== null) {
      const raw = m[1].trim();
      if (raw.length < 3) continue;
      if (['Le','La','Les','Un','Une','Des','Dans','Et','Mais','Alors','Royaume','Cité','Académie'].includes(raw)) continue;
      mentioned.push(raw);
    }

    const allPnjNames = Array.from(new Set([
      ...pnjNamesFromClient,
      ...mentioned
    ].map(n => String(n).trim()).filter(Boolean)));

    console.log('[engine/context] sid=%s userText="%s" pnjIds=%j pnjNames=%j (auto=%j)',
      sid,
      userText.slice(0, 120),
      pnjIds,
      pnjNamesFromClient,
      allPnjNames
    );

    const sess = await getOrInitSession(sid);

    const sessionCheck = await hydrateSessionPnjs(sess);
    if (sessionCheck.missing.length) {
      log('PNJ manquants en DB mais présents en session:', sessionCheck.missing);
    }

    const lastHashes = Array.isArray(sess.data.lastReplies)
      ? sess.data.lastReplies.slice(-3)
      : [];
    const token =
      Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);

    // 2) RÉSOLUTION PNJ
    let pnjs = [];

    if (pnjIds.length) {
      pnjs = await loadPnjsByIds(pnjIds);
    } else if (allPnjNames.length) {
      const found = [];
      for (const rawName of allPnjNames) {
        const raw = String(rawName || '').trim();
        if (!raw) continue;

        let rows = [];

        try {
          rows = (await pool.query(
            `SELECT data FROM pnjs
             WHERE trim(lower(data->>'name')) = trim(lower($1))
             LIMIT 1`,
            [raw]
          )).rows;
        } catch {}

        if (!rows.length) {
          try {
            rows = (await pool.query(
              `SELECT data FROM pnjs
               WHERE lower(data->>'name') LIKE lower($1)
               ORDER BY data->>'name'
               LIMIT 5`,
              [raw.replace(/\s+/g,' ').trim() + '%']
            )).rows;
          } catch {}
        }

        if (!rows.length) {
          try {
            rows = (await pool.query(
              `SELECT data FROM pnjs
               WHERE lower(data->>'name') LIKE lower($1)
               ORDER BY data->>'name'
               LIMIT 3`,
              [`%${raw}%`]
            )).rows;
          } catch {}
        }

        if (rows.length) {
          found.push(rows[0].data);
        }
      }

      const seen = new Set();
      pnjs = found.filter(p => {
        if (!p?.id) return false;
        if (seen.has(p.id)) return false;
        seen.add(p.id);
        return true;
      });
    } else {
      const txt = userText.toLowerCase();
      const tokens = Array.from(new Set(
        txt.split(/[^a-zàâçéèêëîïôùûüÿñœ'-]+/i)
          .map(t => t.trim())
          .filter(t => t.length >= 3)
      )).slice(0, 5);

      let rows = [];
      if (tokens.length) {
        const wheres = tokens.map((_, i) => `lower(data->>'name') LIKE $${i + 1}`);
        const params = tokens.map(t => `%${t}%`);
        try {
          rows = (
            await pool.query(
              `SELECT data FROM pnjs
               WHERE ${wheres.join(' AND ')}
               ORDER BY data->>'name'
               LIMIT 6`,
              params
            )
          ).rows;
        } catch {}
      }
      pnjs = rows.map(r => r.data);
    }

    // 3. fusion avec roster épinglé + tour précédent
    const pinned = Array.isArray(sess.data.pinRoster) ? sess.data.pinRoster : [];
    if (pinned.length) {
      const pinnedPnjs = await loadPnjsByIds(pinned);
      const existingIds = new Set(pnjs.map(p => p.id));
      for (const p of pinnedPnjs) {
        if (!existingIds.has(p.id)) pnjs.push(p);
      }
    }

    const prevCards = Array.isArray(sess.data.lastPnjCards) ? sess.data.lastPnjCards : [];
    if (prevCards.length) {
      const existingIds = new Set(pnjs.map(p => p.id));
      for (const c of prevCards) {
        if (!existingIds.has(c.id)) {
          const loaded = await loadPnjsByIds([c.id]);
          if (loaded.length) {
            pnjs.push(loaded[0]);
            existingIds.add(c.id);
          }
        }
      }
    }

    if (!pnjs.length && pinned.length) {
      pnjs = await loadPnjsByIds(pinned);
    }

    const providedIds = Array.isArray(body.pnjIds) ? body.pnjIds.map(String) : [];
    if (providedIds.length) {
      sess.data.pinRoster = providedIds.slice(0, 8);
      await saveSession(sid, sess.data);
    }

    const lastNotes = Array.isArray(sess.data.notes) ? sess.data.notes.slice(-5) : [];
    const memo = lastNotes.length
      ? `\nMEMO (résumés précédents):\n- ${lastNotes.join('\n- ')}\n`
      : '';

    const pnjCards = pnjs.slice(0, 8).map(compactCard);

    log('PNJ retenus pour la scène', pnjs.slice(0, 8).map(p => ({ id: p.id, name: p.name })));

    sess.data.dossiersById = sess.data.dossiersById || {};
    for (const p of pnjs.slice(0, 8)) {
      sess.data.dossiersById[p.id] = continuityDossier(p);
    }
    sess.data.lastPnjCards = pnjCards;
    await saveSession(sid, sess.data);

    const dossiers = pnjs.map(p => sess.data.dossiersById[p.id]).filter(Boolean);

    const activePnjs = pnjCards.slice(0, 3);
    const backgroundPnjs = pnjCards.slice(3);

    const rules = [
      'Toujours respecter lockedTraits.',
      "Ne jamais changer l'identité d'un PNJ (nom, race, relations clés).",
      'Évite les répétitions des 2 dernières répliques.',
      'Interdit de juste dire “La scène a eu lieu” — décrire la scène.',
      'Les PNJ de second plan peuvent réagir brièvement si c’est logique.',
    ].join(' ');

    const style = `
FORMAT VISUAL NOVEL STRICT (OBLIGATOIRE) :
- 1 PNJ = 1 bloc séparé par UNE LIGNE VIDE.
- Chaque bloc commence par le nom du PNJ **en gras** avec un emoji AVANT et APRÈS le nom.
- Après le nom : l’émotion entre *italiques*.
- Ensuite : la réplique du PNJ en **gras** et entre guillemets.
- INTERDICTION d’écrire plusieurs PNJ dans le même bloc.

STYLE PERSONNALISÉ DU MJ (OPTIONNEL) :
${narrativeStyle?.styleText || '(aucun style personnalisé défini pour le moment)'}
`.trim();

    const pnjDetails = pnjs.slice(0, 50).map(p => ({
      id: p.id,
      name: p.name,
      appearance: p.appearance,
      personalityTraits: p.personalityTraits,
      backstory: p.backstory,
      raceName: p.raceName || p.raceId,
      relations: p.relations || p.relationships || null,
      locationId: p.locationId,
      lockedTraits: p.lockedTraits || [],
    }));

    const anchors = dossiers
      .map(d => `- ${d.name}#${d.id} :: ${d.coreFacts.join(' | ')}`)
      .join('\n');

    const headerMeta = '🌩️ [Lieu] — [Date/Heure] — [Météo]\n';
    const roster = pnjCards.map(c => `${c.emoji || '🙂'} ${c.name}#${c.id}`).join(', ');

    const systemHint = `
${headerMeta}
STYLE (OBLIGATOIRE): ${style}
Le style doit être un **Visual Novel immersif et interactif**, avec blocs séparés. Les PNJ viennent de la base de données du MJ et leurs fiches font foi.

[ENGINE CONTEXT]
${memo}Session: ${sid}
Tour: ${Number(sess.data.turn || 0) + 1}
AntiLoopToken: ${token}

PNJ_ACTIFS (à faire parler dans cet ordre):
${activePnjs.map(c => `- ${c.emoji || '🙂'} ${c.name}#${c.id}`).join('\n')}

PNJ_SECOND_PLAN (présents, réactions brèves autorisées):
${backgroundPnjs.length ? backgroundPnjs.map(c => `- ${c.emoji || '🙂'} ${c.name}#${c.id}`).join('\n') : '(aucun)'}

ROSTER COMPLET:
${roster}

ANCHORS (continuité, à respecter AVANT d'écrire):
${anchors}

PNJ_DETAILS_FROM_DB (prioritaire si conflit):
${JSON.stringify(pnjDetails, null, 2)}

RÈGLES MJ:
${rules}
`.trim();

    const extraVNHint = `
TU ES LE MJ. TU DOIS JOUER LA SCÈNE, PAS LA RÉSUMER.

**FORMAT À SUIVRE :**

**{emoji} {NomPNJ} {emoji}** *({émotion courte})*
**"{réplique (1 à 4 phrases max)}"**

(ligne vide)

- 1 PNJ = 1 bloc
- tous les PNJ listés doivent parler au moins une fois
- PNJ_SECOND_PLAN = 1 phrase
- pas de PNJ inventé
`.trim();

    const fullBaseHint = `${systemHint}\n\n${extraVNHint}`;
    const previousHint = sess.data.lastSystemHint || '';
    const fullSystemHint = [
      fullBaseHint,
      previousHint.includes('[ENGINE CONTEXT]') ? '' : previousHint,
    ].filter(Boolean).join('\n\n');

    // maj session
    sess.data.lastSystemHint = fullSystemHint;
    sess.data.roster = Array.isArray(sess.data.roster) ? sess.data.roster : [];
    const existingIds = new Set(sess.data.roster.map(p => p.id));
    for (const p of pnjs) {
      if (!p?.id || existingIds.has(p.id)) continue;
      sess.data.roster.push(p);
    }
    sess.data.turn = Number(sess.data.turn || 0) + 1;
    await saveSession(sid, sess.data);

    return res.status(200).json({
      guard: { antiLoop: { token, lastHashes }, rules, style },
      pnjCards,
      dossiers,
      pnjDetails,
      systemHint: fullSystemHint,
      turn: sess.data.turn,
    });
  } catch (e) {
    console.error('engine/context error:', e);
    return res.status(500).json({
      guard: { antiLoop: { token: null, lastHashes: [] }, rules: '', style: '' },
      pnjCards: [],
      dossiers: [],
      pnjDetails: [],
      systemHint: '',
      turn: 0,
      error: 'engine/context error',
    });
  }
});

// Commit (historique + notes + maj PNJ depuis le GPT)
app.post('/api/engine/commit', async (req, res) => {
  try {
    const body = req.body || {};
    const sid = String(body.sid || 'default');
    const modelReply = String(body.modelReply || '').trim();
    const notes = String(body.notes || '').trim();
    const pnjUpdates = Array.isArray(body.pnjUpdates) ? body.pnjUpdates : [];
    const lock = body.lock || null;

    const sess = await getOrInitSession(sid);
    sess.data = sess.data || {};

    // historique anti-loop
    sess.data.lastReplies = Array.isArray(sess.data.lastReplies) ? sess.data.lastReplies : [];
    if (modelReply) {
      const fp = fingerprint(modelReply);
      sess.data.lastReplies.push(fp);
      if (sess.data.lastReplies.length > 10) {
        sess.data.lastReplies = sess.data.lastReplies.slice(-10);
      }
    }

    // notes MJ
    sess.data.notes = Array.isArray(sess.data.notes) ? sess.data.notes : [];
    if (notes) {
      sess.data.notes.push(notes);
      if (sess.data.notes.length > 50) {
        sess.data.notes = sess.data.notes.slice(-50);
      }
    }
// updates PNJ
if (pnjUpdates.length) {
  for (const upd of pnjUpdates) {
    const id = String(upd.id || '').trim();
    const patch = upd.patch || {};
    if (!id) continue;

    const r = await pool.query('SELECT data FROM pnjs WHERE id=$1', [id]);
    if (!r.rows.length) continue;

    const current = r.rows[0].data;
    const filteredPatch = stripLockedPatch(current, patch);

    // si patch devient vide -> on skip
    if (!filteredPatch || (typeof filteredPatch === 'object' && !Array.isArray(filteredPatch) && Object.keys(filteredPatch).length === 0)) {
      continue;
    }

    const merged = deepMerge(current, filteredPatch);

    await pool.query(
      'UPDATE pnjs SET data = $2::jsonb WHERE id = $1',
      [id, JSON.stringify(merged)]
    );

    console.log('[JDR][COMMIT] pnj updated', { sid, id, keys: Object.keys(filteredPatch || {}) });
  }
}


    // lock de traits
    if (lock && lock.id && Array.isArray(lock.fields) && lock.fields.length) {
      const id = String(lock.id);
      const r = await pool.query('SELECT data FROM pnjs WHERE id=$1', [id]);
      if (r.rows.length) {
        const p = r.rows[0].data;
        const set = new Set(p.lockedTraits || []);
        for (const f of lock.fields) set.add(String(f));
        p.lockedTraits = Array.from(set);
        await pool.query(
          'UPDATE pnjs SET data = $2::jsonb WHERE id = $1',
          [id, JSON.stringify(p)]
        );
      }
    }

    await saveSession(sid, sess.data);
    return res.json({ ok: true });
  } catch (err) {
    console.error('/api/engine/commit error:', err);
    return res.status(500).json({ ok: false, message: 'commit failed' });
  }
});

// =================== STYLE & CONTENT SETTINGS ===================
app.post('/api/style', async (req, res) => {
  try {
    const body = req.body || {};
    const styleText = String(body.styleText || '').trim();
    narrativeStyle = { styleText };

    await pool.query(
      `INSERT INTO settings (key, value)
       VALUES ('narrativeStyle', $1::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [JSON.stringify(narrativeStyle)]
    );

    res.json({ message: 'Style mis à jour et enregistré en base.', style: narrativeStyle });
  } catch (e) {
    console.error('POST /api/style error:', e);
    res.status(500).json({ message: 'DB error' });
  }
});

app.post('/api/settings/content', (req, res) => {
  const allowed = ['safe','mature','fade'];
  const lvl = (req.body?.explicitLevel || '').toLowerCase();
  contentSettings.explicitLevel = allowed.includes(lvl) ? lvl : contentSettings.explicitLevel;
  res.json({ explicitLevel: contentSettings.explicitLevel });
});

// =================== HEALTH ===================
app.get('/api/db/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'DB error' });
  }
});

app.get('/api/ping', (req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

app.get('/', (req, res) => {
  res.json({
    ok: true,
    message: 'JDR backend (GPT) est en ligne 🚀',
    endpoints: [
      '/api/ping',
      '/api/db/health',
      '/api/pnjs',
      '/api/pnjs/resolve',
      '/api/engine/context',
      '/api/engine/commit',
    ],
  });
});
// Recherche par nom avec chemin sans ambiguïté (pour GPT)
app.get('/api/pnjs/search/by-name', async (req, res) => {
  const q = (req.query.q || '').toString().trim();
  if (!q) return res.json({ matches: [] });

  try {
    const { rows } = await pool.query(
      `SELECT data FROM pnjs
       WHERE lower(data->>'name') LIKE lower($1)
       ORDER BY data->>'name'
       LIMIT 20`,
      [`%${q}%`]
    );

    const matches = rows.map(r => ({
      id: r.data.id,
      name: r.data.name,
    }));

    res.json({ matches });
  } catch (e) {
    console.error('GET /api/pnjs/search/by-name error:', e);
    res.status(500).json({ matches: [], message: 'DB error' });
  }
});
// =================== MEMORY PERSISTANTE ====================

// SAVE MEMORY
app.post('/api/memory/save', async (req, res) => {
  const { sid = "main", key, value } = req.body;
  if (!key || !value) {
    return res.status(400).json({ ok: false, message: "key/value manquant" });
  }

  try {
    await pool.query(
      `INSERT INTO memories (sid, key, value)
       VALUES ($1, $2, $3)
       ON CONFLICT (sid, key) DO UPDATE SET value = $3, updated_at = NOW()`,
      [sid, key, value]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error('POST /api/memory/save error:', e);
    res.status(500).json({ ok: false, message: "DB error" });
  }
});

// GET MEMORY
app.get('/api/memory/get', async (req, res) => {
  const sid = req.query.sid || "main";

  try {
    const { rows } = await pool.query(
      `SELECT key, value FROM memories WHERE sid = $1`,
      [sid]
    );
    res.json({ memories: rows });
  } catch (e) {
    console.error('GET /api/memory/get error:', e);
    res.status(500).json({ memories: [], message: "DB error" });
  }
});
app.post("/v1/chat/completions", async (req, res) => {
  try {
    const auth = req.headers.authorization || "";
    const key = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (process.env.ST_API_KEY && key !== process.env.ST_API_KEY) {
      return res.status(401).json({ error: { message: "Unauthorized" } });
    }

    const body = req.body || {};
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const lastUser = [...messages].reverse().find(m => m?.role === "user")?.content || "";

    // ✅ pour l’instant: réponse de test (tu remplaceras ensuite par ton vrai MJ IA)
    const replyText = `✅ OK, je te reçois.\nTu dis: "${lastUser}"\nQue fais-tu ?`;

    // --- STREAMING (SillyTavern aime ça) ---
    if (body.stream === true) {
      res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");

      const chunk = {
        id: "chatcmpl_st",
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: body.model || "proxy",
        choices: [{ index: 0, delta: { content: replyText }, finish_reason: null }],
      };

      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      res.write(`data: [DONE]\n\n`);
      return res.end();
    }

    // --- NON-STREAM ---
    return res.json({
      id: "chatcmpl_st",
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: body.model || "proxy",
      choices: [
        { index: 0, message: { role: "assistant", content: replyText }, finish_reason: "stop" }
      ],
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: { message: "Server error" } });
  }
});


// =================== OpenAI-compatible: models (pour SillyTavern) ===================
app.get('/v1/models', (req, res) => {
  // Optionnel: même auth que chat/completions
  const auth = req.headers.authorization || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const key = bearer || (req.headers['x-api-key'] || '');
  const expected = process.env.ST_API_KEY || '';

  if (expected && String(key) !== String(expected)) {
    return res.status(401).json({ error: { message: 'Unauthorized' } });
  }

  res.json({
    object: 'list',
    data: [
      { id: 'gpt-3.5-turbo', object: 'model' },
      { id: 'gpt-4-turbo', object: 'model' },
      { id: 'mj-engine', object: 'model' }
    ]
  });
});
app.get('/api/db/whoami', async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT
        current_database() as db,
        current_user as usr,
        inet_server_addr() as server_addr,
        inet_server_port() as server_port,
        version() as version
    `);
    res.json({ ok: true, ...r.rows[0] });
  } catch (e) {
    console.error('GET /api/db/whoami error:', e);
    res.status(500).json({ ok: false, message: 'DB error' });
  }
});

// ---------------- Lancement ----------------
app.listen(port, () => {
  console.log(`JDR API en ligne sur http://localhost:${port}`);
});











