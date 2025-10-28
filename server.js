// ==== JDR Backend (PNJ Postgres + CRUD + Contexte narratif robuste + Canon + Backups) ====
const express = require('express');
const cors = require('cors');
const fs = require('fs');
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
  max: 5,                 // Limite à 5 connexions simultanées (pour Neon)
  idleTimeoutMillis: 30000,      // Ferme les connexions inactives après 30s
  connectionTimeoutMillis: 10000 // Timeout si Neon met trop de temps à répondre
});

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
    console.log('Tables pnjs, canon_profiles, sessions OK');
  } catch (e) {
    console.error('DB init failed:', e);
  }
})();

// ---------- Mémoire légère (fichiers locaux) ----------
let storyState = safeRequire('./storyState.json', {});
let narrativeStyle = { styleText: '' }; // set via /api/style
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

// ======================= BIBLIOTHÈQUE CANON (stats & skills) =======================
// ⚠️ Exemples condensés/raisonnables pour tenir en taille — libre à toi d’enrichir.
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

  // 1) Applique profil canon (table canon_profiles) : appearance, traits, skills, backstory…
  if (canonProfile) {
    const c = canonProfile;
    for (const key of ['appearance','personalityTraits','skills','backstory','raceId','raceName','description']) {
      if (c[key] !== undefined) {
        if (mode === 'overwrite' || out[key] == null || (Array.isArray(out[key]) && !out[key].length)) out[key] = clone(c[key]);
      }
    }
  }

  // 2) Applique preset franchise (stats + compétences) si demandé
  if (opts.franchise && CANON_LIB[opts.franchise]) {
    const preset = CANON_LIB[opts.franchise];
    out.stats = out.stats || {};
    const statKeys = Object.keys(preset.baseStats || {});
    for (const k of statKeys) {
      if (mode === 'overwrite' || out.stats[k] == null) out.stats[k] = preset.baseStats[k];
    }
    // fusion compétences
    const existing = new Set((out.skills || []).map(s => s.name));
    const mergedSkills = Array.isArray(out.skills) ? clone(out.skills) : [];
    for (const s of preset.skills || []) {
      if (!existing.has(s.name)) mergedSkills.push(clone(s));
    }
    out.skills = mergedSkills;
  }

  // 3) Valeurs par défaut
  out.level = Number.isFinite(out.level) ? out.level : 1;
  out.xp = Number.isFinite(out.xp) ? out.xp : 0;
  out.stats = out.stats || { hp: 100, mp: 50, strength: 10, defense: 10, magic: 10, speed: 10, resistance: 10, charisma: 10 };

  return out;
}

// =================== PNJ (PostgreSQL) ====================
// LISTE paginée + projection + filtre SQL (limite max 1000)
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
    if (q) { params.push(`%${q}%`, `%${q}%`); where = `WHERE lower(data->>'name') LIKE lower($3) OR lower(data->>'description') LIKE lower($4)`; }

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

// BULK CREATE / UPSERT (jusqu’à 1000 PNJ)
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
  try { const r = await pool.query('SELECT COUNT(*)::int AS n FROM pnjs'); res.json({ total: r.rows[0].n }); }
  catch (e) { res.status(500).json({ message: 'DB error' }); }
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
  } catch (e) { console.error(e); res.status(500).json({ message: 'DB error' }); }
});

// CREATE (upsert)
app.post('/api/pnjs', async (req, res) => {
  try {
    const p = req.body || {};
    p.id = p.id || Date.now().toString();
    if (!p.level) p.level = 1;
    if (!Number.isFinite(p.xp)) p.xp = 0;
    p.stats = p.stats || {};
    await pool.query('INSERT INTO pnjs (id, data) VALUES ($1, $2::jsonb) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data', [p.id, JSON.stringify(p)]);
    res.status(201).json(p);
  } catch (e) { console.error(e); res.status(500).json({ message: 'DB error' }); }
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
    await pool.query('UPDATE pnjs SET data = $2::jsonb WHERE id = $1', [id, JSON.stringify(merged)]);
    res.json(merged);
  } catch (e) { console.error(e); res.status(500).json({ message: 'DB error' }); }
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
    await pool.query('UPDATE pnjs SET data = $2::jsonb WHERE id = $1', [id, JSON.stringify(merged)]);
    res.json(merged);
  } catch (e) { console.error(e); res.status(500).json({ message: 'DB error' }); }
});

