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

app.post('/api/pnjs', async (req, res) => {
  try {
    const p = req.body || {};
    p.id = p.id || Date.now().toString();
    // init défauts utiles
    if (!p.level) p.level = 1;
    if (!Number.isFinite(p.xp)) p.xp = 0;
    p.stats = p.stats || {};
    await pool.query('INSERT INTO pnjs (id, data) VALUES ($1, $2::jsonb)', [p.id, JSON.stringify(p)]);
    res.status(201).json(p);
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

app.put('/api/races/:id', (req, res) => {
  const i = races.findIndex(r => r.id === req.params.id);
  if (i === -1) return res.status(404).json({ message: 'Race non trouvée' });
  const updated = { ...races[i], ...req.body, id: races[i].id };
  races[i] = updated;
  saveRaces();
  res.json(updated);
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






