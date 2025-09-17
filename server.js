// ==== JDR Backend (Postgres PNJ/Canon/Locations/Sessions, Races JSON, Style/Scene, Roll) ====
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const { Pool } = require('pg');

const app = express();
const port = process.env.PORT || 3000;

// ---- Middlewares
app.use(cors());
app.use(express.json({ limit: '10mb' }));           // ⬅ augmente la limite JSON
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Forcer JSON UTF-8
app.use((req, res, next) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  next();
});

// ---- Connexion Postgres
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false }
});

// ---- Init tables (JSONB)
(async () => {
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
    CREATE TABLE IF NOT EXISTS locations (
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
    CREATE TABLE IF NOT EXISTS session_events (
      id SERIAL PRIMARY KEY,
      session_id TEXT NOT NULL,
      ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      event JSONB NOT NULL
    );
  `);
  console.log('Tables OK: pnjs, canon_profiles, locations, sessions, session_events');
})().catch(err => console.error('DB init failed:', err));

// -------------------- Utils --------------------
// Merge profond (objets imbriqués). Les tableaux sont remplacés (simple/prévisible).
function deepMerge(base, update) {
  if (Array.isArray(base) || Array.isArray(update)) return update;
  if (typeof base === 'object' && typeof update === 'object' && base && update) {
    const out = { ...base };
    for (const k of Object.keys(update)) out[k] = deepMerge(base[k], update[k]);
    return out;
  }
  return update === undefined ? base : update;
}

// Dés
function parseDiceFormula(formula) {
  const m = (formula || '').trim().match(/^(\d+)d(\d+)([+-]\d+)?$/i);
  if (!m) return null;
  return { count: parseInt(m[1], 10), sides: parseInt(m[2], 10), modifier: m[3] ? parseInt(m[3], 10) : 0 };
}
const rollOnce = s => Math.floor(Math.random() * s) + 1;

// Filtrage “contenu”
function softenStyle(text, level = 'mature') {
  if (level === 'safe') {
    return text
      .replace(/\b(lécher|peloter|gémir|haleter|mordre sensuellement)\b/gi, 'regarder tendrement')
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

// =================== RACES (CRUD fichier JSON) ====================
const racesPath = './races.json';
let races = require('./races.json');

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

app.get('/api/races', (req, res) => { res.json(races); });
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

// =================== PNJ (PostgreSQL: id + data JSONB) ====================
app.get('/api/pnjs', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT data FROM pnjs ORDER BY (data->>\'created_at\') DESC NULLS LAST;');
    res.json(rows.map(r => r.data));
  } catch (e) { console.error(e); res.status(500).json({ message: 'DB error' }); }
});
app.get('/api/pnjs/:id', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT data FROM pnjs WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ message: 'PNJ non trouvé.' });
    res.json(rows[0].data);
  } catch (e) { console.error(e); res.status(500).json({ message: 'DB error' }); }
});
app.post('/api/pnjs', async (req, res) => {
  try {
    const p = req.body || {};
    if (!p.name) return res.status(400).json({ message: "Le champ 'name' est requis." });
    const { rows: c } = await pool.query('SELECT COUNT(*)::int AS c FROM pnjs');
    if (c[0].c >= 500) return res.status(400).json({ message: 'Maximum 500 PNJ autorisés.' });

    p.id = p.id || Date.now().toString();
    const now = new Date().toISOString();
    if (!Number.isFinite(p.level)) p.level = 1;
    if (!Number.isFinite(p.xp)) p.xp = 0;
    p.stats = p.stats || {};
    p.skills = p.skills || [];
    p.personalityTraits = p.personalityTraits || [];
    p.created_at = now;
    p.updated_at = now;

    await pool.query(
      'INSERT INTO pnjs (id, data) VALUES ($1, $2::jsonb) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data',
      [p.id, JSON.stringify(p)]
    );
    res.status(201).json(p);
  } catch (e) { console.error(e); res.status(500).json({ message: 'DB error' }); }
});
app.put('/api/pnjs/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const { rows } = await pool.query('SELECT data FROM pnjs WHERE id = $1', [id]);
    if (!rows.length) return res.status(404).json({ message: 'PNJ non trouvé.' });

    const current = rows[0].data;
    const locks = new Set(current.lockedTraits || []);
    const incoming = { ...req.body }; delete incoming.id;
    for (const f of locks) {
      if (f in incoming && JSON.stringify(incoming[f]) !== JSON.stringify(current[f])) delete incoming[f];
    }
    let merged = deepMerge(current, incoming);
    merged.id = id;
    merged.updated_at = new Date().toISOString();

    await pool.query('UPDATE pnjs SET data = $2::jsonb WHERE id = $1', [id, JSON.stringify(merged)]);
    res.json(merged);
  } catch (e) { console.error(e); res.status(500).json({ message: 'DB error' }); }
});
app.post('/api/pnjs/:id/award-xp', async (req, res) => {
  try {
    const xp = Number(req.body?.xp || 0);
    if (!Number.isFinite(xp) || xp <= 0) return res.status(400).json({ message: 'xp invalide' });

    const id = req.params.id;
    const { rows } = await pool.query('SELECT data FROM pnjs WHERE id = $1', [id]);
    if (!rows.length) return res.status(404).json({ message: 'PNJ non trouvé.' });

    const p = rows[0].data;
    p.xp = (p.xp || 0) + xp;
    p.updated_at = new Date().toISOString();

    await pool.query('UPDATE pnjs SET data = $2::jsonb WHERE id = $1', [id, JSON.stringify(p)]);
    res.json(p);
  } catch (e) { console.error(e); res.status(500).json({ message: 'DB error' }); }
});
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
      p.stats.hp += 5;          statIncreases.hp += 5;
      p.stats.mp += 5;          statIncreases.mp += 5;
      p.stats.strength += 1;    statIncreases.strength += 1;
      p.stats.defense += 1;     statIncreases.defense += 1;
      p.stats.magic += 1;       statIncreases.magic += 1;
      p.stats.speed += 1;       statIncreases.speed += 1;
      p.stats.resistance += 1;  statIncreases.resistance += 1;
      p.stats.charisma += 1;    statIncreases.charisma += 1;
      if (p.level - oldLevel > 50) break;
    }

    const result = {
      oldLevel,
      newLevel: p.level,
      xp: p.xp,
      xpToNext: Math.max(0, (100 * p.level) - p.xp),
      statIncreases
    };

    p.updated_at = new Date().toISOString();
    await pool.query('UPDATE pnjs SET data = $2::jsonb WHERE id = $1', [id, JSON.stringify(p)]);
    res.json(result);
  } catch (e) { console.error(e); res.status(500).json({ message: 'DB error' }); }
});
app.post('/api/pnjs/:id/evolve', async (req, res) => {
  try {
    const id = req.params.id;
    const targetRaceId = String(req.body?.targetRaceId || '');
    if (!targetRaceId) return res.status(400).json({ message: 'targetRaceId requis' });

    const { rows } = await pool.query('SELECT data FROM pnjs WHERE id = $1', [id]);
    if (!rows.length) return res.status(404).json({ message: 'PNJ non trouvé.' });
    const p = rows[0].data;

    const currentRace = races.find(r => r.id === p.raceId);
    const targetRace = races.find(r => r.id === targetRaceId);
    if (!targetRace) return res.status(404).json({ message: 'Race cible inconnue' });

    let ok = false;
    if (currentRace && Array.isArray(currentRace.evolutionPaths)) {
      for (const path of currentRace.evolutionPaths) {
        if (path.toRaceId === targetRaceId) {
          const minLevel = path.minLevel || 0;
          if ((p.level || 1) >= minLevel) ok = true;
        }
      }
    }
    if (!ok) return res.status(400).json({ message: 'Conditions d’évolution non remplies' });

    p.raceId = targetRace.id;
    p.raceName = targetRace.name;
    p.evolutionHistory = Array.isArray(p.evolutionHistory) ? p.evolutionHistory : [];
    p.evolutionHistory.push(`${currentRace ? currentRace.id : 'unknown'} -> ${targetRace.id}`);
    p.updated_at = new Date().toISOString();

    await pool.query('UPDATE pnjs SET data = $2::jsonb WHERE id = $1', [id, JSON.stringify(p)]);
    res.json(p);
  } catch (e) { console.error(e); res.status(500).json({ message: 'DB error' }); }
});
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
    p.updated_at = new Date().toISOString();

    await pool.query('UPDATE pnjs SET data = $2::jsonb WHERE id = $1', [id, JSON.stringify(p)]);
    res.json(p);
  } catch (e) { console.error(e); res.status(500).json({ message: 'DB error' }); }
});
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
    p.updated_at = new Date().toISOString();

    await pool.query('UPDATE pnjs SET data = $2::jsonb WHERE id = $1', [id, JSON.stringify(p)]);
    res.json(p);
  } catch (e) { console.error(e); res.status(500).json({ message: 'DB error' }); }
});
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

    const c = cRes.rows[0].data;
    const conflicts = [];
    if (c.appearance && p.appearance && c.appearance !== p.appearance) {
      conflicts.push({ field: 'appearance', expected: c.appearance, found: p.appearance, severity: 'medium' });
    }
    if (Array.isArray(c.personalityTraits) && Array.isArray(p.personalityTraits)) {
      const missing = c.personalityTraits.filter(t => !p.personalityTraits.includes(t));
      if (missing.length) conflicts.push({
        field: 'personalityTraits',
        expected: c.personalityTraits.join(', '),
        found: p.personalityTraits.join(', '),
        severity: 'low'
      });
    }
    if (Array.isArray(c.skills) && Array.isArray(p.skills)) {
      const cSkillNames = new Set(c.skills.map(s => s.name));
      const pSkillNames = new Set(p.skills.map(s => s.name));
      for (const s of cSkillNames) if (!pSkillNames.has(s)) conflicts.push({ field: 'skills', expected: `inclure ${s}`, found: 'absent', severity: 'low' });
    }

    res.json({ passed: conflicts.length === 0, conflicts, suggestions: [] });
  } catch (e) { console.error(e); res.status(500).json({ message: 'DB error' }); }
});
app.get('/api/pnjs/export', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT data FROM pnjs');
    res.json(rows.map(r => r.data));
  } catch (e) { res.status(500).json({ message: 'DB error' }); }
});

// =================== CANON PROFILES (Postgres) ====================
app.get('/api/canon', async (req, res) => {
  try { const { rows } = await pool.query('SELECT data FROM canon_profiles'); res.json(rows.map(r => r.data)); }
  catch (e) { console.error(e); res.status(500).json({ message: 'DB error' }); }
});
app.post('/api/canon', async (req, res) => {
  try {
    const c = req.body || {};
    if (!c.name) return res.status(400).json({ message: 'name requis' });
    c.id = c.id || slugifyId(c.name);
    await pool.query(
      'INSERT INTO canon_profiles (id, data) VALUES ($1, $2::jsonb) ON CONFLICT (id) DO UPDATE SET data=EXCLUDED.data',
      [c.id, JSON.stringify(c)]
    );
    res.status(201).json(c);
  } catch (e) { console.error(e); res.status(500).json({ message: 'DB error' }); }
});
app.get('/api/canon/:canonId', async (req, res) => {
  try {
    const id = req.params.canonId;
    const { rows } = await pool.query('SELECT data FROM canon_profiles WHERE id = $1', [id]);
    if (!rows.length) return res.status(404).json({ message: 'Canon non trouvé' });
    res.json(rows[0].data);
  } catch (e) { console.error(e); res.status(500).json({ message: 'DB error' }); }
});
app.put('/api/canon/:canonId', async (req, res) => {
  try {
    const id = req.params.canonId;
    const { rows } = await pool.query('SELECT data FROM canon_profiles WHERE id = $1', [id]);
    if (!rows.length) return res.status(404).json({ message: 'Canon non trouvé' });
    const merged = deepMerge(rows[0].data, { ...req.body, id });
    await pool.query('UPDATE canon_profiles SET data = $2::jsonb WHERE id = $1', [id, JSON.stringify(merged)]);
    res.json(merged);
  } catch (e) { console.error(e); res.status(500).json({ message: 'DB error' }); }
});
app.delete('/api/canon/:canonId', async (req, res) => {
  try {
    const id = req.params.canonId;
    const { rows } = await pool.query('DELETE FROM canon_profiles WHERE id = $1 RETURNING data', [id]);
    if (!rows.length) return res.status(404).json({ message: 'Canon non trouvé' });
    res.json(rows[0].data);
  } catch (e) { console.error(e); res.status(500).json({ message: 'DB error' }); }
});

// =================== LOCATIONS (PostgreSQL: id + data JSONB) ====================
// data suggérée : { id, name, type:"world|continent|country|region|city|dungeon|zone", parentId, aliases:[], tags:[], franchises:[], canon, coords:{lat,lng}, climate, hazards:[], factions:[], lore, sources:[], created_at, updated_at }
app.get('/api/locations', async (req, res) => {
  try {
    const { q, type } = req.query;
    let sql = `SELECT data FROM locations`;
    const clauses = [];
    const vals = [];

    if (q) {
      clauses.push(`(
        (data->>'name') ILIKE $${vals.length+1}
        OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(data->'aliases') a WHERE a ILIKE $${vals.length+1})
        OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(data->'tags') t WHERE t ILIKE $${vals.length+1})
      )`);
      vals.push(`%${q}%`);
    }
    if (type) {
      clauses.push(`(data->>'type') = $${vals.length+1}`);
      vals.push(String(type));
    }
    if (clauses.length) sql += ` WHERE ` + clauses.join(' AND ');
    sql += ` ORDER BY (data->>'type'), (data->>'name')`;

    const { rows } = await pool.query(sql, vals);
    res.json(rows.map(r => r.data));
  } catch (e) { console.error(e); res.status(500).json({ message: 'DB error' }); }
});
app.get('/api/locations/:id', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT data FROM locations WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ message: 'Lieu non trouvé' });
    res.json(rows[0].data);
  } catch (e) { console.error(e); res.status(500).json({ message: 'DB error' }); }
});
app.post('/api/locations', async (req, res) => {
  try {
    const L = req.body || {};
    if (!L.name) return res.status(400).json({ message: "Le champ 'name' est requis." });
    if (!L.type) return res.status(400).json({ message: "Le champ 'type' est requis." });

    L.id = L.id || slugifyId(L.name);
    const now = new Date().toISOString();
    L.created_at = now; L.updated_at = now;
    L.aliases = Array.isArray(L.aliases) ? L.aliases : [];
    L.tags    = Array.isArray(L.tags)    ? L.tags    : [];
    L.franchises = Array.isArray(L.franchises) ? L.franchises : [];
    L.hazards = Array.isArray(L.hazards) ? L.hazards : [];
    L.factions = Array.isArray(L.factions) ? L.factions : [];

    await pool.query(
      `INSERT INTO locations (id, data) VALUES ($1, $2::jsonb)
       ON CONFLICT (id) DO UPDATE SET data=EXCLUDED.data`,
      [L.id, JSON.stringify(L)]
    );
    res.status(201).json(L);
  } catch (e) { console.error(e); res.status(500).json({ message: 'DB error' }); }
});
app.put('/api/locations/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const { rows } = await pool.query('SELECT data FROM locations WHERE id=$1', [id]);
    if (!rows.length) return res.status(404).json({ message: 'Lieu non trouvé' });

    const current = rows[0].data;
    const incoming = { ...req.body }; delete incoming.id;
    const merged = deepMerge(current, incoming);
    merged.id = id; merged.updated_at = new Date().toISOString();

    await pool.query('UPDATE locations SET data=$2::jsonb WHERE id=$1', [id, JSON.stringify(merged)]);
    res.json(merged);
  } catch (e) { console.error(e); res.status(500).json({ message: 'DB error' }); }
});
app.delete('/api/locations/:id', async (req, res) => {
  try {
    const { rows } = await pool.query('DELETE FROM locations WHERE id=$1 RETURNING data', [req.params.id]);
    if (!rows.length) return res.status(404).json({ message: 'Lieu non trouvé' });
    res.json(rows[0].data);
  } catch (e) { console.error(e); res.status(500).json({ message: 'DB error' }); }
});
app.get('/api/locations/:id/pnjs', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT data FROM pnjs WHERE data->>'locationId' = $1`,
      [req.params.id]
    );
    res.json(rows.map(r => r.data));
  } catch (e) { console.error(e); res.status(500).json({ message: 'DB error' }); }
});