// DELETE unitaire
app.delete('/api/pnjs/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const r = await pool.query('DELETE FROM pnjs WHERE id = $1 RETURNING data', [id]);
    if (!r.rows.length) return res.status(404).json({ message: 'PNJ non trouvé.' });
    res.json({ deleted: r.rows[0].data });
  } catch (e) { console.error(e); res.status(500).json({ message: 'DB error' }); }
});

// DELETE en masse (par ids) — méthode DELETE (corps JSON)
app.delete('/api/pnjs', async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
    if (!ids.length) return res.status(400).json({ message: 'ids[] requis' });
    await pool.query('DELETE FROM pnjs WHERE id = ANY($1::text[])', [ids]);
    res.json({ deletedIds: ids });
  } catch (e) { console.error(e); res.status(500).json({ message: 'DB error' }); }
});

// POST safe — suppression unitaire par body {id}
app.post('/api/pnjs/delete', async (req, res) => {
  try {
    const id = String(req.body?.id || '').trim();
    if (!id) return res.status(400).json({ message: 'id requis' });
    const r = await pool.query('DELETE FROM pnjs WHERE id = $1 RETURNING data', [id]);
    if (!r.rows.length) return res.status(404).json({ message: 'PNJ non trouvé.' });
    res.json({ deleted: r.rows[0].data });
  } catch (e) { console.error(e); res.status(500).json({ message: 'DB error' }); }
});

// POST safe — suppression multiple par body {ids: []}
app.post('/api/pnjs/bulk-delete', async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : [];
    if (!ids.length) return res.status(400).json({ message: 'ids[] requis' });
    await pool.query('DELETE FROM pnjs WHERE id = ANY($1::text[])', [ids]);
    res.json({ deletedIds: ids });
  } catch (e) { console.error(e); res.status(500).json({ message: 'DB error' }); }
});

// XP
app.post('/api/pnjs/:id/award-xp', async (req, res) => {
  try {
    const xp = Number(req.body?.xp || 0);
    if (!Number.isFinite(xp) || xp <= 0) return res.status(400).json({ message: 'xp invalide' });
    const id = req.params.id;
    const { rows } = await pool.query('SELECT data FROM pnjs WHERE id = $1', [id]);
    if (!rows.length) return res.status(404).json({ message: 'PNJ non trouvé.' });
    const p = rows[0].data; p.xp = (p.xp || 0) + xp;
    await pool.query('UPDATE pnjs SET data = $2::jsonb WHERE id = $1', [id, JSON.stringify(p)]);
    res.json(p);
  } catch (e) { console.error(e); res.status(500).json({ message: 'DB error' }); }
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
    p.stats = p.stats || { hp: 100, mp: 50, strength: 10, defense: 10, magic: 10, speed: 10, resistance: 10, charisma: 10 };

    let oldLevel = p.level;
    let statIncreases = { hp: 0, mp: 0, strength: 0, defense: 0, magic: 0, speed: 0, resistance: 0, charisma: 0 };
    const xpThreshold = lvl => 100 * lvl;
    while (p.xp >= xpThreshold(p.level)) {
      p.xp -= xpThreshold(p.level);
      p.level += 1;
      p.stats.hp += 5; statIncreases.hp += 5;
      p.stats.mp += 5; statIncreases.mp += 5;
      p.stats.strength += 1; statIncreases.strength += 1;
      p.stats.defense += 1; statIncreases.defense += 1;
      p.stats.magic += 1; statIncreases.magic += 1;
      p.stats.speed += 1; statIncreases.speed += 1;
      p.stats.resistance += 1; statIncreases.resistance += 1;
      p.stats.charisma += 1; statIncreases.charisma += 1;
      if (p.level - oldLevel > 50) break;
    }
    await pool.query('UPDATE pnjs SET data = $2::jsonb WHERE id = $1', [id, JSON.stringify(p)]);
    res.json({ oldLevel, newLevel: p.level, xp: p.xp, xpToNext: Math.max(0, 100 * p.level - p.xp), statIncreases });
  } catch (e) { console.error(e); res.status(500).json({ message: 'DB error' }); }
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

    p.raceId = targetRace.id; p.raceName = targetRace.name;
    p.evolutionHistory.push(`${currentRace ? currentRace.id : 'unknown'} -> ${targetRace.id}`);

    await pool.query('UPDATE pnjs SET data = $2::jsonb WHERE id = $1', [id, JSON.stringify(p)]);
    res.json(p);
  } catch (e) { console.error(e); res.status(500).json({ message: 'DB error' }); }
});

