// ==== JDR Backend (PNJ Postgres + CRUD + Contexte narratif + Canon + Backups + Settings) ====
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const port = process.env.PORT || 3000;

// ---------- Middlewares ----------
app.use(cors());
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));

// ---------- DB ----------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('localhost')
    ? false
    : { rejectUnauthorized: false },
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

// on garde ces deux-là en mémoire, mais on les sauve aussi en DB
let narrativeStyle = { styleText: '' };
let contentSettings = { explicitLevel: 'mature' };

// ---------- Mémoire légère ----------
const racesPath = path.join(__dirname, 'races.json');
function safeRequire(p, fallback) {
  try {
    if (fs.existsSync(p)) return require(p);
  } catch {}
  return fallback;
}
let races = safeRequire(racesPath, []);
function saveRaces() {
  try {
    fs.writeFileSync(racesPath, JSON.stringify(races, null, 2), 'utf-8');
  } catch (e) {
    console.error("Erreur d'écriture races.json:", e);
  }
}
function slugifyId(str) {
  return String(str || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '') || Date.now().toString();
}

// ---------- Utils ----------
function parseDiceFormula(formula) {
  const m = (formula || '').trim().match(/^(\d+)d(\d+)([+-]\d+)?$/i);
  if (!m) return null;
  return {
    count: parseInt(m[1], 10),
    sides: parseInt(m[2], 10),
    modifier: m[3] ? parseInt(m[3], 10) : 0
  };
}
const rollOnce = s => Math.floor(Math.random() * s) + 1;

function deepMerge(base, update) {
  if (Array.isArray(base) || Array.isArray(update)) return update;
  if (base && typeof base === 'object' && update && typeof update === 'object') {
    const out = { ...base };
    for (const k of Object.keys(update)) out[k] = deepMerge(base[k], update[k]);
    return out;
  }
  return update === undefined ? base : update;
}
function clone(v) { return JSON.parse(JSON.stringify(v)); }

// ========== CANON LIB (courte) ==========
const CANON_LIB = {
  tensura: {
    meta: { label: "That Time I Got Reincarnated as a Slime (Tensura)" },
    baseStats: { hp: 120, mp: 150, strength: 14, defense: 12, magic: 18, speed: 14, resistance: 16, charisma: 12 },
    skills: [
      { name: "Great Sage", type: "unique", effect: "Analyse et conseils tactiques" },
      { name: "Predator", type: "unique", effect: "Absorption et acquisition de compétences" }
    ]
  }
};
function mergeCanonIntoPnj(p, canonProfile, opts = { mode: 'fill', franchise: null }) {
  const mode = opts.mode === 'overwrite' ? 'overwrite' : 'fill';
  const out = clone(p);
  if (canonProfile) {
    const c = canonProfile;
    for (const key of ['appearance','personalityTraits','skills','backstory','raceId','raceName','description']) {
      if (c[key] !== undefined) {
        const isEmpty = out[key] == null || (Array.isArray(out[key]) && !out[key].length);
        if (mode === 'overwrite' || isEmpty) out[key] = clone(c[key]);
      }
    }
  }
  if (opts.franchise && CANON_LIB[opts.franchise]) {
    const preset = CANON_LIB[opts.franchise];
    out.stats = out.stats || {};
    for (const k of Object.keys(preset.baseStats || {})) {
      if (mode === 'overwrite' || out.stats[k] == null) out.stats[k] = preset.baseStats[k];
    }
    const existing = new Set((out.skills || []).map(s => s.name));
    const mergedSkills = Array.isArray(out.skills) ? clone(out.skills) : [];
    for (const s of preset.skills || []) {
      if (!existing.has(s.name)) mergedSkills.push(clone(s));
    }
    out.skills = mergedSkills;
  }
  out.level = Number.isFinite(out.level) ? out.level : 1;
  out.xp = Number.isFinite(out.xp) ? out.xp : 0;
  out.stats = out.stats || { hp: 100, mp: 50, strength: 10, defense: 10, magic: 10, speed: 10, resistance: 10, charisma: 10 };
  return out;
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
      CREATE TABLE IF NOT EXISTS canon_profiles (
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

    // on recharge le style s'il existe
    try {
      const r = await pool.query(`SELECT value FROM settings WHERE key = 'narrativeStyle'`);
      if (r.rows.length) {
        narrativeStyle = r.rows[0].value;
        console.log('Style narratif chargé depuis la base.');
      }
    } catch (e) {
      console.log('Pas de style en base, on garde le défaut.');
    }

    console.log('Tables OK');
  } catch (e) {
    console.error('DB init failed:', e);
  }
})();