// =================== SESSIONS (progression persistante) ====================
// data suggérée : { title, players:[{name,characterId}], turn, scene, style, contentLevel, flags:{}, ... }

app.get('/api/sessions', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT id, data FROM sessions ORDER BY id ASC');
    res.json(rows.map(r => ({ id: r.id, ...r.data })));
  } catch (e) { console.error(e); res.status(500).json({ message:'DB error' }); }
});

app.post('/api/sessions', async (req, res) => {
  try {
    const s = req.body || {};
    s.id = s.id || slugifyId(s.title || `session-${Date.now()}`);
    const now = new Date().toISOString();
    const data = {
      title: s.title || 'Partie sans titre',
      players: Array.isArray(s.players) ? s.players : [],
      turn: Number.isFinite(s.turn) ? s.turn : 1,
      scene: s.scene || null,
      style: s.style || '',
      contentLevel: (s.contentLevel || 'mature').toLowerCase(),
      flags: s.flags || {},
      created_at: now,
      updated_at: now
    };
    await pool.query(
      `INSERT INTO sessions (id, data) VALUES ($1,$2::jsonb)
       ON CONFLICT (id) DO UPDATE SET data=EXCLUDED.data`,
      [s.id, JSON.stringify(data)]
    );
    res.status(201).json({ id: s.id, ...data });
  } catch (e) { console.error(e); res.status(500).json({ message:'DB error' }); }
});