// Lock traits
app.post('/api/pnjs/:id/lock-traits', async (req, res) => {
  try {
    const id = req.params.id;
    const fields = Array.isArray(req.body?.fields) ? req.body.fields : null;
    if (!fields || !fields.length) return res.status(400).json({ message: 'fields[] requis' });

    const { rows } = await pool.query('SELECT data FROM pnjs WHERE id = $1', [id]);
    if (!rows.length) return res.status(404).json({ message: 'PNJ non trouvé' });

    const p = rows[0].data; const set = new Set(p.lockedTraits || []);
    for (const f of fields) set.add(String(f));
    p.lockedTraits = Array.from(set);

    await pool.query('UPDATE pnjs SET data = $2::jsonb WHERE id = $1', [id, JSON.stringify(p)]);
    res.json(p);
  } catch (e) { console.error(e); res.status(500).json({ message: 'DB error' }); }
});

// Bind canon
app.post('/api/pnjs/:id/bind-canon', async (req, res) => {
  try {
    const id = req.params.id; const canonId = String(req.body?.canonId || '');
    if (!canonId) return res.status(400).json({ message: 'canonId requis' });

    const pRes = await pool.query('SELECT data FROM pnjs WHERE id = $1', [id]);
    if (!pRes.rows.length) return res.status(404).json({ message: 'PNJ non trouvé' });

    const cRes = await pool.query('SELECT data FROM canon_profiles WHERE id = $1', [canonId]);
    if (!cRes.rows.length) return res.status(404).json({ message: 'Profil canon non trouvé' });

    const p = pRes.rows[0].data; p.canonId = canonId;
    await pool.query('UPDATE pnjs SET data = $2::jsonb WHERE id = $1', [id, JSON.stringify(p)]);
    res.json(p);
  } catch (e) { console.error(e); res.status(500).json({ message: 'DB error' }); }
});

// Consistency PNJ vs canon
app.get('/api/pnjs/:id/consistency', async (req, res) => {
  try {
    const id = req.params.id;
    const pRes = await pool.query('SELECT data FROM pnjs WHERE id = $1', [id]);
    if (!pRes.rows.length) return res.status(404).json({ message: 'PNJ non trouvé' });
    const p = pRes.rows[0].data;

    if (!p.canonId) return res.json({ passed: true, conflicts: [], suggestions: ['Aucun canon lié.'] });

    const cRes = await pool.query('SELECT data FROM canon_profiles WHERE id = $1', [p.canonId]);
    if (!cRes.rows.length) {
      return res.json({
        passed: false,
        conflicts: [{ field: 'canonId', expected: 'Profil existant', found: 'introuvable', severity: 'high' }],
        suggestions: ['Vérifier canonId']
      });
    }

    const c = cRes.rows[0].data; const conflicts = [];
    if (c.appearance && p.appearance && c.appearance !== p.appearance) {
      conflicts.push({ field: 'appearance', expected: c.appearance, found: p.appearance, severity: 'medium' });
    }
    if (Array.isArray(c.personalityTraits) && Array.isArray(p.personalityTraits)) {
      const missing = c.personalityTraits.filter(t => !p.personalityTraits.includes(t));
      if (missing.length) conflicts.push({ field: 'personalityTraits', expected: c.personalityTraits.join(', '), found: p.personalityTraits.join(', '), severity: 'low' });
    }
    if (Array.isArray(c.skills) && Array.isArray(p.skills)) {
      const cSkillNames = new Set(c.skills.map(s => s.name));
      const pSkillNames = new Set(p.skills.map(s => s.name));
      for (const s of cSkillNames) if (!pSkillNames.has(s)) conflicts.push({ field: 'skills', expected: `inclure ${s}`, found: 'absent', severity: 'low' });
    }

    res.json({ passed: conflicts.length === 0, conflicts, suggestions: [] });
  } catch (e) { console.error(e); res.status(500).json({ message: 'DB error' }); }
});

