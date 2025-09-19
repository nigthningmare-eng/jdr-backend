// ==== JDR Backend (PNJ Postgres + CRUD complet + Pagination + Autres endpoints utiles) ====
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const { Pool } = require('pg');

const app = express();
const port = process.env.PORT || 3000;

// ---------- Middlewares ----------
app.use(cors());
// Limites généreuses (utile pour gros PNJ)
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ---------- DB ----------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // SSL désactivé si local, activé (sans vérif cert) si URL distante
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false }
});

// Création des tables nécessaires
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
    console.log('Tables pnjs & canon_profiles OK');
  } catch (e) {
    console.error('DB init failed:', e);
  }
})();

// ---------- Mémoire légère (fichiers locaux pour certains modules) ----------
let storyState = safeRequire('./storyState.json', {});
let narrativeStyle = { styleText: "" };
let contentSettings = { explicitLevel: 'mature' }; // 'safe' | 'mature' | 'fade'

// Races (stockées en fichier local, simple)
const racesPath = './races.json';
let races = safeRequire('./races.json', []);
function saveRaces() {
  try { fs.writeFileSync(racesPath, JSON.stringify(races, null, 2), 'utf-8'); }
  catch (e) { console.error("Erreur d'écriture races.json:", e); }
}
function safeRequire(path, fallback) {
  try {
    if (fs.existsSync(path)) return require(path);
  } catch {}
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

// Merge profond (objets) — les tableaux sont remplacés (prévisible)
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

// LISTE paginée + projection de champs + recherche simple
app.get('/api/pnjs', async (req, res) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit || '50', 10), 200);
    const offset = Math.max(parseInt(req.query.offset || '0', 10), 0);
    const q = (req.query.q || '').toString().trim().toLowerCase();
    const fields = (req.query.fields || '').toString().trim(); // ex: "id,name,level"

    // total
    const countRes = await pool.query('SELECT COUNT(*)::int AS n FROM pnjs');
    const total = countRes.rows[0].n;

    // page
    const rowsRes = await pool.query(
      'SELECT data FROM pnjs ORDER BY (data->>\'name\') NULLS LAST, id LIMIT $1 OFFSET $2',
      [limit, offset]
    );
    let items = rowsRes.rows.map(r => r.data);

    // filtre simple
    if (q) {
      items = items.filter(p =>
        (p.name || '').toLowerCase().includes(q) ||
        (p.description || '').toLowerCase().includes(q)
      );
    }

    // projection de champs
    if (fields) {
      const pick = new Set(fields.split(',').map(s => s.trim()).filter(Boolean));
      items = items.map(p => {
        const out = {};
        for (const k of pick) out[k] = p[k];
        return out;
      });
    }

    res.json({ total, limit, offset, hasMore: offset + items.length < total, items });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'DB error' });
  }
});

// Compteur simple
app.get('/api/pnjs/count', async (req, res) => {
  try {
    const r = await pool.query('SELECT COUNT(*)::int AS n FROM pnjs');
    res.json({ total: r.rows[0].n });
  } catch (e) { res.status(500).json({ message: 'DB error' }); }
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

// CREATE
app.post('/api/pnjs', async (req, res) => {
  try {
    const p = req.body || {};
    p.id = p.id || Date.now().toString();
    if (!p.level) p.level = 1;
    if (!Number.isFinite(p.xp)) p.xp = 0;
    p.stats = p.stats || {};
    await pool.query('INSERT INTO pnjs (id, data) VALUES ($1, $2::jsonb) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data', [p.id, JSON.stringify(p)]);
    res.status(201).json(p);
  } catch (e) {
    console.error(e); res.status(500).json({ message: 'DB error' });
  }
});

// PATCH (partiel, merge profond, respecte lockedTraits)
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

// PUT (merge simple, respecte lockedTraits)
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

// DELETE en masse (body: { ids: ["...","..."] })
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
    const p = rows[0].data;
    p.xp = (p.xp || 0) + xp;
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
      if (p.level - oldLevel > 50) break; // sécurité
    }

    await pool.query('UPDATE pnjs SET data = $2::jsonb WHERE id = $1', [id, JSON.stringify(p)]);
    res.json({
      oldLevel,
      newLevel: p.level,
      xp: p.xp,
      xpToNext: Math.max(0, (100 * p.level) - p.xp),
      statIncreases
    });
  } catch (e) { console.error(e); res.status(500).json({ message: 'DB error' }); }
});