// =================== PNJ CRUD ===================
app.get('/api/pnjs', async (req, res) => {
  const limitMax = 1000;
  const limit = Math.min(parseInt(req.query.limit || '50', 10), limitMax);
  const offset = Math.max(parseInt(req.query.offset || '0', 10), 0);
  const q = (req.query.q || '').toString().trim();

  try {
    let total;
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

    res.json({
      total,
      limit,
      offset,
      hasMore: offset + rows.length < total,
      items: rows.map(r => r.data)
    });
  } catch (e) {
    console.error('GET /api/pnjs error:', e);
    res.status(500).json({ message: 'DB error' });
  }
});

app.post('/api/pnjs', async (req, res) => {
  try {
    const p = req.body || {};
    p.id = p.id || Date.now().toString();
    if (!p.level) p.level = 1;
    if (!Number.isFinite(p.xp)) p.xp = 0;
    p.stats = p.stats || {};
    await pool.query(
      'INSERT INTO pnjs (id, data) VALUES ($1, $2::jsonb) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data',
      [p.id, JSON.stringify(p)]
    );
    res.status(201).json(p);
  } catch (e) {
    console.error('POST /api/pnjs error:', e);
    res.status(500).json({ message: 'DB error' });
  }
});

app.get('/api/pnjs/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const r = await pool.query('SELECT data FROM pnjs WHERE id = $1', [id]);
    if (!r.rows.length) return res.status(404).json({ message: 'PNJ non trouvé.' });
    res.json(r.rows[0].data);
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'DB error' });
  }
});

app.patch('/api/pnjs/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const cur = await pool.query('SELECT data FROM pnjs WHERE id = $1', [id]);
    if (!cur.rows.length) return res.status(404).json({ message: 'PNJ non trouvé.' });

    const current = cur.rows[0].data;
    const incoming = req.body || {};
    const locks = new Set(current.lockedTraits || []);
    for (const f of locks) if (f in incoming) delete incoming[f];

    const merged = deepMerge(current, incoming);
    await pool.query('UPDATE pnjs SET data=$2::jsonb WHERE id=$1', [id, JSON.stringify(merged)]);
    res.json(merged);
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'DB error' });
  }
});

app.delete('/api/pnjs/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const r = await pool.query('DELETE FROM pnjs WHERE id = $1 RETURNING data', [id]);
    if (!r.rows.length) return res.status(404).json({ message: 'PNJ non trouvé.' });
    res.json({ deleted: r.rows[0].data });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'DB error' });
  }
});