// Export JSON
app.get('/api/pnjs/export', async (req, res) => {
  try { const { rows } = await pool.query('SELECT data FROM pnjs'); res.json(rows.map(r => r.data)); }
  catch (e) { res.status(500).json({ message: 'DB error' }); }
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

// =================== APPLY CANON → PNJ ===================
// Unitaire : applique un profil canon ET/OU un preset franchise à un PNJ
// body: { canonId?: string, franchise?: 'tensura'|'kumo'|'shieldHero'|'overlord'|'dragonQuest', mode?: 'fill'|'overwrite' }
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
    await pool.query('UPDATE pnjs SET data=$2::jsonb WHERE id=$1', [id, JSON.stringify(updated)]);
    res.json(updated);
  } catch (e) { console.error(e); res.status(500).json({ message: 'DB error' }); }
});

// Bulk : applique un preset franchise (optionnel canonId par item)
// body: { items: [{ id, canonId? }], franchise?: '...', mode?: 'fill'|'overwrite' }
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
      await pool.query('UPDATE pnjs SET data=$2::jsonb WHERE id=$1', [id, JSON.stringify(merged)]);
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
app.get('/api/races/:id', (req, res) => { const race = races.find(r => r.id === req.params.id); if (!race) return res.status(404).json({ message: 'Race non trouvée' }); res.json(race); });
app.post('/api/races', (req, res) => {
  const race = req.body || {};
  if (!race.name) return res.status(400).json({ message: 'name requis' });
  if (!race.id) race.id = slugifyId(race.name);
  if (races.some(r => r.id === race.id)) return res.status(409).json({ message: 'id déjà utilisé' });
  race.family = race.family || 'custom'; race.canon = race.canon ?? false; race.baseStats = race.baseStats || {}; race.evolutionPaths = race.evolutionPaths || [];
  races.push(race); saveRaces(); res.status(201).json(race);
});
app.delete('/api/races/:id', (req, res) => { const i = races.findIndex(r => r.id === req.params.id); if (i === -1) return res.status(404).json({ message: 'Race non trouvée' }); const removed = races.splice(i, 1)[0]; saveRaces(); res.json(removed); });

// =================== SESSIONS & CONTEXTE ====================

// == Sessions helpers ==
function fingerprint(text = '') { const s = String(text).toLowerCase().replace(/\s+/g,' ').slice(0, 500); let h = 0; for (let i=0;i<s.length;i++) h = (h*31 + s.charCodeAt(i))|0; return String(h >>> 0); }
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
  await pool.query(`INSERT INTO sessions (id, data) VALUES ($1,$2::jsonb) ON CONFLICT (id) DO UPDATE SET data=EXCLUDED.data`, [sid, JSON.stringify(data)]);
}

async function loadPnjsByIds(ids = []) {
  const out = [];
  for (const id of ids) {
    const r = await pool.query('SELECT data FROM pnjs WHERE id=$1', [String(id)]);
    if (r.rows.length) out.push(r.rows[0].data);
  }
  return out;
}

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
      Array.isArray(p.personalityTraits) && p.personalityTraits.length ? `Traits: ${p.personalityTraits.slice(0,5).join(', ')}` : null,
      p.locationId ? `Loc: ${p.locationId}` : null
    ].filter(Boolean)
  };
}

// ===== ENGINE PRELOAD (chargement paginé des PNJ pour GPT & scripts) =====
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

// --- PIN / REFRESH DE CONTEXTE ---
app.post('/api/engine/pin', async (req, res) => {
  try {
    const sid = String(req.body?.sid || 'default');
    const pnjIds = Array.isArray(req.body?.pnjIds) ? req.body.pnjIds.map(String) : [];
    const sess = await getOrInitSession(sid);
    sess.data.pinRoster = pnjIds.slice(0, 8);
    await saveSession(sid, sess.data);
    res.json({ ok: true, pinRoster: sess.data.pinRoster });
  } catch (e) { console.error(e); res.status(500).json({ message: 'engine/pin error' }); }
});

