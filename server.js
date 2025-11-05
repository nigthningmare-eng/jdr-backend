// ==== JDR Backend (PNJ Postgres + CRUD + Contexte narratif robuste + Canon + Backups + Settings + Files) ====
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { Pool } = require('pg');

const app = express();
const port = process.env.PORT || 3000;

// ---------- Middlewares ----------
app.use(cors());
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));

// ---------- Uploads (PDF, DOCX...) ----------
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}
const upload = multer({
  dest: uploadsDir,
  limits: { fileSize: 30 * 1024 * 1024 }
});

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

// mémoire runtime pour le style
let narrativeStyle = { styleText: '' };
let contentSettings = { explicitLevel: 'mature' };

// ---------- Helpers fichiers locaux ----------
function safeRequire(p, fallback) {
  try {
    if (fs.existsSync(p)) return require(p);
  } catch {}
  return fallback;
}
const racesPath = './races.json';
let races = safeRequire(racesPath, []);
function saveRaces() {
  try { fs.writeFileSync(racesPath, JSON.stringify(races, null, 2), 'utf-8'); }
  catch (e) { console.error("Erreur d'écriture races.json:", e); }
}
function slugifyId(str) {
  return String(str || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .replace(/[^a-z0-9]+/g,'-')
    .replace(/(^-|-$)/g,'') || Date.now().toString();
}

// ---------- Utils ----------
function parseDiceFormula(formula) {
  const m = (formula || '').trim().match(/^(\d+)d(\d+)([+-]\d+)?$/i);
  if (!m) return null;
  return { count: parseInt(m[1], 10), sides: parseInt(m[2], 10), modifier: m[3] ? parseInt(m[3], 10) : 0 };
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

function fingerprint(text = '') {
  const s = String(text).toLowerCase().replace(/\s+/g,' ').slice(0, 500);
  let h = 0;
  for (let i=0;i<s.length;i++) h = (h*31 + s.charCodeAt(i))|0;
  return String(h >>> 0);
}

// ---------- Canon lib (raccourci) ----------
const CANON_LIB = {
  tensura: {
    meta: { label: "That Time I Got Reincarnated as a Slime (Tensura)" },
    baseStats: { hp: 120, mp: 150, strength: 14, defense: 12, magic: 18, speed: 14, resistance: 16, charisma: 12 },
    skills: [
      { name: "Great Sage", type: "unique", effect: "Analyse et conseils tactiques" },
      { name: "Predator", type: "unique", effect: "Absorption de compétences" }
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
        const targetEmpty = out[key] == null || (Array.isArray(out[key]) && !out[key].length);
        if (mode === 'overwrite' || targetEmpty) out[key] = clone(c[key]);
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
    await pool.query(`
      CREATE TABLE IF NOT EXISTS files (
        id            TEXT PRIMARY KEY,
        original_name TEXT NOT NULL,
        stored_name   TEXT NOT NULL,
        mime_type     TEXT NOT NULL,
        size_bytes    INTEGER NOT NULL,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // recharger le style
    try {
      const r = await pool.query(`SELECT value FROM settings WHERE key = 'narrativeStyle'`);
      if (r.rows.length) {
        narrativeStyle = r.rows[0].value;
        console.log('Style narratif chargé depuis la base.');
      }
    } catch (e) {
      console.log('Aucun style narratif en base, on garde le défaut.');
    }

    console.log('Tables OK');
  } catch (e) {
    console.error('DB init failed:', e);
  }
})();

// =================== PNJ (PostgreSQL) ====================

// liste paginée
app.get('/api/pnjs', async (req, res) => {
  const limitMax = 1000;
  const limit  = Math.min(parseInt(req.query.limit || '50', 10), limitMax);
  const offset = Math.max(parseInt(req.query.offset || '0', 10), 0);
  const q = (req.query.q || '').toString().trim();
  const fields = (req.query.fields || '').toString().trim();

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

    let items = rows.map(r => r.data);
    if (fields) {
      const pickSet = new Set(fields.split(',').map(s => s.trim()).filter(Boolean));
      items = items.map(p => {
        const out = {};
        for (const k of pickSet) out[k] = p[k];
        return out;
      });
    }

    res.json({ total, limit, offset, hasMore: offset + items.length < total, items });
  } catch (e) {
    console.error('GET /api/pnjs error:', e);
    res.status(500).json({ message: 'DB error' });
  }
});

// create/upsert
app.post('/api/pnjs', async (req, res) => {
  try {
    const p = req.body || {};
    p.id = p.id || Date.now().toString();
    p.level = Number.isFinite(p.level) ? p.level : 1;
    p.xp = Number.isFinite(p.xp) ? p.xp : 0;
    p.stats = p.stats || {};
    await pool.query(
      `INSERT INTO pnjs (id, data) VALUES ($1, $2::jsonb)
       ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data`,
      [p.id, JSON.stringify(p)]
    );
    res.status(201).json(p);
  } catch (e) {
    console.error('POST /api/pnjs error:', e);
    res.status(500).json({ message: 'DB error' });
  }
});

// bulk
app.post('/api/pnjs/bulk', async (req, res) => {
  try {
    const items = Array.isArray(req.body?.items) ? req.body.items : null;
    if (!items || !items.length) return res.status(400).json({ message: 'items[] requis' });
    if (items.length > 1000) return res.status(400).json({ message: 'Trop de PNJ (max 1000).' });

    await pool.query('BEGIN');
    for (const p of items) {
      const pn = { ...(p || {}) };
      pn.id = pn.id || Date.now().toString() + Math.random().toString(36).slice(2,6);
      pn.level = Number.isFinite(pn.level) ? pn.level : 1;
      pn.xp = Number.isFinite(pn.xp) ? pn.xp : 0;
      pn.stats = pn.stats || {};
      await pool.query(
        `INSERT INTO pnjs (id, data) VALUES ($1, $2::jsonb)
         ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data`,
        [pn.id, JSON.stringify(pn)]
      );
    }
    await pool.query('COMMIT');
    res.status(201).json({ created: items.length });
  } catch (e) {
    console.error('POST /api/pnjs/bulk error:', e);
    try { await pool.query('ROLLBACK'); } catch {}
    res.status(500).json({ message: 'DB error (bulk)' });
  }
});

// by ids
app.get('/api/pnjs/by-ids', async (req, res) => {
  try {
    const ids = String(req.query.ids || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!ids.length) return res.status(400).json({ message: 'ids requis' });
    const r = await pool.query('SELECT data FROM pnjs WHERE id = ANY($1::text[])', [ids]);
    const map = new Map(r.rows.map(x => [x.data.id, x.data]));
    res.json(ids.map(id => map.get(id)).filter(Boolean));
  } catch (e) { console.error(e); res.status(500).json({ message: 'DB error' }); }
});

// resolve name
app.get('/api/pnjs/resolve', async (req, res) => {
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
    rows = (await pool.query(
      `SELECT data FROM pnjs
       WHERE trim(lower(data->>'name')) = trim(lower($1))
       LIMIT 1`,
      [raw]
    )).rows;
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
    const score = (name) => {
      const k = toKey(name);
      const starts = k.startsWith(qKey) ? 50 : 0;
      const exact  = (k === qKey) ? 100 : 0;
      const lenPenalty = Math.min(10, Math.abs(k.length - qKey.length));
      return exact + starts - lenPenalty;
    };
    const dedup = new Map();
    for (const r of rows) {
      if (!r?.data?.id) continue;
      if (!dedup.has(r.data.id)) dedup.set(r.data.id, r.data);
    }
    const candidates = Array.from(dedup.values());
    candidates.sort((a, b) => score(b.name) - score(a.name));
    const matches = candidates.map(p => ({ id: String(p.id), name: String(p.name || '') })).slice(0, 10);
    const exact = matches.some(m => toKey(m.name) === qKey);
    return res.status(200).json({ matches, exact });
  } catch (e) {
    console.error('GET /api/pnjs/resolve error:', e);
    return res.status(500).json({ matches: [], exact: false, message: 'DB error' });
  }
});

// count
app.get('/api/pnjs/count', async (req, res) => {
  try {
    const r = await pool.query('SELECT COUNT(*)::int AS n FROM pnjs');
    res.json({ total: r.rows[0].n });
  } catch (e) { res.status(500).json({ message: 'DB error' }); }
});

// get by id
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

// patch
app.patch('/api/pnjs/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const { rows } = await pool.query('SELECT data FROM pnjs WHERE id = $1', [id]);
    if (!rows.length) return res.status(404).json({ message: 'PNJ non trouvé.' });
    const current = rows[0].data;
    const incoming = req.body || {};
    const locks = new Set(current.lockedTraits || []);
    for (const f of locks) if (f in incoming) delete incoming[f];
    const merged = deepMerge(current, incoming);
    await pool.query('UPDATE pnjs SET data = $2::jsonb WHERE id = $1', [id, JSON.stringify(merged)]);
    res.json(merged);
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'DB error' });
  }
});

// delete
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

// XP
app.post('/api/pnjs/:id/award-xp', async (req, res) => {
  try {
    const xp = Number(req.body?.xp || 0);
    if (!Number.isFinite(xp) || xp <= 0) return res.status(400).json({ message: 'xp invalide' });
    const id = req.params.id;
    const { rows } = await pool.query('SELECT data FROM pnjs WHERE id = $1', [id]);
    if (!rows.length) return res.status(404).json({ message: 'PNJ non trouvé.' });
    const p = rows[0].data;
    p.xp = (p.xp || 0) + xp;
    await pool.query('UPDATE pnjs SET data = $2::jsonb WHERE id = $1', [id, JSON.stringify(p)]);
    res.json(p);
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'DB error' });
  }
});

// level-up
app.post('/api/pnjs/:id/level-up', async (req, res) => {
  try {
    const id = req.params.id;
    const { rows } = await pool.query('SELECT data FROM pnjs WHERE id = $1', [id]);
    if (!rows.length) return res.status(404).json({ message: 'PNJ non trouvé.' });
    const p = rows[0].data;
    p.level = p.level || 1;
    p.xp = p.xp || 0;
    p.stats = p.stats || {
      hp: 100, mp: 50, strength: 10, defense: 10, magic: 10,
      speed: 10, resistance: 10, charisma: 10
    };

    let oldLevel = p.level;
    let statIncreases = {
      hp: 0, mp: 0, strength: 0, defense: 0,
      magic: 0, speed: 0, resistance: 0, charisma: 0
    };

    const xpThreshold = lvl => 100 * lvl;
    while (p.xp >= xpThreshold(p.level)) {
      p.xp -= xpThreshold(p.level);
      p.level += 1;

      p.stats.hp += 5;           statIncreases.hp += 5;
      p.stats.mp += 5;           statIncreases.mp += 5;
      p.stats.strength += 1;     statIncreases.strength += 1;
      p.stats.defense += 1;      statIncreases.defense += 1;
      p.stats.magic += 1;        statIncreases.magic += 1;
      p.stats.speed += 1;        statIncreases.speed += 1;
      p.stats.resistance += 1;   statIncreases.resistance += 1;
      p.stats.charisma += 1;     statIncreases.charisma += 1;

      if (p.level - oldLevel > 50) break;
    }

    await pool.query('UPDATE pnjs SET data = $2::jsonb WHERE id = $1', [id, JSON.stringify(p)]);

    res.json({
      oldLevel,
      newLevel: p.level,
      xp: p.xp,
      xpToNext: Math.max(0, 100 * p.level - p.xp),
      statIncreases
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'DB error' });
  }
});

// evolve
app.post('/api/pnjs/:id/evolve', async (req, res) => {
  try {
    const id = req.params.id;
    const targetRaceId = String(req.body?.targetRaceId || '');
    if (!targetRaceId) return res.status(400).json({ message: 'targetRaceId requis' });

    const { rows } = await pool.query('SELECT data FROM pnjs WHERE id = $1', [id]);
    if (!rows.length) return res.status(404).json({ message: 'PNJ non trouvé.' });
    const p = rows[0].data;
    p.level = p.level || 1;
    p.evolutionHistory = Array.isArray(p.evolutionHistory) ? p.evolutionHistory : [];

    const currentRace = races.find(r => r.id === p.raceId);
    const targetRace = races.find(r => r.id === targetRaceId);
    if (!targetRace) return res.status(404).json({ message: 'Race cible inconnue' });

    let ok = false;
    if (currentRace && Array.isArray(currentRace.evolutionPaths)) {
      for (const path of currentRace.evolutionPaths) {
        if (path.toRaceId === targetRaceId) {
          const minLevel = path.minLevel || 0;
          if (p.level >= minLevel) ok = true;
        }
      }
    }
    if (!ok) return res.status(400).json({ message: 'Conditions d’évolution non remplies' });

    p.raceId = targetRace.id;
    p.raceName = targetRace.name;
    p.evolutionHistory.push(`${currentRace ? currentRace.id : 'unknown'} -> ${targetRace.id}`);

    await pool.query('UPDATE pnjs SET data = $2::jsonb WHERE id = $1', [id, JSON.stringify(p)]);
    res.json(p);
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'DB error' });
  }
});

// lock traits
app.post('/api/pnjs/:id/lock-traits', async (req, res) => {
  try {
    const id = req.params.id;
    const fields = Array.isArray(req.body?.fields) ? req.body.fields : null;
    if (!fields || !fields.length) return res.status(400).json({ message: 'fields[] requis' });

    const { rows } = await pool.query('SELECT data FROM pnjs WHERE id = $1', [id]);
    if (!rows.length) return res.status(404).json({ message: 'PNJ non trouvé' });

    const p = rows[0].data;
    const set = new Set(p.lockedTraits || []);
    for (const f of fields) set.add(String(f));
    p.lockedTraits = Array.from(set);

    await pool.query('UPDATE pnjs SET data = $2::jsonb WHERE id = $1', [id, JSON.stringify(p)]);
    res.json(p);
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'DB error' });
  }
});

// bind canon
app.post('/api/pnjs/:id/bind-canon', async (req, res) => {
  try {
    const id = req.params.id;
    const canonId = String(req.body?.canonId || '');
    if (!canonId) return res.status(400).json({ message: 'canonId requis' });

    const pRes = await pool.query('SELECT data FROM pnjs WHERE id = $1', [id]);
    if (!pRes.rows.length) return res.status(404).json({ message: 'PNJ non trouvé' });

    const cRes = await pool.query('SELECT data FROM canon_profiles WHERE id = $1', [canonId]);
    if (!cRes.rows.length) return res.status(404).json({ message: 'Profil canon non trouvé' });

    const p = pRes.rows[0].data;
    p.canonId = canonId;

    await pool.query('UPDATE pnjs SET data = $2::jsonb WHERE id = $1', [id, JSON.stringify(p)]);
    res.json(p);
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'DB error' });
  }
});

// =================== CANON PROFILES CRUD ===================
app.get('/api/canon', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT data FROM canon_profiles ORDER BY id');
    res.json(rows.map(r => r.data));
  } catch (e) { console.error(e); res.status(500).json({ message: 'DB error' }); }
});
app.post('/api/canon', async (req, res) => {
  try {
    const c = req.body || {};
    c.id = c.id || slugifyId(c.name || ('canon-' + Date.now()));
    await pool.query(
      `INSERT INTO canon_profiles (id, data) VALUES ($1, $2::jsonb)
       ON CONFLICT (id) DO UPDATE SET data=EXCLUDED.data`,
      [c.id, JSON.stringify(c)]
    );
    res.status(201).json(c);
  } catch (e) { console.error(e); res.status(500).json({ message: 'DB error' }); }
});
app.get('/api/canon/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const r = await pool.query('SELECT data FROM canon_profiles WHERE id=$1', [id]);
    if (!r.rows.length) return res.status(404).json({ message: 'Profil canon non trouvé' });
    res.json(r.rows[0].data);
  } catch (e) { console.error(e); res.status(500).json({ message: 'DB error' }); }
});
app.put('/api/canon/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const c = req.body || {};
    c.id = id;
    await pool.query(
      `INSERT INTO canon_profiles (id, data) VALUES ($1, $2::jsonb)
       ON CONFLICT (id) DO UPDATE SET data=EXCLUDED.data`,
      [id, JSON.stringify(c)]
    );
    res.json(c);
  } catch (e) { console.error(e); res.status(500).json({ message: 'DB error' }); }
});
app.delete('/api/canon/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const r = await pool.query('DELETE FROM canon_profiles WHERE id=$1 RETURNING data', [id]);
    if (!r.rows.length) return res.status(404).json({ message: 'Profil canon non trouvé' });
    res.json({ deleted: r.rows[0].data });
  } catch (e) { console.error(e); res.status(500).json({ message: 'DB error' }); }
});

// =================== RACES (fichier JSON) ====================
app.get('/api/races', (req, res) => res.json(races));
app.get('/api/races/:id', (req, res) => {
  const race = races.find(r => r.id === req.params.id);
  if (!race) return res.status(404).json({ message: 'Race non trouvée' });
  res.json(race);
});
app.post('/api/races', (req, res) => {
  const race = req.body || {};
  if (!race.name) return res.status(400).json({ message: 'name requis' });
  if (!race.id) race.id = slugifyId(race.name);
  if (races.some(r => r.id === race.id)) return res.status(409).json({ message: 'id déjà utilisé' });

  race.family = race.family || 'custom';
  race.canon = race.canon ?? false;
  race.baseStats = race.baseStats || {};
  race.evolutionPaths = race.evolutionPaths || [];

  races.push(race);
  saveRaces();
  res.status(201).json(race);
});
app.delete('/api/races/:id', (req, res) => {
  const i = races.findIndex(r => r.id === req.params.id);
  if (i === -1) return res.status(404).json({ message: 'Race non trouvée' });
  const removed = races.splice(i, 1)[0];
  saveRaces();
  res.json(removed);
});

// =================== SETTINGS / STYLE ===================
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

app.post('/api/settings/content', (req, res) => {
  const allowed = ['safe','mature','fade'];
  const lvl = (req.body?.explicitLevel || '').toLowerCase();
  contentSettings.explicitLevel = allowed.includes(lvl) ? lvl : contentSettings.explicitLevel;
  res.json({ explicitLevel: contentSettings.explicitLevel });
});

// =================== FILES (upload / list / download) ===================
app.post('/api/files/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'Aucun fichier reçu.' });

    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    await pool.query(
      `INSERT INTO files (id, original_name, stored_name, mime_type, size_bytes)
       VALUES ($1, $2, $3, $4, $5)`,
      [id, req.file.originalname, req.file.filename, req.file.mimetype, req.file.size]
    );

    res.status(201).json({
      id,
      originalName: req.file.originalname,
      mimeType: req.file.mimetype,
      size: req.file.size
    });
  } catch (e) {
    console.error('POST /api/files/upload error:', e);
    res.status(500).json({ message: 'DB error' });
  }
});

app.get('/api/files', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, original_name AS originalName, mime_type AS mimeType, size_bytes AS size, created_at AS createdAt
       FROM files
       ORDER BY created_at DESC
       LIMIT 100`
    );
    res.json(rows);
  } catch (e) {
    console.error('GET /api/files error:', e);
    res.status(500).json({ message: 'DB error' });
  }
});

app.get('/api/files/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const r = await pool.query(
      `SELECT original_name, stored_name, mime_type FROM files WHERE id = $1`,
      [id]
    );
    if (!r.rows.length) return res.status(404).json({ message: 'Fichier introuvable' });

    const file = r.rows[0];
    const filePath = path.join(uploadsDir, file.stored_name);
    if (!fs.existsSync(filePath)) return res.status(404).json({ message: 'Fichier manquant sur le disque' });

    res.setHeader('Content-Type', file.mime_type);
    res.setHeader('Content-Disposition', `attachment; filename="${file.original_name}"`);
    fs.createReadStream(filePath).pipe(res);
  } catch (e) {
    console.error('GET /api/files/:id error:', e);
    res.status(500).json({ message: 'Erreur serveur' });
  }
});

