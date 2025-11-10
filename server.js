// ==== JDR Backend (PNJ Postgres + CRUD + Contexte narratif robuste + Canon + Backups + Style en DB) ====
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const { Pool } = require('pg');

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
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('localhost')
    ? false
    : { rejectUnauthorized: false },
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

// ---------- Mémoire légère (fichiers locaux) ----------
let storyState = safeRequire('./storyState.json', {});
let narrativeStyle = { styleText: '' }; // sera rechargé depuis la table settings
let contentSettings = { explicitLevel: 'mature' }; // 'safe' | 'mature' | 'fade'

const racesPath = './races.json';
let races = safeRequire('./races.json', []);
function saveRaces() {
  try { fs.writeFileSync(racesPath, JSON.stringify(races, null, 2), 'utf-8'); }
  catch (e) { console.error("Erreur d'écriture races.json:", e); }
}
function safeRequire(path, fallback) {
  try { if (fs.existsSync(path)) return require(path); } catch {}
  return fallback;
}
function slugifyId(str) {
  return String(str || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .replace(/[^a-z0-9]+/g,'-')
    .replace(/(^-|-$)/g,'') || Date.now().toString();
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
    // ← AJOUT : table pour stocker le style
    await pool.query(`
      CREATE TABLE IF NOT EXISTS settings (
        key   TEXT PRIMARY KEY,
        value JSONB NOT NULL
      );
    `);

    // ← AJOUT : on essaie de recharger le style s’il existe déjà
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

    console.log('Tables pnjs, canon_profiles, sessions, settings OK');
  } catch (e) {
    console.error('DB init failed:', e);
  }
})();

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

function softenStyle(text, level = 'mature') {
  if (level === 'safe') {
    return text.replace(/\b(lécher|peloter|gémir|haleter|mordre sensuellement)\b/gi, 'regarder tendrement')
      .concat('\n\n(La narration reste sobre et pudique.)');
  }
  if (level === 'fade') {
    return text.replace(/(.{0,200})(tension|désir|baiser(s)? fougueux|corps serrés).*/i,
      '$1 La tension monte… la scène s’interrompt avec pudeur.');
  }
  return text
    .replace(/\b(\w*nu(e|s)?|orgasm(e|ique)|pénétration|explicit(e|s)?)\b/gi, 'intense')
    .concat('\n\n(La scène reste suggestive, sans détails graphiques.)');
}

function pick(obj, fieldsCsv) {
  const f = new Set(String(fieldsCsv || '').split(',').map(s => s.trim()).filter(Boolean));
  if (!f.size) return obj;
  const out = {};
  for (const k of f) out[k] = obj[k];
  return out;
}

// ======================= BIBLIOTHÈQUE CANON =======================
const CANON_LIB = {
  tensura: {
    meta: { label: "That Time I Got Reincarnated as a Slime (Tensura)" },
    baseStats: { hp: 120, mp: 150, strength: 14, defense: 12, magic: 18, speed: 14, resistance: 16, charisma: 12 },
    skills: [
      { name: "Great Sage", type: "unique", effect: "Analyse et conseils tactiques" },
      { name: "Predator", type: "unique", effect: "Absorption et acquisition de compétences" },
      { name: "Black Flame", type: "magic", effect: "Dégâts magiques de feu noir" },
      { name: "Full Body Reinforcement", type: "buff", effect: "Augmente stats globales" }
    ]
  },
  kumo: {
    meta: { label: "Kumo Desu ga, Nani ka?" },
    baseStats: { hp: 100, mp: 120, strength: 12, defense: 10, magic: 16, speed: 18, resistance: 14, charisma: 8 },
    skills: [
      { name: "Thread Control", type: "skill", effect: "Contrôle de fils/soie pour piéger" },
      { name: "Poison Synthesis", type: "skill", effect: "Créer/renforcer des poisons" },
      { name: "Appraisal", type: "utility", effect: "Évaluer ennemis/objets" },
      { name: "Parallel Minds", type: "unique", effect: "Pensées parallèles pour multi-tâches" }
    ]
  },
  shieldHero: {
    meta: { label: "The Rising of the Shield Hero" },
    baseStats: { hp: 140, mp: 80, strength: 10, defense: 20, magic: 10, speed: 10, resistance: 18, charisma: 12 },
    skills: [
      { name: "Shield Prison", type: "defense", effect: "Barrière protectrice" },
      { name: "Air Strike Shield", type: "defense", effect: "Bouclier à distance" },
      { name: "Iron Maiden", type: "ultimate", effect: "Dégâts massifs sous conditions de malédiction" },
      { name: "Curse Series", type: "curse", effect: "Pouvoirs de malédiction avec contreparties" }
    ]
  },
  overlord: {
    meta: { label: "Overlord" },
    baseStats: { hp: 160, mp: 200, strength: 16, defense: 16, magic: 22, speed: 12, resistance: 20, charisma: 18 },
    skills: [
      { name: "Super-Tier Magic", type: "magic", effect: "Sorts d’un niveau supérieur" },
      { name: "Undead Creation", type: "summon", effect: "Créer/contrôler morts-vivants" },
      { name: "Perfect Unknowable", type: "utility", effect: "Invisibilité/perception réduite" },
      { name: "Time Stop", type: "magic", effect: "Arrêt du temps (court)" }
    ]
  },
  dragonQuest: {
    meta: { label: "Dragon Quest" },
    baseStats: { hp: 110, mp: 90, strength: 15, defense: 12, magic: 12, speed: 14, resistance: 12, charisma: 10 },
    skills: [
      { name: "Frizz/Frizzle", type: "magic", effect: "Magie de feu basique/intermédiaire" },
      { name: "Heal/Moreheal", type: "healing", effect: "Soins basiques/intermédiaires" },
      { name: "Falcon Slash", type: "technique", effect: "Double frappe rapide" },
      { name: "Kazap", type: "magic", effect: "Puissante magie électrique" }
    ]
  }
};