// Recharge les PNJ épinglés
app.post('/api/engine/refresh', async (req, res) => {
  try {
    const sid = String(req.body?.sid || 'default');
    const sess = await getOrInitSession(sid);
    const ids = Array.isArray(sess.data.pinRoster) ? sess.data.pinRoster : [];
    const pnjs = await loadPnjsByIds(ids);
    const pnjCards = pnjs.map(compactCard);
    sess.data.dossiersById = sess.data.dossiersById || {};
    for (const p of pnjs) sess.data.dossiersById[p.id] = continuityDossier(p);
    await saveSession(sid, sess.data);
    res.json({ ok: true, pnjCards, dossiers: ids.map(id => sess.data.dossiersById[id]).filter(Boolean) });
  } catch (e) { console.error(e); res.status(500).json({ message: 'engine/refresh error' }); }
});

// CONTEXT: prépare le tour de jeu
app.post('/api/engine/context', async (req, res) => {
  let sid = 'default';
  try {
    const body = req.body || {};
    sid = body.sid || 'default';
    const userText = String(body.userText || '');
    const pnjIds = Array.isArray(body.pnjIds) ? body.pnjIds : [];
    const pnjNames = Array.isArray(body.pnjNames) ? body.pnjNames : (body.name ? [String(body.name)] : []);

    const sess = await getOrInitSession(sid);

    const lastHashes = Array.isArray(sess.data.lastReplies) ? sess.data.lastReplies.slice(-3) : [];
    const token = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);

    // Résolution normale
    let pnjs = [];
    if (pnjIds.length) {
      pnjs = await loadPnjsByIds(pnjIds);
    } else if (pnjNames.length) {
      const raw = String(pnjNames[0] || '').trim();
      if (raw) {
        let rows = [];
        try {
          rows = (await pool.query(`SELECT data FROM pnjs WHERE trim(lower(data->>'name')) = trim(lower($1)) LIMIT 1`, [raw])).rows;
        } catch {}
        if (!rows.length) {
          try {
            rows = (await pool.query(`SELECT data FROM pnjs WHERE lower(data->>'name') LIKE lower($1) ORDER BY data->>'name' LIMIT 5`, [raw.replace(/\s+/g,' ').trim() + '%'])).rows;
          } catch {}
        }
        if (!rows.length) {
          const tokens = raw.toLowerCase().split(/\s+/).filter(Boolean);
          if (tokens.length) {
            const wheres = tokens.map((_, i) => `lower(data->>'name') LIKE $${i+1}`);
            const params = tokens.map(t => `%${t}%`);
            try {
              rows = (await pool.query(`SELECT data FROM pnjs WHERE ${wheres.join(' AND ')} ORDER BY data->>'name' LIMIT 10`, params)).rows;
            } catch {}
          }
        }
        if (!rows.length) {
          try {
            const likeRow = (await pool.query(`SELECT (data->>'id') AS id FROM pnjs WHERE lower(data->>'name') LIKE lower($1) ORDER BY data->>'name' LIMIT 1`, [`%${raw}%`])).rows[0];
            if (likeRow?.id) pnjs = await loadPnjsByIds([likeRow.id]);
          } catch {}
        } else {
          pnjs = rows.map(r => r.data).slice(0, 3);
        }
      }
    } else {
      // Détection automatique depuis userText
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
              `SELECT data FROM pnjs WHERE ${wheres.join(' AND ')} ORDER BY data->>'name' LIMIT 6`,
              params
            )
          ).rows;
        } catch {}
      }
      if (!rows.length && tokens.length) {
        const top2 = [...tokens].sort((a,b)=>b.length-a.length).slice(0,2);
        const wheres = top2.map((_, i) => `lower(data->>'name') LIKE $${i + 1}`);
        const params = top2.map(t => `%${t}%`);
        try {
          rows = (
            await pool.query(
              `SELECT data FROM pnjs WHERE ${wheres.join(' AND ')} ORDER BY data->>'name' LIMIT 6`,
              params
            )
          ).rows;
        } catch {}
      }
      pnjs = rows.map(r => r.data);
    }

    // Réhydratation si rien + roster épinglé
    if (!pnjs.length) {
      const pinned = Array.isArray(sess.data.pinRoster) ? sess.data.pinRoster : [];
      if (pinned.length) {
        pnjs = await loadPnjsByIds(pinned);
      }
    }
    // Si ids fournis → maj pinRoster
    const providedIds = Array.isArray(body.pnjIds) ? body.pnjIds.map(String) : [];
    if (providedIds.length) {
      sess.data.pinRoster = providedIds.slice(0, 8);
      await saveSession(sid, sess.data);
    }
    // mémo
    const lastNotes = Array.isArray(sess.data.notes) ? sess.data.notes.slice(-5) : [];
    const memo = lastNotes.length
      ? `\nMEMO (résumés précédents):\n- ${lastNotes.join('\n- ')}\n`
      : '';

    const pnjCards = pnjs.slice(0, 8).map(compactCard);
    sess.data.dossiersById = sess.data.dossiersById || {};
    for (const p of pnjs.slice(0, 8)) {
      sess.data.dossiersById[p.id] = continuityDossier(p);
    }
    await saveSession(sid, sess.data);
    const dossiers = pnjs.map(p => sess.data.dossiersById[p.id]).filter(Boolean);

    const rules = [
      'Toujours respecter lockedTraits.',
      "Ne jamais changer l'identité d'un PNJ (Nom, race, relations clés).",
      'Évite les répétitions (ne recopie pas mot pour mot les 2 dernières répliques).',
      'Si doute, demande une micro-clarification.'
    ].join(' ');

    const styleText = String(narrativeStyle?.styleText || '').trim();
    const contentGuard = `Niveau contenu: ${contentSettings?.explicitLevel || 'mature'} (pas de détails graphiques).`;
    const style = [styleText || 'Light novel isekai, sobre, immersif.', contentGuard].join(' ');

    const roster = pnjCards.map(c => `${c.name}#${c.id}`).join(', ');
    const anchors = dossiers.map(d => `- ${d.name}#${d.id} :: ${d.coreFacts.join(' | ')}`).join('\n');

    const systemHint =