app.get('/api/files/:id/text', async (req, res) => {
  try {
    const id = req.params.id;
    const r = await pool.query(`SELECT original_name, stored_name, mime_type FROM files WHERE id=$1`, [id]);
    if (!r.rows.length) return res.status(404).json({ message: 'Fichier introuvable' });
    const file = r.rows[0];
    res.json({
      message: 'Extraction pas encore implémentée côté serveur.',
      file: {
        name: file.original_name,
        mime: file.mime_type
      }
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'Erreur serveur' });
  }
});

// =================== ENGINE (context, preload, pin, refresh, commit) ===================
function compactCard(p) {
  return {
    id: p.id,
    name: p.name,
    appearance: p.appearance,
    personalityTraits: p.personalityTraits,
    backstoryHint: (p.backstory || '').split('\n').slice(-2).join(' ').slice(0, 300),
    skills: Array.isArray(p.skills) ? p.skills.map(s => s.name).slice(0, 8) : [],
    locationId: p.locationId,
    canonId: p.canonId,
    lockedTraits: p.lockedTraits
  };
}
function continuityDossier(p) {
  return {
    id: p.id,
    name: p.name,
    coreFacts: [
      p.raceName || p.raceId ? `Race: ${p.raceName || p.raceId}` : null,
      Array.isArray(p.personalityTraits) && p.personalityTraits.length
        ? `Traits: ${p.personalityTraits.slice(0,5).join(', ')}`
        : null,
      p.locationId ? `Loc: ${p.locationId}` : null
    ].filter(Boolean)
  };
}
async function getOrInitSession(sid) {
  const r = await pool.query('SELECT data FROM sessions WHERE id=$1', [sid]);
  if (!r.rows.length) {
    const data = { lastReplies: [], notes: [], dossiersById: {}, turn: 0 };
    await pool.query('INSERT INTO sessions (id, data) VALUES ($1, $2::jsonb)', [sid, JSON.stringify(data)]);
    return { id: sid, data };
  }
  const data = r.rows[0].data || { lastReplies: [], notes: [], dossiersById: {}, turn: 0 };
  if (!data.dossiersById) data.dossiersById = {};
  return { id: sid, data };
}
async function saveSession(sid, data) {
  await pool.query(
    `INSERT INTO sessions (id, data) VALUES ($1,$2::jsonb)
     ON CONFLICT (id) DO UPDATE SET data=EXCLUDED.data`,
    [sid, JSON.stringify(data)]
  );
}