function clone(v) { return JSON.parse(JSON.stringify(v)); }

function mergeCanonIntoPnj(p, canonProfile, opts = { mode: 'fill', franchise: null }) {
  const mode = opts.mode === 'overwrite' ? 'overwrite' : 'fill';
  const out = clone(p);

  if (canonProfile) {
    const c = canonProfile;
    for (const key of ['appearance','personalityTraits','skills','backstory','raceId','raceName','description']) {
      if (c[key] !== undefined) {
        if (mode === 'overwrite' || out[key] == null || (Array.isArray(out[key]) && !out[key].length)) out[key] = clone(c[key]);
      }
    }
  }

  if (opts.franchise && CANON_LIB[opts.franchise]) {
    const preset = CANON_LIB[opts.franchise];
    out.stats = out.stats || {};
    const statKeys = Object.keys(preset.baseStats || {});
    for (const k of statKeys) {
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

// =================== PNJ (PostgreSQL) ====================

// LISTE
app.get('/api/pnjs', async (req, res) => {
  res.set('Content-Type', 'application/json; charset=utf-8');
  const limitMax = 1000;
  const limit  = Math.min(parseInt(req.query.limit || '50', 10), limitMax);
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
      items = items.map(p => { const out = {}; for (const k of pickSet) out[k] = p[k]; return out; });
    }

    res.status(200).json({ total, limit, offset, hasMore: offset + items.length < total, items });
  } catch (e) {
    console.error('GET /api/pnjs error:', e);
    res.status(500).json({ message: 'DB error' });
  }
});

// BULK CREATE / UPSERT
app.post('/api/pnjs/bulk', async (req, res) => {
  try {
    const items = Array.isArray(req.body?.items) ? req.body.items : null;
    if (!items || !items.length) return res.status(400).json({ message: 'items[] requis' });
    if (items.length > 1000) return res.status(400).json({ message: 'Trop de PNJ (max 1000).' });

    const toUpsert = items.map((p) => {
      const pn = { ...(p || {}) };
      pn.id = pn.id || Date.now().toString() + Math.random().toString(36).slice(2,6);
      pn.level = Number.isFinite(pn.level) ? pn.level : 1;
      pn.xp = Number.isFinite(pn.xp) ? pn.xp : 0;
      pn.stats = pn.stats || {};
      return pn;
    });

    await pool.query('BEGIN');
    for (const p of toUpsert) {
      await pool.query(
        `INSERT INTO pnjs (id, data) VALUES ($1, $2::jsonb)
         ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data`,
        [p.id, JSON.stringify(p)]
      );
    }
    await pool.query('COMMIT');

    res.status(201).json({ created: toUpsert.length, items: toUpsert.map(x => ({ id: x.id, name: x.name })) });
  } catch (e) {
    console.error('POST /api/pnjs/bulk error:', e);
    try { await pool.query('ROLLBACK'); } catch {}
    res.status(500).json({ message: 'DB error (bulk)' });
  }
});

// /pnjs/by-ids
app.get('/api/pnjs/by-ids', async (req, res) => {
  try {
    const ids = String(req.query.ids || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!ids.length) return res.status(400).json({ message: 'ids requis' });
    const r = await pool.query('SELECT data FROM pnjs WHERE id = ANY($1::text[])', [ids]);
    const map = new Map(r.rows.map(x => [x.data.id, x.data]));
    res.json(ids.map(id => map.get(id)).filter(Boolean));
  } catch (e) { console.error(e); res.status(500).json({ message: 'DB error' }); }
});

// compact
app.get('/api/pnjs/compact', async (req, res) => {
  try {
    const ids = String(req.query.ids || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!ids.length) return res.status(400).json({ message: 'ids requis' });
    const r = await pool.query('SELECT data FROM pnjs WHERE id = ANY($1::text[])', [ids]);
    res.json(r.rows.map(x => compactCard(x.data)));
  } catch (e) { console.error(e); res.status(500).json({ message: 'DB error' }); }
});

app.get('/api/pnjs/count', async (req, res) => {
  try {
    const r = await pool.query('SELECT COUNT(*)::int AS n FROM pnjs');
    res.json({ total: r.rows[0].n });
  } catch (e) { res.status(500).json({ message: 'DB error' }); }
});

// resolve name
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
           LIMIT 30`,
          [norm + '%']
        )).rows;
      } catch {}
    }
    if (!rows.length) {
      const tokens = norm.toLowerCase().split(/\s+/).filter(Boolean);
      if (tokens.length) {
        const wheres = tokens.map((_, i) => `lower(data->>'name') LIKE $${i+1}`);
        const params = tokens.map(t => `%${t}%`);
        try {
          rows = (await pool.query(
            `SELECT data FROM pnjs
             WHERE ${wheres.join(' AND ')}
             ORDER BY data->>'name'
             LIMIT 50`,
            params
          )).rows;
        } catch {}
      }
    }
    if (!rows.length) {
      try {
        rows = (await pool.query(
          `SELECT data FROM pnjs
           WHERE lower(data->>'name') LIKE lower($1)
           ORDER BY data->>'name'
           LIMIT 50`,
          [`%${norm}%`]
        )).rows;
      } catch {}
    }

    const qKey = toKey(norm);
    const qTokens = qKey.split(/\s+/).filter(Boolean);
    const score = (name) => {
      const k = toKey(name);
      const tokens = k.split(/\s+/).filter(Boolean);
      const starts = k.startsWith(qKey) ? 50 : 0;
      const exact  = (k === qKey) ? 100 : 0;
      const allAnd = qTokens.every(t => k.includes(t)) ? 20 : 0;
      const firstMatch = (tokens[0] === qTokens[0]) ? 15 : 0;
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

    const matches = candidates.map(p => ({ id: String(p.id), name: String(p.name || '') })).slice(0, 10);
    const exact = matches.some(m => toKey(m.name) === qKey);
    return res.status(200).json({ matches, exact });
  } catch (e) {
    console.error('GET /api/pnjs/resolve error:', e);
    return res.status(500).json({ matches: [], exact: false, message: 'DB error' });
  }
});

// GET par id
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

// CREATE (upsert)
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
    console.error(e);
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
    const locks = new Set(current.lockedTraits || []);
    for (const f of locks) if (f in incoming) delete incoming[f];
    const merged = deepMerge(current, incoming);
    await pool.query(
      'UPDATE pnjs SET data = $2::jsonb WHERE id = $1',
      [id, JSON.stringify(merged)]
    );
    res.json(merged);
  } catch (e) {
    console.error(e);
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
    const locks = new Set(current.lockedTraits || []);
    for (const f of locks) if (f in incoming) delete incoming[f];
    const merged = { ...current, ...incoming, id };
    await pool.query(
      'UPDATE pnjs SET data = $2::jsonb WHERE id = $1',
      [id, JSON.stringify(merged)]
    );
    res.json(merged);
  } catch (e) {
    console.error(e);
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
    console.error(e);
    res.status(500).json({ message: 'DB error' });
  }
});

// DELETE en masse (par ids)
app.delete('/api/pnjs', async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
    if (!ids.length) return res.status(400).json({ message: 'ids[] requis' });
    await pool.query('DELETE FROM pnjs WHERE id = ANY($1::text[])', [ids]);
    res.json({ deletedIds: ids });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'DB error' });
  }
});

// POST safe — suppression unitaire par body {id}
app.post('/api/pnjs/delete', async (req, res) => {
  try {
    const id = String(req.body?.id || '').trim();
    if (!id) return res.status(400).json({ message: 'id requis' });
    const r = await pool.query('DELETE FROM pnjs WHERE id = $1 RETURNING data', [id]);
    if (!r.rows.length) return res.status(404).json({ message: 'PNJ non trouvé.' });
    res.json({ deleted: r.rows[0].data });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'DB error' });
  }
});

// POST safe — suppression multiple par body {ids: []}
app.post('/api/pnjs/bulk-delete', async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : [];
    if (!ids.length) return res.status(400).json({ message: 'ids[] requis' });
    await pool.query('DELETE FROM pnjs WHERE id = ANY($1::text[])', [ids]);
    res.json({ deletedIds: ids });
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
    await pool.query(
      'UPDATE pnjs SET data = $2::jsonb WHERE id = $1',
      [id, JSON.stringify(p)]
    );
    res.json(p);
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'DB error' });
  }
});

// Level-up
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

      if (p.level - oldLevel > 50) break; // sécurité anti-boucle
    }

    await pool.query(
      'UPDATE pnjs SET data = $2::jsonb WHERE id = $1',
      [id, JSON.stringify(p)]
    );

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

// Evolve
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

    await pool.query(
      'UPDATE pnjs SET data = $2::jsonb WHERE id = $1',
      [id, JSON.stringify(p)]
    );

    res.json(p);
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'DB error' });
  }
});

// Lock traits
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

    await pool.query(
      'UPDATE pnjs SET data = $2::jsonb WHERE id = $1',
      [id, JSON.stringify(p)]
    );

    res.json(p);
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'DB error' });
  }
});

// Bind canon
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

    await pool.query(
      'UPDATE pnjs SET data = $2::jsonb WHERE id = $1',
      [id, JSON.stringify(p)]
    );

    res.json(p);
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'DB error' });
  }
});

// Consistency PNJ vs canon
app.get('/api/pnjs/:id/consistency', async (req, res) => {
  try {
    const id = req.params.id;
    const pRes = await pool.query('SELECT data FROM pnjs WHERE id = $1', [id]);
    if (!pRes.rows.length) return res.status(404).json({ message: 'PNJ non trouvé' });
    const p = pRes.rows[0].data;

    if (!p.canonId) {
      return res.json({
        passed: true,
        conflicts: [],
        suggestions: ['Aucun canon lié.']
      });
    }

    const cRes = await pool.query('SELECT data FROM canon_profiles WHERE id = $1', [p.canonId]);
    if (!cRes.rows.length) {
      return res.json({
        passed: false,
        conflicts: [{
          field: 'canonId',
          expected: 'Profil existant',
          found: 'introuvable',
          severity: 'high'
        }],
        suggestions: ['Vérifier canonId']
      });
    }

    const c = cRes.rows[0].data;
    const conflicts = [];

    if (c.appearance && p.appearance && c.appearance !== p.appearance) {
      conflicts.push({
        field: 'appearance',
        expected: c.appearance,
        found: p.appearance,
        severity: 'medium'
      });
    }

    if (Array.isArray(c.personalityTraits) && Array.isArray(p.personalityTraits)) {
      const missing = c.personalityTraits.filter(t => !p.personalityTraits.includes(t));
      if (missing.length) {
        conflicts.push({
          field: 'personalityTraits',
          expected: c.personalityTraits.join(', '),
          found: p.personalityTraits.join(', '),
          severity: 'low'
        });
      }
    }

    if (Array.isArray(c.skills) && Array.isArray(p.skills)) {
      const cSkillNames = new Set(c.skills.map(s => s.name));
      const pSkillNames = new Set(p.skills.map(s => s.name));
      for (const s of cSkillNames) {
        if (!pSkillNames.has(s)) {
          conflicts.push({
            field: 'skills',
            expected: `inclure ${s}`,
            found: 'absent',
            severity: 'low'
          });
        }
      }
    }

    res.json({
      passed: conflicts.length === 0,
      conflicts,
      suggestions: []
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'DB error' });
  }
});

// Export JSON
app.get('/api/pnjs/export', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT data FROM pnjs');
    res.json(rows.map(r => r.data));
  } catch (e) {
    res.status(500).json({ message: 'DB error' });
  }
});

// =================== CANON PROFILES CRUD ===================
app.get('/api/canon', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT data FROM canon_profiles ORDER BY id');
    res.json(rows.map(r => r.data));
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'DB error' });
  }
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
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'DB error' });
  }
});

app.get('/api/canon/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const r = await pool.query('SELECT data FROM canon_profiles WHERE id=$1', [id]);
    if (!r.rows.length) return res.status(404).json({ message: 'Profil canon non trouvé' });
    res.json(r.rows[0].data);
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'DB error' });
  }
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
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'DB error' });
  }
});

app.delete('/api/canon/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const r = await pool.query('DELETE FROM canon_profiles WHERE id=$1 RETURNING data', [id]);
    if (!r.rows.length) return res.status(404).json({ message: 'Profil canon non trouvé' });
    res.json({ deleted: r.rows[0].data });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'DB error' });
  }
});

// =================== APPLY CANON → PNJ ===================
app.post('/api/pnjs/:id/apply-canon', async (req, res) => {
  try {
    const id = req.params.id;
    const { canonId = null, franchise = null, mode = 'fill' } = req.body || {};

    const pRes = await pool.query('SELECT data FROM pnjs WHERE id=$1', [id]);
    if (!pRes.rows.length) return res.status(404).json({ message: 'PNJ non trouvé' });
    const p = pRes.rows[0].data;

    let canonProfile = null;
    if (canonId) {
      const cRes = await pool.query('SELECT data FROM canon_profiles WHERE id=$1', [canonId]);
      if (!cRes.rows.length) return res.status(404).json({ message: 'Profil canon non trouvé' });
      canonProfile = cRes.rows[0].data;
    }

    const updated = mergeCanonIntoPnj(p, canonProfile, { mode, franchise });
    await pool.query(
      'UPDATE pnjs SET data=$2::jsonb WHERE id=$1',
      [id, JSON.stringify(updated)]
    );

    res.json(updated);
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'DB error' });
  }
});

// Bulk apply canon
app.post('/api/pnjs/apply-canon-bulk', async (req, res) => {
  try {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    const franchise = req.body?.franchise || null;
    const mode = req.body?.mode === 'overwrite' ? 'overwrite' : 'fill';
    if (!items.length) return res.status(400).json({ message: 'items[] requis' });
    if (items.length > 1000) return res.status(400).json({ message: 'Trop d’items (max 1000).' });

    await pool.query('BEGIN');
    const results = [];
    for (const it of items) {
      const id = String(it?.id || '');
      if (!id) continue;
      const pRes = await pool.query('SELECT data FROM pnjs WHERE id=$1', [id]);
      if (!pRes.rows.length) { results.push({ id, status: 'not_found' }); continue; }

      let canonProfile = null;
      if (it?.canonId) {
        const cRes = await pool.query('SELECT data FROM canon_profiles WHERE id=$1', [String(it.canonId)]);
        if (cRes.rows.length) canonProfile = cRes.rows[0].data;
      }

      const merged = mergeCanonIntoPnj(pRes.rows[0].data, canonProfile, { mode, franchise });
      await pool.query(
        'UPDATE pnjs SET data=$2::jsonb WHERE id=$1',
        [id, JSON.stringify(merged)]
      );
      results.push({ id, status: 'ok' });
    }
    await pool.query('COMMIT');

    res.json({ ok: true, updated: results });
  } catch (e) {
    console.error(e);
    try { await pool.query('ROLLBACK'); } catch {}
    res.status(500).json({ message: 'DB error' });
  }
});

// =================== RACES (CRUD fichier JSON) ====================
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

// =================== SESSIONS & CONTEXTE ====================

function fingerprint(text = '') {
  const s = String(text).toLowerCase().replace(/\s+/g,' ').slice(0, 500);
  let h = 0;
  for (let i=0;i<s.length;i++) h = (h*31 + s.charCodeAt(i))|0;
  return String(h >>> 0);
}

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

// ====== AJOUT : emojis décoratifs sans toucher la DB ======

// petit hash déterministe pour avoir toujours le même résultat à partir d'une chaîne
function hashToInt(str) {
  const s = String(str || '');
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) >>> 0;
  }
  return h;
}

// sélection d'emoji décoratifs
const DECOR_EMOJIS = [
  '🙂','😏','😠','🤔','🤗','😇','😎','🤨','🥴','🤡',
  '🔥','⚔️','❄️','🌸','🦊','🐉','🦋','🛡️','📜','💫'
];

// génère un emoji en fonction du pnj SANS écrire en base
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
    emoji: decorateEmojiForPnj(p), // ← ajout
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

// ====== AJOUT : vérifier / rafraîchir jusqu'à 50 PNJ en session ======
async function hydrateSessionPnjs(sess) {
  sess.data = sess.data || {};
  sess.data.dossiersById = sess.data.dossiersById || {};

  const knownIds = Object.keys(sess.data.dossiersById);
  const idsToLoad = knownIds.slice(0, 50);

  if (!idsToLoad.length) {
    return { loaded: 0, missing: [] };
  }

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

  return {
    loaded: rows.length,
    missing
  };
}

// ENGINE PRELOAD
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
      items = items.map(p => { const out = {}; for (const k of pickSet) out[k] = p[k]; return out; });
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
      dossiers: ids.map(id => sess.data.dossiersById[id]).filter(Boolean)
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'engine/refresh error' });
  }
});

// CONTEXT (tour de jeu) — version avec PNJ_ACTIFS / PNJ_SECOND_PLAN / VN
app.post('/api/engine/context', async (req, res) => {
  let sid = 'default';
  try {
    const body = req.body || {};
    sid = body.sid || 'default';
    const userText = String(body.userText || '');

    // 0) ce que le client envoie déjà
    const pnjIds = Array.isArray(body.pnjIds) ? body.pnjIds : [];
    const pnjNamesFromClient = Array.isArray(body.pnjNames)
      ? body.pnjNames
      : (body.name ? [String(body.name)] : []);

    // 0bis) détection de noms dans le texte
    const mentioned = [];
    const nameRegex = /\b([A-ZÀÂÄÇÉÈÊËÎÏÔÖÙÛÜŸ][\w’'\-]+(?:\s+[A-ZÀÂÄÇÉÈÊËÎÏÔÖÙÛÜŸ][\w’'\-]+)*)\b/g;
    let m;
    while ((m = nameRegex.exec(userText)) !== null) {
      const raw = m[1].trim();
      if (raw.length < 3) continue;
      if (['Le','La','Les','Un','Une','Des','Dans','Et','Mais','Alors','Royaume','Cité','Académie'].includes(raw)) continue;
      mentioned.push(raw);
    }

    // on fusionne client + détection
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

    // 1) session
    const sess = await getOrInitSession(sid);

    // 1bis) rafraîchir les PNJ connus
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
      // priorité aux ids envoyés
      pnjs = await loadPnjsByIds(pnjIds);
    } else if (allPnjNames.length) {
      // on essaie de résoudre TOUS les noms trouvés
      const found = [];
      for (const rawName of allPnjNames) {
        const raw = String(rawName || '').trim();
        if (!raw) continue;

        let rows = [];

        // exact
        try {
          rows = (await pool.query(
            `SELECT data FROM pnjs
             WHERE trim(lower(data->>'name')) = trim(lower($1))
             LIMIT 1`,
            [raw]
          )).rows;
        } catch {}

        // prefix
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

        // contains
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

      // dédupe par id
      const seen = new Set();
      pnjs = found.filter(p => {
        if (!p?.id) return false;
        if (seen.has(p.id)) return false;
        seen.add(p.id);
        return true;
      });

    } else {
      // fallback auto tout à la fin
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

    // ... et là tu continues avec ton point 3, 4, 5 etc.

    // ... et là tu continues avec ton point 3, 4, 5 etc.






    // ========= 3. fusion avec roster épinglé + tour précédent =========
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

    // fallback
    if (!pnjs.length && pinned.length) {
      pnjs = await loadPnjsByIds(pinned);
    }

    // update pinRoster si ids fournis
    const providedIds = Array.isArray(body.pnjIds) ? body.pnjIds.map(String) : [];
    if (providedIds.length) {
      sess.data.pinRoster = providedIds.slice(0, 8);
      await saveSession(sid, sess.data);
    }

    // ========= 4. mémo narratif bref =========
    const lastNotes = Array.isArray(sess.data.notes) ? sess.data.notes.slice(-5) : [];
    const memo = lastNotes.length
      ? `\nMEMO (résumés précédents):\n- ${lastNotes.join('\n- ')}\n`
      : '';


    // ========= 5. cartes compactes =========
    const pnjCards = pnjs.slice(0, 8).map(compactCard);

    log('PNJ retenus pour la scène', pnjs.slice(0, 8).map(p => ({ id: p.id, name: p.name })));

    // continuité
    sess.data.dossiersById = sess.data.dossiersById || {};
    for (const p of pnjs.slice(0, 8)) {
      sess.data.dossiersById[p.id] = continuityDossier(p);
    }
    sess.data.lastPnjCards = pnjCards;
    await saveSession(sid, sess.data);

    const dossiers = pnjs.map(p => sess.data.dossiersById[p.id]).filter(Boolean);

    // ========= 6. actifs / second plan =========
    const activePnjs = pnjCards.slice(0, 3);
    const backgroundPnjs = pnjCards.slice(3);

    // ========= 7. règles MJ + style =========
// ========= 7. règles MJ + style =========
const rules = [
  'Toujours respecter lockedTraits.',
  "Ne jamais changer l'identité d'un PNJ (nom, race, relations clés).",
  'Évite les répétitions des 2 dernières répliques.',
  'Interdit d’écrire seulement “La scène a été jouée/enregistrée.” — écrire la scène complète.',
  'Les PNJ de second plan peuvent réagir brièvement si c’est logique.'
].join(' ');

// ⚠️ on impose NOTRE style, pas celui venu de la base
const style = `
FORMAT VISUAL NOVEL STRICT (OBLIGATOIRE) :
- 1 PNJ = 1 bloc séparé par UNE LIGNE VIDE.
- Chaque bloc commence par le nom du PNJ **en gras** avec un emoji AVANT et APRÈS le nom.
- Après le nom : l’émotion entre *italiques*.
- Ensuite : la réplique du PNJ en **gras** et entre guillemets.
- INTERDICTION d’écrire plusieurs PNJ dans le même bloc.
`.trim();


    // ========= 7bis. PNJ détaillés depuis la DB =========
    const pnjDetails = pnjs.slice(0, 50).map(p => ({
      id: p.id,
      name: p.name,
      appearance: p.appearance,
      personalityTraits: p.personalityTraits,
      backstory: p.backstory,
      raceName: p.raceName || p.raceId,
      relations: p.relations || p.relationships || null,
      locationId: p.locationId,
      lockedTraits: p.lockedTraits || []
    }));

    // ========= 8. systemHint final (Style VN immersif + DB) =========
    const headerMeta = '🌩️ [Lieu] — [Date/Heure] — [Météo]\n';
    const roster = pnjCards.map(c => `${c.emoji || '🙂'} ${c.name}#${c.id}`).join(', ');

    const systemHint = `
${headerMeta}
STYLE (OBLIGATOIRE): ${style}
Le style doit être un **Visual Novel immersif et interactif**, avec blocs séparés, exactement comme dans l’exemple. Les PNJ viennent de la base de données du MJ et leurs fiches font foi. Ne JAMAIS contredire une relation ou un trait présent dans PNJ_DETAILS_FROM_DB.

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

    // 🔥 Style MJ forcé (Visual Novel complet, jouer la scène)
const extraVNHint = `
TU ES LE MJ. TU DOIS JOUER LA SCÈNE, PAS LA RÉSUMER.

FORMAT VISUAL NOVEL (OBLIGATOIRE) :

- 1 PNJ = 1 BLOC.
- 1 BLOC = exactement ceci :

**{emoji} {NomPNJ} {emoji}** *({émotion / réaction courte})*
**"{réplique du PNJ (1 à 4 phrases max)}"**

(ligne vide)

- TU DOIS mettre **une ligne vide** entre deux blocs, sinon le client ne peut pas l’afficher correctement.
- TU DOIS utiliser les PNJ dans l’ordre suivant :
  1. Tous ceux présents dans PNJ_ACTIFS
  2. Puis ceux de PNJ_SECOND_PLAN (1 phrase max)
- S’il y a 10 PNJ dans le contexte, tu écris 10 blocs (pas 3, pas 4).
- INTERDIT de fusionner plusieurs PNJ dans le même bloc.
- INTERDIT d’inventer un PNJ qui n’est pas dans la liste.
- Si un PNJ est cité dans le texte joueur et qu’il est dans PNJ_DETAILS_FROM_DB, tu le fais parler AU MOINS UNE FOIS.

RAPPEL MISE EN PAGE :
- Noms et répliques en **gras**
- émotions en *italique*
- guillemets autour de la réplique

EXEMPLE À SUIVRE :

**🌸 Kazuma Satou 🌸** *(triomphant, bras croisés)*
**"Franchement, sans moi, cette guilde serait déjà envahie par des crapauds géants."**

**🧨 Megumin 🧨** *(offusquée)*
**"Cesse de t’approprier mes exploits, vil pleutre !"**

**❄️ Aqua ❄️** *(pleurnicharde)*
**"Et moi je n’ai même pas de salaire divin… c’est injuste !"**

(etc.)

À LA FIN tu peux ajouter :
_Notes MJ : météo, tension, PNJ qui observe en silence._
`.trim();



const fullBaseHint = `${systemHint}\n\n${extraVNHint}`;
const previousHint = sess.data.lastSystemHint || '';
const fullSystemHint = [
  fullBaseHint,
  previousHint.includes('[ENGINE CONTEXT]') ? '' : previousHint
].filter(Boolean).join('\n\n');

sess.data.lastSystemHint = fullSystemHint;
await saveSession(sid, sess.data);
// 🔧 Fusionne PNJ trouvés avec ceux déjà connus dans la session
sess.data.roster = Array.isArray(sess.data.roster) ? sess.data.roster : [];
const existingIds = new Set(sess.data.roster.map(p => p.id));
for (const p of pnjs) {
  if (!p?.id || existingIds.has(p.id)) continue;
  sess.data.roster.push(p);
}
await saveSession(sid, sess.data);

    return res.status(200).json({
      guard: { antiLoop: { token, lastHashes }, rules, style },
      pnjCards,
      dossiers,
      pnjDetails,
      systemHint: fullSystemHint,
      turn: Number(sess.data.turn || 0) + 1
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
      error: 'engine/context error'
    });
  }
});




// (Étape 2) Commit de la scène générée par le modèle
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

    // historiser la dernière réponse du modèle (pour anti-loop)
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

    // éventuels updates PNJ envoyés par le client
    if (pnjUpdates.length) {
      for (const upd of pnjUpdates) {
        const id = String(upd.id || '').trim();
        const patch = upd.patch || {};
        if (!id) continue;
        const r = await pool.query('SELECT data FROM pnjs WHERE id=$1', [id]);
        if (!r.rows.length) continue;
        const current = r.rows[0].data;
        const merged = deepMerge(current, patch);
        await pool.query(
          'UPDATE pnjs SET data = $2::jsonb WHERE id = $1',
          [id, JSON.stringify(merged)]
        );
      }
    }

    // lock de traits depuis le client
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

    // sauver la session
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

// =================== ROLL (dés) ===================
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

// =================== PNJ COMBAT SNAPSHOT ===================
app.get('/api/pnjs/:id/compute-stats', async (req, res) => {
  try {
    const id = req.params.id;

    const r = await pool.query('SELECT data FROM pnjs WHERE id = $1', [id]);
    if (!r.rows.length) {
      return res.status(404).json({ message: 'PNJ non trouvé.' });
    }

    const p = r.rows[0].data || {};

    const snapshot = {
      id: p.id,
      name: p.name,
      level: p.level || 1,
      hp: p.stats?.hp ?? 100,
      mp: p.stats?.mp ?? 50,
      stats: p.stats || {},
      statusEffects: Array.isArray(p.statusEffects) ? p.statusEffects : []
    };

    res.json(snapshot);
  } catch (e) {
    console.error('GET /api/pnjs/:id/compute-stats error:', e);
    res.status(500).json({ message: 'Erreur interne du serveur' });
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

// =================== BACKUPS ===================
// Snapshot complet
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

// Restore (upsert)
app.post('/api/backup/restore', async (req, res) => {
  try {
    const {
      pnjs = [],
      canon = [],
      races: inRaces = null,
      sessions = []
    } = req.body || {};

    await pool.query('BEGIN');

    if (Array.isArray(pnjs)) {
      for (const p of pnjs) {
        const id = String(p.id || Date.now().toString() + Math.random().toString(36).slice(2,6));
        await pool.query(
          `INSERT INTO pnjs (id, data) VALUES ($1,$2::jsonb)
           ON CONFLICT (id) DO UPDATE SET data=EXCLUDED.data`,
          [id, JSON.stringify({ ...p, id })]
        );
      }
    }

    if (Array.isArray(canon)) {
      for (const c of canon) {
        const id = String(c.id || slugifyId(c.name || ('canon-' + Date.now())));
        await pool.query(
          `INSERT INTO canon_profiles (id, data) VALUES ($1,$2::jsonb)
           ON CONFLICT (id) DO UPDATE SET data=EXCLUDED.data`,
          [id, JSON.stringify({ ...c, id })]
        );
      }
    }

    if (Array.isArray(sessions)) {
      for (const s of sessions) {
        const id = String(s.id || 'default');
        const data = s.data || {};
        await pool.query(
          `INSERT INTO sessions (id, data) VALUES ($1,$2::jsonb)
           ON CONFLICT (id) DO UPDATE SET data=EXCLUDED.data`,
          [id, JSON.stringify(data)]
        );
      }
    }

    if (inRaces && Array.isArray(inRaces)) {
      races = inRaces;
      saveRaces();
    }

    await pool.query('COMMIT');

    res.json({
      ok: true,
      counts: {
        pnjs: pnjs.length,
        canon: canon.length,
        sessions: sessions.length,
        races: Array.isArray(inRaces) ? inRaces.length : undefined
      }
    });
  } catch (e) {
    console.error(e);
    try { await pool.query('ROLLBACK'); } catch {}
    res.status(500).json({ message: 'DB error' });
  }
});

app.get('/api/ping', (req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});
app.get('/', (req, res) => {
  res.json({
    ok: true,
    message: 'JDR backend est en ligne 🚀',
    endpoints: [
      '/api/ping',
      '/api/db/health',
      '/api/pnjs',
      '/api/engine/context',
      '/api/engine/commit'
    ]
  });
});

// ---------------- Lancement ----------------
app.listen(port, () => {
  console.log(`JDR API en ligne sur http://localhost:${port}`);
});
















