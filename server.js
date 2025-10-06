// ==== JDR Backend (PNJ Postgres + CRUD + Contexte narratif robuste) ====
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const { Pool } = require('pg');

const app = express();
const port = process.env.PORT || 3000;

// ---------- Middlewares ----------
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ---------- DB ----------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('localhost')
    ? false
    : { rejectUnauthorized: false }
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
let narrativeStyle = { styleText: '' }; // persiste en mémoire process; set via /api/style
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

// =================== PNJ (PostgreSQL) ====================
// LISTE paginée + projection + filtre SQL; TOUJOURS 200 (évite les connector errors)
app.get('/api/pnjs', async (req, res) => {
  res.set('Content-Type', 'application/json; charset=utf-8');
  const limit  = Math.min(parseInt(req.query.limit || '50', 10), 200);
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
      const pick = new Set(fields.split(',').map(s => s.trim()).filter(Boolean));
      items = items.map(p => { const out = {}; for (const k of pick) out[k] = p[k]; return out; });
    }

    res.status(200).json({ total, limit, offset, hasMore: offset + items.length < total, items });
  } catch (e) {
    console.error('GET /api/pnjs error:', e);
    res.status(200).json({ total: 0, limit, offset, hasMore: false, items: [] });
  }
});

// Hydratation multiple par ids
app.get('/api/pnjs/by-ids', async (req, res) => {
  try {
    const ids = String(req.query.ids || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!ids.length) return res.status(400).json({ message: 'ids requis' });
    const r = await pool.query('SELECT data FROM pnjs WHERE id = ANY($1::text[])', [ids]);
    const map = new Map(r.rows.map(x => [x.data.id, x.data]));
    res.json(ids.map(id => map.get(id)).filter(Boolean));
  } catch (e) { console.error(e); res.status(500).json({ message: 'DB error' }); }
});

// Compact cards pour prompts
app.get('/api/pnjs/compact', async (req, res) => {
  try {
    const ids = String(req.query.ids || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!ids.length) return res.status(400).json({ message: 'ids requis' });
    const r = await pool.query('SELECT data FROM pnjs WHERE id = ANY($1::text[])', [ids]);
    res.json(r.rows.map(x => compactCard(x.data)));
  } catch (e) { console.error(e); res.status(500).json({ message: 'DB error' }); }
});

// Compteur simple
app.get('/api/pnjs/count', async (req, res) => {
  try { const r = await pool.query('SELECT COUNT(*)::int AS n FROM pnjs'); res.json({ total: r.rows[0].n }); }
  catch (e) { res.status(500).json({ message: 'DB error' }); }
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

// DELETE en masse
app.delete('/api/pnjs', async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
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

// Consistency
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

// -------- CONTEXT: prépare le tour de jeu --------
/* Body accepté :
{
  "sid": "session-123",
  "userText": "Kael parle à Araniel...",
  "pnjIds": ["1758006092821"],
  "pnjNames": ["Milim Nava"],       // ou
  "name": "Milim Nava"              // équiv à pnjNames:[name]
}
*/
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

    let pnjs = [];
    if (pnjIds.length) {
      // 1) Priorité aux ids explicites
      pnjs = await loadPnjsByIds(pnjIds);
    } else if (pnjNames.length) {
      // 2) Résolution PAR NOM (robuste)
      const raw = String(pnjNames[0] || '').trim();
      if (raw) {
        let rows = [];
        // 2.1 Exact (trim+lower)
        try {
          rows = (await pool.query(`SELECT data FROM pnjs WHERE trim(lower(data->>'name')) = trim(lower($1)) LIMIT 1`, [raw])).rows;
        } catch {}
        // 2.2 Préfixe ("Milim%")
        if (!rows.length) {
          try {
            rows = (await pool.query(`SELECT data FROM pnjs WHERE lower(data->>'name') LIKE lower($1) ORDER BY data->>'name' LIMIT 5`, [raw.replace(/\s+/g,' ').trim() + '%'])).rows;
          } catch {}
        }
        // 2.3 Tous mots contenus ("%milim%" AND "%nava%")
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
        // 2.4 Fallback LIKE large → hydrate par id
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
      // 3) Détection automatique depuis userText (quand ni pnjIds ni pnjNames)
      const txt = userText.toLowerCase();
      // tokens >=3 caractères, uniques, limiter à 5 pour rester léger
      const tokens = Array.from(new Set(
        txt.split(/[^a-zàâçéèêëîïôùûüÿñœ'-]+/i)
           .map(t => t.trim())
           .filter(t => t.length >= 3)
      )).slice(0, 5);

      let rows = [];
      if (tokens.length) {
        // AND sur tous les tokens
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
      // Fallback : 2 tokens les plus longs si rien trouvé
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

    // Fiches compactes & ancres
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
Session: ${sid}
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
    return res.status(200).json({
      guard: { antiLoop: { token: null, lastHashes: [] }, rules: '', style: '' },
      pnjCards: [], dossiers: [], systemHint: '', turn: 0, error: 'engine/context error'
    });
  }
});

// -------- COMMIT: enregistre ce qui s'est passé --------
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

// 🔎 Résolution de nom → {id,name} (léger, utile côté UI/Actions)
app.get('/api/pnjs/resolve', async (req, res) => {
  res.set('Content-Type', 'application/json; charset=utf-8');
  const name = (req.query.name || '').toString().trim();
  if (!name) return res.status(200).json({ matches: [], exact: false });
  try {
    const { rows } = await pool.query(`
      SELECT (data->>'id') AS id, (data->>'name') AS name
      FROM pnjs
      WHERE lower(data->>'name') LIKE lower($1)
      ORDER BY data->>'name'
      LIMIT 10`,
      [`%${name}%`]
    );
    const matches = rows.map(r => ({ id: String(r.id), name: String(r.name || '') }));
    const exact = matches.some(m => m.name.toLowerCase().trim() === name.toLowerCase().trim());
    return res.status(200).json({ matches, exact });
  } catch (e) { console.error('GET /api/pnjs/resolve error:', e); return res.status(200).json({ matches: [], exact: false }); }
});

// ---------------- Lancement ----------------
app.listen(port, () => { console.log(`JDR API en ligne sur http://localhost:${port}`); });

