// PRELOAD (qu'on avait perdu)
app.post('/api/engine/preload', async (req, res) => {
  const limit = Math.max(1, Math.min(parseInt(req.body?.limit ?? '100', 10), 200));
  const cursor = Math.max(0, parseInt(req.body?.cursor ?? '0', 10));
  const sid = String(req.body?.sid || 'default');
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
      items = items.map(p => { const out = {}; for (const k of pickSet) out[k] = p[k]; return out; });
    }

    const sess = await getOrInitSession(sid);
    sess.data.dossiersById = sess.data.dossiersById || {};
    for (const p of rows.map(r => r.data)) {
      sess.data.dossiersById[p.id] = continuityDossier(p);
    }
    await saveSession(sid, sess.data);

    const nextCursor = (cursor + items.length < total) ? cursor + items.length : null;

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

// Refresh
app.post('/api/engine/refresh', async (req, res) => {
  try {
    const sid = String(req.body?.sid || 'default');
    const sess = await getOrInitSession(sid);
    const ids = Array.isArray(sess.data.pinRoster) ? sess.data.pinRoster : [];
    const r = await pool.query('SELECT data FROM pnjs WHERE id = ANY($1::text[])', [ids]);
    const pnjs = r.rows.map(x => x.data);
    const pnjCards = pnjs.map(compactCard);

    sess.data.dossiersById = sess.data.dossiersById || {};
    for (const p of pnjs) {
      sess.data.dossiersById[p.id] = continuityDossier(p);
    }
    await saveSession(sid, sess.data);

    res.json({
      ok: true,
      pnjCards,
      dossiers: ids.map(id => sess.data.dossiersById[id]).filter(Boolean)
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'engine/refresh error' });
  }
});

// CONTEXT principal
app.post('/api/engine/context', async (req, res) => {
  let sid = 'default';
  try {
    const body = req.body || {};
    sid = body.sid || 'default';
    const userText = String(body.userText || '');

    const sess = await getOrInitSession(sid);

    const { rows } = await pool.query(
      `SELECT data FROM pnjs ORDER BY (data->>'name') NULLS LAST, id LIMIT 8`
    );
    const pnjCards = rows.map(r => compactCard(r.data));

    const files = (await pool.query(
      `SELECT id, original_name AS originalName, mime_type AS mimeType
       FROM files
       ORDER BY created_at DESC
       LIMIT 10`
    )).rows;

    const styleText = narrativeStyle?.styleText || 'Light novel immersif.';
    const systemHint =
`STYLE: ${styleText}
USER: ${userText}
DOCS: ${files.map(f => `${f.originalName} (#${f.id})`).join(', ')}`;

    sess.data.turn = Number(sess.data.turn || 0) + 1;
    await saveSession(sid, sess.data);

    res.json({
      guard: { style: styleText },
      pnjCards,
      docs: files,
      systemHint,
      turn: sess.data.turn
    });
  } catch (e) {
    console.error('engine/context error:', e);
    res.status(500).json({ message: 'engine/context error' });
  }
});

// COMMIT
app.post('/api/engine/commit', async (req, res) => {
  try {
    const { sid, modelReply, notes, pnjUpdates, lock } = req.body || {};
    const scene = String(modelReply || '').trim();

    const metaPatterns = [
      'La scène a été jouée',
      'scène enregistrée',
      'Scène immersive lancée'
    ];
    const tooShort = scene.length < 100;
    const looksMeta = metaPatterns.some(p => scene.includes(p));
    if (tooShort || looksMeta) {
      return res.status(400).json({
        ok: false,
        message: 'modelReply invalide : la scène doit être rédigée, pas seulement annoncée.'
      });
    }

    const sess = await getOrInitSession(sid || 'default');

    const fp = fingerprint(scene);
    sess.data.lastReplies = Array.isArray(sess.data.lastReplies) ? sess.data.lastReplies : [];
    sess.data.lastReplies.push(fp);
    if (sess.data.lastReplies.length > 10) {
      sess.data.lastReplies = sess.data.lastReplies.slice(-10);
    }

    if (notes) {
      sess.data.notes = Array.isArray(sess.data.notes) ? sess.data.notes : [];
      sess.data.notes.push(String(notes).slice(0, 300));
      if (sess.data.notes.length > 50) {
        sess.data.notes = sess.data.notes.slice(-50);
      }
    }

    sess.data.turn = Number(sess.data.turn || 0) + 1;

    if (Array.isArray(pnjUpdates)) {
      for (const u of pnjUpdates) {
        const id = String(u?.id || '');
        const patch = u?.patch || {};
        if (!id || typeof patch !== 'object') continue;

        const cur = await pool.query('SELECT data FROM pnjs WHERE id=$1', [id]);
        if (!cur.rows.length) continue;

        const current = cur.rows[0].data;
        const locks = new Set(current.lockedTraits || []);
        const incoming = { ...patch };
        for (const f of locks) {
          if (f in incoming && JSON.stringify(incoming[f]) !== JSON.stringify(current[f])) {
            delete incoming[f];
          }
        }

        const merged = { ...current, ...incoming, id };
        await pool.query(
          'UPDATE pnjs SET data=$2::jsonb WHERE id=$1',
          [id, JSON.stringify(merged)]
        );
      }
    }

    if (lock && lock.id && Array.isArray(lock.fields) && lock.fields.length) {
      const id = String(lock.id);
      const cur = await pool.query('SELECT data FROM pnjs WHERE id=$1', [id]);
      if (cur.rows.length) {
        const p = cur.rows[0].data;
        const set = new Set(p.lockedTraits || []);
        for (const f of lock.fields) set.add(String(f));
        p.lockedTraits = Array.from(set);
        await pool.query(
          'UPDATE pnjs SET data=$2::jsonb WHERE id=$1',
          [id, JSON.stringify(p)]
        );
      }
    }

    await saveSession(sid || 'default', sess.data);

    res.json({ ok: true, turn: sess.data.turn, lastHash: fp });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'engine/commit error' });
  }
});

// =================== ROLL ===================
app.post('/api/roll', (req, res) => {
  const { dice } = req.body || {};
  const p = parseDiceFormula(dice);
  if (!p) {
    return res.status(400).json({
      message: 'Formule invalide. Utilise NdM±K (ex: 1d20+3).'
    });
  }
  const rolls = Array.from({ length: p.count }, () => rollOnce(p.sides));
  const total = rolls.reduce((a, b) => a + b, 0) + p.modifier;
  res.json({ result: total, rolls, modifier: p.modifier, formula: dice });
});

// =================== BACKUP (snapshot) ===================
app.get('/api/backup/snapshot', async (req, res) => {
  try {
    const pnjs = (await pool.query('SELECT data FROM pnjs')).rows.map(r => r.data);
    const canon = (await pool.query('SELECT data FROM canon_profiles')).rows.map(r => r.data);
    const sessions = (await pool.query('SELECT id, data FROM sessions')).rows.map(r => ({
      id: r.id,
      data: r.data
    }));
    res.json({
      pnjs,
      canon,
      races,
      sessions,
      generatedAt: new Date().toISOString()
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'DB error' });
  }
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