`[ENGINE CONTEXT]
${memo}Session: ${sid}
Tour: ${Number(sess.data.turn || 0) + 1}
AntiLoopToken: ${token}

STYLE: ${style}

ROSTER: ${roster}

ANCHORS (continuité):
${anchors}

Do/Don't: ${rules}

PNJ cards:
${pnjCards.map(c => `- ${c.name}#${c.id}
  traits: ${JSON.stringify(c.personalityTraits || [])}
  locked: ${JSON.stringify(c.lockedTraits || [])}
  backstoryHint: ${c.backstoryHint || '(n/a)'}
  skills: ${JSON.stringify(c.skills || [])}
  location: ${c.locationId || '(n/a)'}
`).join('\n')}

Si plusieurs PNJ correspondent, utilise le premier de la liste (ou demande une micro-clarification au joueur).

Format:
# [Lieu] — [Date/Heure]

**🙂 NomPNJ** *(émotion)*
**Réplique en gras...**

_Notes MJ (courtes)_: [événements | verrous | xp]`;

    return res.status(200).json({
      guard: { antiLoop: { token, lastHashes }, rules, style },
      pnjCards,
      dossiers,
      systemHint,
      turn: Number(sess.data.turn || 0) + 1
    });
  } catch (e) {
    console.error('engine/context error:', e);
    return res.status(500).json({
      guard: { antiLoop: { token: null, lastHashes: [] }, rules: '', style: '' },
      pnjCards: [], dossiers: [], systemHint: '', turn: 0, error: 'engine/context error'
    });
  }
});