app.get('/api/sessions/:sid', async (req, res) => {
  try {
    const sid = req.params.sid;
    const { rows } = await pool.query('SELECT data FROM sessions WHERE id=$1', [sid]);
    if (!rows.length) return res.status(404).json({ message:'Session introuvable' });
    res.json(rows[0].data);
  } catch (e) { console.error(e); res.status(500).json({ message:'DB error' }); }
});

// Upsert d'une session (mettre à jour la progression)
app.post('/api/sessions/:sid', async (req, res) => {
  try {
    const sid = req.params.sid;
    const { rows } = await pool.query('SELECT data FROM sessions WHERE id=$1', [sid]);
    const current = rows[0]?.data || {};
    const merged = deepMerge(current, req.body || {});
    merged.updated_at = new Date().toISOString();

    await pool.query(
      `INSERT INTO sessions (id, data) VALUES ($1,$2::jsonb)
       ON CONFLICT (id) DO UPDATE SET data=EXCLUDED.data`,
      [sid, JSON.stringify(merged)]
    );
    res.json(merged);
  } catch (e) { console.error(e); res.status(500).json({ message:'DB error' }); }
});

// Journal d'événements (jets, actions, narrations…)
app.post('/api/sessions/:sid/events', async (req, res) => {
  try {
    const sid = req.params.sid;
    const event = req.body || {};
    const { rows } = await pool.query(
      `INSERT INTO session_events (session_id, event) VALUES ($1, $2::jsonb)
       RETURNING id, session_id, ts, event`,
      [sid, JSON.stringify(event)]
    );
    res.status(201).json(rows[0]);
  } catch (e) { console.error(e); res.status(500).json({ message:'DB error' }); }
});
app.get('/api/sessions/:sid/events', async (req, res) => {
  try {
    const sid = req.params.sid;
    const { rows } = await pool.query(
      `SELECT id, session_id, ts, event
       FROM session_events WHERE session_id=$1 ORDER BY id ASC`,
      [sid]
    );
    res.json(rows);
  } catch (e) { console.error(e); res.status(500).json({ message:'DB error' }); }
});