// Evolve (vérifie races.json)
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
  } catch (e) { console.error(e); res.status(500).json({ message: 'DB error' }); }
});

// Verrouillage de champs
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
  } catch (e) { console.error(e); res.status(500).json({ message: 'DB error' }); }
});

// Lier un profil canon
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
  } catch (e) { console.error(e); res.status(500).json({ message: 'DB error' }); }
});

// Rapport de cohérence simple
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

// Export (backup JSON)
app.get('/api/pnjs/export', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT data FROM pnjs');
    res.json(rows.map(r => r.data));
  } catch (e) { res.status(500).json({ message: 'DB error' }); }
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

// =================== CANON PROFILES (PostgreSQL) ====================
app.get('/api/canon', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT data FROM canon_profiles');
    res.json(rows.map(r => r.data));
  } catch (e) { console.error(e); res.status(500).json({ message: 'DB error' }); }
});

app.post('/api/canon', async (req, res) => {
  try {
    const c = req.body || {};
    if (!c.name) return res.status(400).json({ message: 'name requis' });
    c.id = c.id || slugifyId(c.name);
    await pool.query('INSERT INTO canon_profiles (id, data) VALUES ($1, $2::jsonb) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data', [c.id, JSON.stringify(c)]);
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
    const merged = { ...rows[0].data, ...req.body, id };
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

// =================== STORY / STYLE / CONTENT / SCENE ====================
app.get('/api/story/state', (req, res) => res.json(storyState));

app.post('/api/story/state', (req, res) => {
  storyState = req.body || {};
  res.json(storyState);
});

app.post('/api/style', (req, res) => {
  narrativeStyle = req.body || { styleText: "" };
  res.json({ message: 'Style mis à jour.' });
});

app.post('/api/settings/content', (req, res) => {
  const allowed = ['safe','mature','fade'];
  const lvl = (req.body?.explicitLevel || '').toLowerCase();
  contentSettings.explicitLevel = allowed.includes(lvl) ? lvl : contentSettings.explicitLevel;
  res.json({ explicitLevel: contentSettings.explicitLevel });
});

app.post('/api/generate/scene', (req, res) => {
  const { prompt } = req.body || {};
  const base = `🎭 STYLE: ${String(narrativeStyle.styleText || '').slice(0, 60)}...\n\n${prompt || '(vide)'}`;
  const safe = softenStyle(base, contentSettings.explicitLevel);
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
  catch (e) { res.status(500).json({ ok: false, error: 'DB error' }); }
});

// == DB: sessions (mémoire narrative par conversation) ==
(async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      id   TEXT  PRIMARY KEY,
      data JSONB NOT NULL
    );
  `);
  console.log('Table sessions OK');
})().catch(err => console.error('DB init sessions failed:', err));

// ============== ORCHESTRATEUR NARRATIF ==============

// Util: empreinte simple anti-boucle
function fingerprint(text = '') {
  const s = String(text).toLowerCase().replace(/\s+/g,' ').slice(0, 500);
  let h = 0; for (let i=0;i<s.length;i++) h = (h*31 + s.charCodeAt(i))|0;
  return String(h >>> 0);
}

// Util: charge/initialise une session
async function getOrInitSession(sid) {
  const s = String(sid || '').trim();
  if (!s) return { id: 'default', data: { lastReplies: [], notes: [] } };
  const r = await pool.query('SELECT data FROM sessions WHERE id=$1', [s]);
  if (!r.rows.length) {
    const data = { lastReplies: [], notes: [], turn: 0 };
    await pool.query('INSERT INTO sessions (id, data) VALUES ($1, $2::jsonb)', [s, JSON.stringify(data)]);
    return { id: s, data };
  }
  return { id: s, data: r.rows[0].data || { lastReplies: [], notes: [] } };
}

// Util: sauvegarde session
async function saveSession(sid, data) {
  await pool.query(`
    INSERT INTO sessions (id, data) VALUES ($1,$2::jsonb)
    ON CONFLICT (id) DO UPDATE SET data=EXCLUDED.data
  `, [sid, JSON.stringify(data)]);
}

// Util: trouve PNJ mentionnés naïvement par nom (fallback)
async function findMentionedPnjs(userText, limit = 6) {
  const r = await pool.query('SELECT data FROM pnjs');
  const all = r.rows.map(x => x.data);
  const txt = String(userText || '').toLowerCase();
  const hits = [];
  for (const p of all) {
    const nm = String(p.name || '').toLowerCase();
    if (!nm) continue;
    if (txt.includes(nm)) hits.push(p);
    if (hits.length >= limit) break;
  }
  return hits;
}

// Util: si l’utilisateur fournit explicitement des ids
async function loadPnjsByIds(ids = []) {
  const out = [];
  for (const id of ids) {
    const r = await pool.query('SELECT data FROM pnjs WHERE id=$1', [String(id)]);
    if (r.rows.length) out.push(r.rows[0].data);
  }
  return out;
}

// Construit une “fiche PNJ compacte” pour le prompt
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

// -------- CONTEXT: prépare le tour de jeu --------
/*
Body:
{
  "sid": "session-123",
  "userText": "Kael parle à Araniel...",
  "pnjIds": ["1758006092821"],          // (optionnel)
  "pnjNames": ["Kael","Araniel"],       // (optionnel, plus intuitif)
  "locationId": "delonix"               // (optionnel)
}
*/
app.post('/api/engine/context', async (req, res) => {
  try {
    const { sid, userText, pnjIds, pnjNames } = req.body || {};
    const sess = await getOrInitSession(sid || 'default');

    // Anti-boucle: last 3 hashes
    const lastHashes = Array.isArray(sess.data.lastReplies) ? sess.data.lastReplies.slice(-3) : [];
    const token = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);

    let pnjs = [];

    // 1) Si pnjIds fournis → priorité
    if (Array.isArray(pnjIds) && pnjIds.length) {
      pnjs = await loadPnjsByIds(pnjIds);
    }
    // 2) Sinon si pnjNames fournis → chercher par nom exact (insensible à la casse)
    else if (Array.isArray(pnjNames) && pnjNames.length) {
      const r = await pool.query('SELECT data FROM pnjs');
      const all = r.rows.map(x => x.data);
      const lowerNames = pnjNames.map(n => String(n).toLowerCase());
      pnjs = all.filter(p => lowerNames.includes(String(p.name || '').toLowerCase()));
    }
    // 3) Sinon → détection naïve dans userText
    else {
      pnjs = await findMentionedPnjs(userText, 8);
    }

    // Fiches compactes
    const pnjCards = pnjs.map(compactCard);

    // Garde-fous
    const rules = [
      "Toujours rester fidèle aux traits et aux champs verrouillés (lockedTraits).",
      "Ne contredis jamais un souvenir récent; en cas de doute, demande une micro-clarification.",
      "Évite les répétitions: ne réutilise pas mot pour mot les 2 dernières répliques modèles.",
      "Concis mais immersif; dialogues en **gras**; émotions en *italique*; noms en **gras** avec emoji si prévu."
    ].join(' ');

    const style = "Light novel isekai (Tensura-compat), sobre, immersif, sans détails graphiques. Dialogues alternés naturels.";

    const systemHint =
`[ENGINE CONTEXT]
Session: ${sid || 'default'}
Tour: ${Number(sess.data.turn || 0) + 1}
AntiLoopToken: ${token}
Do/Don't: ${rules}

PNJ cards:
${pnjCards.map(c => `- ${c.name}#${c.id}
  traits: ${JSON.stringify(c.personalityTraits || [])}
  locked: ${JSON.stringify(c.lockedTraits || [])}
  backstoryHint: ${c.backstoryHint || '(n/a)'}
  skills: ${JSON.stringify(c.skills || [])}
  location: ${c.locationId || '(n/a)'}
`).join('\n')}

Format de sortie exigé:
# [Lieu] — [Date/Heure]

**🙂 NomPNJ** *(émotion)*  
**Réplique en gras...**

_Notes MJ (courtes)_: [événements | verrous | xp]`;

    res.json({
      guard: { antiLoop: { token, lastHashes }, rules, style },
      pnjCards,
      systemHint,
      turn: Number(sess.data.turn || 0) + 1
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'engine/context error' });
  }
});




// -------- COMMIT: enregistre ce qui s'est passé --------
/*
Body:
{
  "sid": "session-123",
  "modelReply": "…texte produit par GPT…",
  "notes": "mini résumé 1-2 lignes (facultatif)",
  "pnjUpdates": [
    { "id": "1758006092821", "patch": { "locationId": "delonix-souterrains" } },
    { "id": "1758001438608", "patch": { "xp": 1600 } }
  ],
  "lock": { "id": "1758006092821", "fields": ["personalityTraits","skills"] }   // (facultatif)
}
*/
app.post('/api/engine/commit', async (req, res) => {
  try {
    const { sid, modelReply, notes, pnjUpdates, lock } = req.body || {};
    const sess = await getOrInitSession(sid || 'default');

    // Anti-boucle: stocke l’empreinte de la dernière sortie
    const fp = fingerprint(modelReply || '');
    sess.data.lastReplies = Array.isArray(sess.data.lastReplies) ? sess.data.lastReplies : [];
    sess.data.lastReplies.push(fp);
    // limite mémoire courte
    if (sess.data.lastReplies.length > 10) sess.data.lastReplies = sess.data.lastReplies.slice(-10);

    // Notes courtes de session
    if (notes) {
      sess.data.notes = Array.isArray(sess.data.notes) ? sess.data.notes : [];
      sess.data.notes.push(String(notes).slice(0, 300));
      if (sess.data.notes.length > 50) sess.data.notes = sess.data.notes.slice(-50);
    }

    // Tour +1
    sess.data.turn = Number(sess.data.turn || 0) + 1;

    // Appliquer les mises à jour PNJ (merge simple)
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
        for (const f of locks) if (f in incoming && JSON.stringify(incoming[f]) !== JSON.stringify(current[f])) delete incoming[f];
        const merged = { ...current, ...incoming, id };
        await pool.query('UPDATE pnjs SET data=$2::jsonb WHERE id=$1', [id, JSON.stringify(merged)]);
      }
    }

    // Verrouillage optionnel
    if (lock && lock.id && Array.isArray(lock.fields) && lock.fields.length) {
      const id = String(lock.id);
      const cur = await pool.query('SELECT data FROM pnjs WHERE id=$1', [id]);
      if (cur.rows.length) {
        const p = cur.rows[0].data;
        const set = new Set(p.lockedTraits || []);
        for (const f of lock.fields) set.add(String(f));
        p.lockedTraits = Array.from(set);
        await pool.query('UPDATE pnjs SET data=$2::jsonb WHERE id=$1', [id, JSON.stringify(p)]);
      }
    }

    await saveSession(sid || 'default', sess.data);

    res.json({ ok: true, turn: sess.data.turn, lastHash: fp });
  } catch (e) { console.error(e); res.status(500).json({ message: 'engine/commit error' }); }
});


// ---------------- Lancement ----------------
app.listen(port, () => {
  console.log(`JDR API en ligne sur http://localhost:${port}`);
});

