// COMMIT
app.post('/api/engine/commit', async (req, res) => {
  try {
    const { sid, modelReply, notes, pnjUpdates, lock } = req.body || {};
    const sess = await getOrInitSession(sid || 'default');

    const fp = fingerprint(modelReply || '');
    sess.data.lastReplies = Array.isArray(sess.data.lastReplies) ? sess.data.lastReplies : [];
    sess.data.lastReplies.push(fp);
    if (sess.data.lastReplies.length > 10) sess.data.lastReplies = sess.data.lastReplies.slice(-10);

    if (notes) {
      sess.data.notes = Array.isArray(sess.data.notes) ? sess.data.notes : [];
      sess.data.notes.push(String(notes).slice(0, 300));
      if (sess.data.notes.length > 50) sess.data.notes = sess.data.notes.slice(-50);
    }

    sess.data.turn = Number(sess.data.turn || 0) + 1;

    if (Array.isArray(pnjUpdates)) {
      for (const u of pnjUpdates) {
        const id = String(u?.id || '');
        const patch = u?.patch || {};
        if (!id || typeof patch !== 'object') continue;
        const cur = await pool.query('SELECT data FROM pnjs WHERE id=$1', [id]);
        if (!cur.rows.length) continue;
        const current = cur.rows[0].data; const locks = new Set(current.lockedTraits || []);
        const incoming = { ...patch };
        for (const f of locks) if (f in incoming && JSON.stringify(incoming[f]) !== JSON.stringify(current[f])) delete incoming[f];
        const merged = { ...current, ...incoming, id };
        await pool.query('UPDATE pnjs SET data=$2::jsonb WHERE id=$1', [id, JSON.stringify(merged)]);
      }
    }

    if (lock && lock.id && Array.isArray(lock.fields) && lock.fields.length) {
      const id = String(lock.id);
      const cur = await pool.query('SELECT data FROM pnjs WHERE id=$1', [id]);
      if (cur.rows.length) {
        const p = cur.rows[0].data; const set = new Set(p.lockedTraits || []);
        for (const f of lock.fields) set.add(String(f)); p.lockedTraits = Array.from(set);
        await pool.query('UPDATE pnjs SET data=$2::jsonb WHERE id=$1', [id, JSON.stringify(p)]);
      }
    }

    await saveSession(sid || 'default', sess.data);
    res.json({ ok: true, turn: sess.data.turn, lastHash: fp });
  } catch (e) { console.error(e); res.status(500).json({ message: 'engine/commit error' }); }
});

// =================== STYLE & CONTENT SETTINGS ===================
app.post('/api/style', (req, res) => {
  narrativeStyle = req.body || { styleText: '' };
  res.json({ message: 'Style mis à jour.' });
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
  if (!p) return res.status(400).json({ message: 'Formule invalide. Utilise NdM±K (ex: 1d20+3).' });
  const rolls = Array.from({ length: p.count }, () => rollOnce(p.sides));
  const total = rolls.reduce((a, b) => a + b, 0) + p.modifier;
  res.json({ result: total, rolls, modifier: p.modifier, formula: dice });
});
app.get('/api/pnjs/:id/compute-stats', async (req, res) => {
  try {
    const id = req.params.id;

app.get('/api/pnjs/:id/compute-stats', async (req, res) => {
  try {
    const id = req.params.id;

app.get('/api/pnjs/:id/compute-stats', async (req, res) => {
  try {
    const id = req.params.id;

    // Exemple : tu lis ton PNJ depuis ta base (PostgreSQL ou autre)
    const r = await pool.query('SELECT data FROM pnjs WHERE id = $1', [id]);
    if (!r.rows.length) {
      return res.status(404).json({ message: 'PNJ non trouvé.' });
    }

    const p = r.rows[0].data || {};

    // Calcul rapide des stats de combat
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
  try { await pool.query('SELECT 1'); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ ok: false, error: 'DB error' }); }
});

// =================== BACKUPS ===================
// Snapshot complet (pnjs, canon, races, sessions) – à télécharger côté client
app.get('/api/backup/snapshot', async (req, res) => {
  try {
    const pnjs = (await pool.query('SELECT data FROM pnjs')).rows.map(r => r.data);
    const canon = (await pool.query('SELECT data FROM canon_profiles')).rows.map(r => r.data);
    const sessions = (await pool.query('SELECT id, data FROM sessions')).rows.map(r => ({ id: r.id, data: r.data }));
    res.json({ pnjs, canon, races, sessions, generatedAt: new Date().toISOString() });
  } catch (e) { console.error(e); res.status(500).json({ message: 'DB error' }); }
});

// Restore (upsert) – body: { pnjs?:[], canon?:[], races?:[], sessions?:[] }
app.post('/api/backup/restore', async (req, res) => {
  try {
    const { pnjs = [], canon = [], races: inRaces = null, sessions = [] } = req.body || {};
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
      // surcharge races.json (FS éphémère en prod — à récupérer via snapshot quand même)
      races = inRaces;
      saveRaces();
    }
    await pool.query('COMMIT');
    res.json({ ok: true, counts: { pnjs: pnjs.length, canon: canon.length, sessions: sessions.length, races: Array.isArray(inRaces) ? inRaces.length : undefined } });
  } catch (e) {
    console.error(e);
    try { await pool.query('ROLLBACK'); } catch {}
    res.status(500).json({ message: 'DB error' });
  }
});

// ---------------- Lancement ----------------
app.listen(port, () => { console.log(`JDR API en ligne sur http://localhost:${port}`); });