// =================== STYLE / SCENE (placeholder sans MJ) ====================
app.post('/api/style', (req, res) => {
  const styleText = String(req.body?.styleText || '');
  res.json({ message: 'Style reçu (placeholder)', styleText });
});
app.post('/api/settings/content', (req, res) => {
  const allowed = ['safe','mature','fade'];
  const lvl = (req.body?.explicitLevel || '').toLowerCase();
  res.json({ explicitLevel: allowed.includes(lvl) ? lvl : 'mature' });
});
app.post('/api/generate/scene', (req, res) => {
  const { prompt, style } = req.body || {};
  const base = `🎭 STYLE: ${String(style || '').slice(0, 60)}...\n\n${prompt || '(vide)'}`;
  const safe = softenStyle(base, 'mature');
  res.json({ narrativeText: safe });
});

// =================== ROLL (dés) ====================
app.post('/api/roll', (req, res) => {
  const { dice } = req.body || {};
  const p = parseDiceFormula(dice);
  if (!p) return res.status(400).json({ message: 'Formule invalide. Utilise NdM±K (ex: 1d20+3).' });
  const rolls = Array.from({ length: p.count }, () => rollOnce(p.sides));
  const total = rolls.reduce((a, b) => a + b, 0) + p.modifier;
  res.json({ result: total, rolls, modifier: p.modifier, formula: dice });
});

// =================== HEALTH ====================
app.get('/api/db/health', async (req, res) => {
  try { await pool.query('SELECT 1'); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ---------------- Lancement ----------------
app.listen(port, () => {
  console.log(`JDR API en ligne sur http://0.0.0.0:${port}`);
});














