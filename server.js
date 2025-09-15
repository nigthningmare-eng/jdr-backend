// ==== JDR Backend complet (PNJ Postgres + Races CRUD + Story/Style/Scene + Roll + ContentSettings) ====
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const { Pool } = require('pg');

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// -------------------- DB (PNJ en PostgreSQL) --------------------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

(async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pnjs (
      id TEXT PRIMARY KEY,
      data JSONB NOT NULL
    );
  `);
  console.log('Table pnjs OK');
})().catch(console.error);

// -------------------- Mémoire légère --------------------
let storyState = require('./storyState.json');
let narrativeStyle = { styleText: "" };
let contentSettings = { explicitLevel: 'mature' }; // 'safe' | 'mature' | 'fade'

// -------------------- Utils --------------------
function parseDiceFormula(formula) {
  const m = (formula || '').trim().match(/^(\d+)d(\d+)([+-]\d+)?$/i);
  if (!m) return null;
  return { count: parseInt(m[1], 10), sides: parseInt(m[2], 10), modifier: m[3] ? parseInt(m[3], 10) : 0 };
}
const rollOnce = s => Math.floor(Math.random() * s) + 1;

function softenStyle(text, level = 'mature') {
  if (level === 'safe') {
    return text
      .replace(/\b(lécher|peloter|gémir|haleter|mordre sensuellement)\b/gi, 'regarder tendrement')
      .concat('\n\n(La narration reste sobre et pudique.)');
  }
  if (level === 'fade') {
    // coupe dès que la tension grimpe
    return text.replace(/(.{0,200})(tension|désir|baiser(s)? fougueux|corps serrés).*/i,
      '$1 La tension monte… la scène s’interrompt avec pudeur.');
  }
  // mature (suggestif, non graphique)
  return text
    .replace(/\b(\w*nu(e|s)?|orgasm(e|ique)|pénétration|explicit(e|s)?)\b/gi, 'intense')
    .concat('\n\n(La scène reste suggestive, sans détails graphiques.)');
}

// =================== PNJ (PostgreSQL) ====================
app.get('/api/pnjs', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT data FROM pnjs');
    res.json(rows.map(r => r.data));
  } catch (e) {
    console.error(e); res.status(500).json({ message: 'DB error' });
  }
});

// ---- Ajouter XP
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
    console.error(e); res.status(500).json({ message: 'DB error' });
  }
});

// ---- Level-up
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
      // Bonus stats simple (ajuste à ta sauce)
      p.stats.hp += 5; statIncreases.hp += 5;
      p.stats.mp += 5; statIncreases.mp += 5;
      p.stats.strength += 1; statIncreases.strength += 1;
      p.stats.defense += 1; statIncreases.defense += 1;
      p.stats.magic += 1; statIncreases.magic += 1;
      p.stats.speed += 1; statIncreases.speed += 1;
      p.stats.resistance += 1; statIncreases.resistance += 1;
      p.stats.charisma += 1; statIncreases.charisma += 1;
      // stop anti-boucle déraisonnable
      if (p.level - oldLevel > 50) break;
    }

    const result = {
      oldLevel,
      newLevel: p.level,
      xp: p.xp,
      xpToNext: Math.max(0, (100 * p.level) - p.xp),
      statIncreases
    };

    await pool.query('UPDATE pnjs SET data = $2::jsonb WHERE id = $1', [id, JSON.stringify(p)]);
    res.json(result);
  } catch (e) {
    console.error(e); res.status(500).json({ message: 'DB error' });
  }
});

// ---- Evolve (vérifie races.json)
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

    // Conditions : doit exister un chemin depuis la race actuelle vers targetRaceId
    let ok = false;
    if (currentRace && Array.isArray(currentRace.evolutionPaths)) {
      for (const path of currentRace.evolutionPaths) {
        if (path.toRaceId === targetRaceId) {
          const minLevel = path.minLevel || 0;
          if (p.level >= minLevel) ok = true;
          // (Tu peux enrichir avec vérifs sur 'conditions')
        }
      }
    }
    if (!ok) return res.status(400).json({ message: 'Conditions d’évolution non remplies' });

    // Appliquer l’évolution
    p.raceId = targetRace.id;
    p.raceName = targetRace.name;
    p.evolutionHistory.push(`${currentRace ? currentRace.id : 'unknown'} -> ${targetRace.id}`);
    await pool.query('UPDATE pnjs SET data = $2::jsonb WHERE id = $1', [id, JSON.stringify(p)]);
    res.json(p);
  } catch (e) {
    console.error(e); res.status(500).json({ message: 'DB error' });
  }
});


app.put('/api/pnjs/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const { rows } = await pool.query('SELECT data FROM pnjs WHERE id = $1', [id]);
    if (!rows.length) return res.status(404).json({ message: 'PNJ non trouvé.' });
    const merged = { ...rows[0].data, ...req.body, id };
    await pool.query('UPDATE pnjs SET data = $2::jsonb WHERE id = $1', [id, JSON.stringify(merged)]);
    res.json(merged);
  } catch (e) {
    console.error(e); res.status(500).json({ message: 'DB error' });
  }
});

// (Optionnel) Export backup PNJ
app.get('/api/pnjs/export', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT data FROM pnjs');
    res.json(rows.map(r => r.data));
  } catch (e) {
    res.status(500).json({ message: 'DB error' });
  }
});

// =================== STORY / STYLE / SCENE ====================
app.get('/api/story/state', (req, res) => { res.json(storyState); });

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

// =================== RACES (CRUD fichier JSON) ====================
const racesPath = './races.json';
let races = require('./races.json');

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

app.put('/api/pnjs/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const { rows } = await pool.query('SELECT data FROM pnjs WHERE id = $1', [id]);
    if (!rows.length) return res.status(404).json({ message: 'PNJ non trouvé.' });
    const current = rows[0].data;
    const locks = new Set(current.lockedTraits || []);
    const incoming = { ...req.body };

    // Empêcher la modif des champs verrouillés
    for (const f of locks) {
      if (f in incoming && JSON.stringify(incoming[f]) !== JSON.stringify(current[f])) {
        delete incoming[f];
      }
    }

    const merged = { ...current, ...incoming, id };
    await pool.query('UPDATE pnjs SET data = $2::jsonb WHERE id = $1', [id, JSON.stringify(merged)]);
    res.json(merged);
  } catch (e) {
    console.error(e); res.status(500).json({ message: 'DB error' });
  }
});


app.delete('/api/races/:id', (req, res) => {
  const i = races.findIndex(r => r.id === req.params.id);
  if (i === -1) return res.status(404).json({ message: 'Race non trouvée' });
  const removed = races.splice(i, 1)[0];
  saveRaces();
  res.json(removed);
});

// ---------------- Lancement ----------------
app.listen(port, () => {
  console.log(`JDR API en ligne sur http://localhost:${port}`);
});