// =================== STYLE ===================
app.post('/api/style', async (req, res) => {
  try {
    const style = req.body?.styleText || '';
    narrativeStyle = { styleText: style };
    await pool.query(
      `INSERT INTO settings (key, value)
       VALUES ('narrativeStyle', $1::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [JSON.stringify(narrativeStyle)]
    );
    res.json({ message: 'Style enregistré.', style: narrativeStyle });
  } catch (e) {
    console.error('POST /api/style error:', e);
    res.status(500).json({ message: 'DB error' });
  }
});

app.get('/api/style', (req, res) => {
  res.json(narrativeStyle);
});

// =================== ENGINE ===================
function compactCard(p) {
  return {
    id: p.id,
    name: p.name,
    appearance: p.appearance,
    personalityTraits: p.personalityTraits,
    backstoryHint: (p.backstory || '').slice(0, 200),
    skills: Array.isArray(p.skills) ? p.skills.map(s => s.name).slice(0, 8) : [],
    locationId: p.locationId,
    canonId: p.canonId,
    lockedTraits: p.lockedTraits
  };
}
async function getOrInitSession(sid) {
  const r = await pool.query('SELECT data FROM sessions WHERE id=$1', [sid]);
  if (!r.rows.length) {
    const data = { lastReplies: [], notes: [], dossiersById: {}, turn: 0 };
    await pool.query('INSERT INTO sessions (id, data) VALUES ($1, $2::jsonb)', [sid, JSON.stringify(data)]);
    return { id: sid, data };
  }
  return { id: sid, data: r.rows[0].data || { lastReplies: [], notes: [], dossiersById: {}, turn: 0 } };
}
async function saveSession(sid, data) {
  await pool.query(
    `INSERT INTO sessions (id, data) VALUES ($1,$2::jsonb)
     ON CONFLICT (id) DO UPDATE SET data=EXCLUDED.data`,
    [sid, JSON.stringify(data)]
  );
}

// preload (il était dans ton premier backend)
app.post('/api/engine/preload', async (req, res) => {
  const limit = Math.max(1, Math.min(parseInt(req.body?.limit ?? '100', 10), 200));
  const cursor = Math.max(0, parseInt(req.body?.cursor ?? '0', 10));
  const sid = String(req.body?.sid || 'default');

  try {
    const totalRes = await pool.query('SELECT COUNT(*)::int AS n FROM pnjs');
    const total = totalRes.rows[0].n;

    const { rows } = await pool.query(
      `SELECT data FROM pnjs
       ORDER BY (data->>'name') NULLS LAST, id
       LIMIT $1 OFFSET $2`,
      [limit, cursor]
    );

    const sess = await getOrInitSession(sid);
    sess.data.dossiersById = sess.data.dossiersById || {};
    for (const p of rows.map(r => r.data)) {
      sess.data.dossiersById[p.id] = {
        id: p.id,
        name: p.name,
        coreFacts: [
          p.raceName ? `Race: ${p.raceName}` : null,
          p.locationId ? `Loc: ${p.locationId}` : null
        ].filter(Boolean)
      };
    }
    await saveSession(sid, sess.data);

    const nextCursor = (cursor + rows.length < total) ? cursor + rows.length : null;

    res.json({
      total,
      loaded: rows.length,
      nextCursor,
      items: rows.map(r => r.data)
    });
  } catch (e) {
    console.error('POST /api/engine/preload error:', e);
    res.status(500).json({ message: 'DB error' });
  }
});

app.post('/api/engine/context', async (req, res) => {
  const sid = String(req.body?.sid || 'default');
  const userText = String(req.body?.userText || '');
  try {
    const sess = await getOrInitSession(sid);
    const { rows } = await pool.query(
      `SELECT data FROM pnjs ORDER BY (data->>'name') NULLS LAST, id LIMIT 8`
    );
    const pnjCards = rows.map(r => compactCard(r.data));
    const styleText = narrativeStyle?.styleText || 'Light novel immersif.';
    sess.data.turn = Number(sess.data.turn || 0) + 1;
    await saveSession(sid, sess.data);
    res.json({
      guard: { style: styleText },
      pnjCards,
      systemHint: `STYLE: ${styleText}\nUSER: ${userText}`,
      turn: sess.data.turn
    });
  } catch (e) {
    console.error('engine/context error:', e);
    res.status(500).json({ message: 'engine/context error' });
  }
});

// =================== ROLL ===================
app.post('/api/roll', (req, res) => {
  const { dice } = req.body || {};
  const p = parseDiceFormula(dice);
  if (!p) return res.status(400).json({ message: 'Formule invalide. Utilise NdM±K (ex: 1d20+3).' });
  const rolls = Array.from({ length: p.count }, () => rollOnce(p.sides));
  const total = rolls.reduce((a, b) => a + b, 0) + p.modifier;
  res.json({ result: total, rolls, modifier: p.modifier, formula: dice });
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

// ---------------- Lancement ----------------
app.listen(port, () => {
  console.log(`JDR API en ligne sur http://localhost:${port}`);
});
