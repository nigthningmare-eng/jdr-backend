// ==== JDR Backend minimal (PNJ + Story + Style + Scène + Roll + XP/Level + Races/Evolve) ====
const express = require('express');
const cors = require('cors');

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ---------------- Mémoire simple ----------------
let pnjs = require('./pnjs.json');           // PNJ persistés via fichier JSON (chargé au démarrage)
let storyState = require('./storyState.json'); // État d'histoire de départ
let narrativeStyle = { styleText: "" };

// ---------------- Helpers généraux ----------------
function ensureId(obj) { if (!obj.id) obj.id = Date.now().toString(); return obj; }

// ============ PNJ BASIQUE ============
app.get('/api/pnjs', (req, res) => { res.json(pnjs); });

app.post('/api/pnjs', (req, res) => {
  const newPnj = req.body || {};
  if (pnjs.length >= 50) return res.status(400).json({ message: 'Maximum 50 PNJ autorisés.' });
  newPnj.id = Date.now().toString();
  ensureProgression(newPnj); // initialise level/xp/stats si manquants
  pnjs.push(newPnj);
  res.status(201).json(newPnj);
});

app.put('/api/pnjs/:id', (req, res) => {
  const i = pnjs.findIndex(p => p.id === req.params.id);
  if (i === -1) return res.status(404).json({ message: 'PNJ non trouvé.' });
  pnjs[i] = { ...pnjs[i], ...req.body, id: pnjs[i].id };
  ensureProgression(pnjs[i]);
  res.json(pnjs[i]);
});

// ============ STORY STATE ============
app.get('/api/story/state', (req, res) => { res.json(storyState); });

app.post('/api/story/state', (req, res) => {
  storyState = req.body || {};
  res.json(storyState);
});

// ============ STYLE ============
app.post('/api/style', (req, res) => {
  narrativeStyle = req.body || { styleText: "" };
  res.json({ message: 'Style mis à jour.' });
});

// ============ GENERATE SCENE (mock) ============
app.post('/api/generate/scene', (req, res) => {
  const { prompt } = req.body || {};
  const scene = `🎭 STYLE: ${String(narrativeStyle.styleText || '').slice(0, 40)}...\n\nScène: ${prompt || '(vide)'}`;
  res.json({ narrativeText: scene });
});

// ============ ROLL (dés) ============
function parseDiceFormula(formula) {
  const m = (formula || '').trim().match(/^(\d+)d(\d+)([+-]\d+)?$/i);
  if (!m) return null;
  return { count: parseInt(m[1], 10), sides: parseInt(m[2], 10), modifier: m[3] ? parseInt(m[3], 10) : 0 };
}
const rollOnce = s => Math.floor(Math.random() * s) + 1;

app.post('/api/roll', (req, res) => {
  const { dice } = req.body || {};
  const p = parseDiceFormula(dice);
  if (!p) return res.status(400).json({ message: 'Formule invalide. Utilise NdM±K (ex: 1d20+3).' });
  const rolls = Array.from({ length: p.count }, () => rollOnce(p.sides));
  const total = rolls.reduce((a, b) => a + b, 0) + p.modifier;
  res.json({ result: total, rolls, modifier: p.modifier, formula: dice });
});

// ============ XP / LEVEL ============
function xpToNextLevel(level) { return Math.max(50, level * 100); }

function ensureProgression(p) {
  if (!p.level || p.level < 1) p.level = 1;
  if (p.xp == null || p.xp < 0) p.xp = 0;
  if (p.xpToNext == null || p.xpToNext <= 0) p.xpToNext = xpToNextLevel(p.level);
  p.stats = p.stats || {};
  const defaults = { hp: 100, mp: 50, strength: 10, defense: 10, magic: 10, speed: 10, resistance: 8, charisma: 10 };
  for (const k of Object.keys(defaults)) if (typeof p.stats[k] !== 'number') p.stats[k] = defaults[k];
  p.raceId = p.raceId || null;
  p.raceName = p.raceName || (p.race || null);
  p.evolutionStage = p.evolutionStage || null;
  p.evolutionHistory = p.evolutionHistory || [];
  p.titles = p.titles || [];
  p.skills = p.skills || [];
  return p;
}

function applyLevelUp(p, levelsGained) {
  const inc = { hp: 10, mp: 6, strength: 2, defense: 2, magic: 3, speed: 2, resistance: 2, charisma: 1 };
  const totalInc = {};
  for (let i = 0; i < levelsGained; i++) {
    for (const k of Object.keys(inc)) {
      p.stats[k] += inc[k];
      totalInc[k] = (totalInc[k] || 0) + inc[k];
    }
  }
  return totalInc;
}

app.post('/api/pnjs/:id/award-xp', (req, res) => {
  const p = pnjs.find(p => p.id === req.params.id);
  if (!p) return res.status(404).json({ message: 'PNJ non trouvé' });
  ensureProgression(p);
  const add = Number(req.body?.xp || 0);
  if (!Number.isFinite(add) || add <= 0) return res.status(400).json({ message: 'xp invalide' });
  p.xp += add;
  p.xpToNext = xpToNextLevel(p.level);
  res.json(p);
});

app.post('/api/pnjs/:id/level-up', (req, res) => {
  const p = pnjs.find(p => p.id === req.params.id);
  if (!p) return res.status(404).json({ message: 'PNJ non trouvé' });
  ensureProgression(p);
  const oldLevel = p.level;
  let gained = 0;
  while (p.xp >= p.xpToNext) {
    p.xp -= p.xpToNext;
    p.level += 1;
    p.xpToNext = xpToNextLevel(p.level);
    gained++;
    if (gained > 100) break;
  }
  const statIncreases = gained > 0 ? applyLevelUp(p, gained) : {};
  res.json({ oldLevel, newLevel: p.level, xp: p.xp, xpToNext: p.xpToNext, statIncreases });
});

// ============ RACES (mini catalogue + évolutions) ============
const races = [
  {
    id: 'slime',
    name: 'Slime',
    family: 'slime',
    canon: true,
    description: 'Créature gélatineuse très adaptable.',
    baseStats: { hp: 90, mp: 80, strength: 6, defense: 8, magic: 12, speed: 10, resistance: 12, charisma: 8 },
    evolutionPaths: [
      { toRaceId: 'demon-slime', minLevel: 20, conditions: ['Nomination/afflux de magicules'] }
    ]
  },
  {
    id: 'demon-slime',
    name: 'Demon Slime',
    family: 'slime',
    canon: true,
    description: 'Slime transcendé par énergie démoniaque.',
    baseStats: { hp: 120, mp: 140, strength: 12, defense: 12, magic: 22, speed: 14, resistance: 18, charisma: 12 },
    evolutionPaths: [
      { toRaceId: 'true-demon-lord', minLevel: 50, conditions: ['Rituel/conditions Seigneur-Démon'] }
    ]
  },
  {
    id: 'true-demon-lord',
    name: 'True Demon Lord',
    family: 'demon',
    canon: true,
    description: 'Transcendance démoniaque; autorité et domaine.',
    baseStats: { hp: 200, mp: 250, strength: 22, defense: 20, magic: 40, speed: 22, resistance: 28, charisma: 20 },
    evolutionPaths: []
  },
  {
    id: 'goblin',
    name: 'Goblin',
    family: 'goblin',
    canon: true,
    description: 'Faible base mais grand potentiel via nomination.',
    baseStats: { hp: 70, mp: 20, strength: 8, defense: 6, magic: 4, speed: 10, resistance: 6, charisma: 6 },
    evolutionPaths: [
      { toRaceId: 'hobgoblin', minLevel: 5, conditions: ['Nomination/bénédiction'] }
    ]
  },
  {
    id: 'hobgoblin',
    name: 'Hobgoblin',
    family: 'goblin',
    canon: true,
    description: 'Gobelin nommé et renforcé.',
    baseStats: { hp: 100, mp: 30, strength: 12, defense: 10, magic: 6, speed: 12, resistance: 10, charisma: 8 },
    evolutionPaths: [
      { toRaceId: 'kijin', minLevel: 15, conditions: ['Nomination soutenue/rituels'] }
    ]
  },
  {
    id: 'kijin',
    name: 'Kijin',
    family: 'oni',
    canon: true,
    description: 'Ogre nommé/évolué (oni).',
    baseStats: { hp: 130, mp: 60, strength: 18, defense: 14, magic: 10, speed: 14, resistance: 14, charisma: 12 },
    evolutionPaths: []
  },
  {
    id: 'human',
    name: 'Human',
    family: 'humanoid',
    canon: true,
    description: 'Grande diversité de classes/aptitudes.',
    baseStats: { hp: 90, mp: 40, strength: 10, defense: 10, magic: 8, speed: 10, resistance: 9, charisma: 10 },
    evolutionPaths: []
  }
];

const raceById = id => races.find(r => r.id === id);

app.get('/api/races', (req, res) => {
  const { canon, family } = req.query;
  let out = races;
  if (typeof canon !== 'undefined') out = out.filter(r => !!r.canon === (canon === 'true'));
  if (family) out = out.filter(r => r.family === family);
  res.json(out);
});

app.get('/api/races/:raceId/evolutions', (req, res) => {
  const r = raceById(req.params.raceId);
  if (!r) return res.status(404).json({ message: 'Race non trouvée' });
  res.json(r.evolutionPaths || []);
});

app.post('/api/pnjs/:id/evolve', (req, res) => {
  const p = pnjs.find(p => p.id === req.params.id);
  if (!p) return res.status(404).json({ message: 'PNJ non trouvé' });
  ensureProgression(p);

  const targetRaceId = req.body?.targetRaceId;
  if (!targetRaceId) return res.status(400).json({ message: 'targetRaceId manquant' });

  const currentRaceId = p.raceId || null;
  if (!currentRaceId) return res.status(400).json({ message: 'raceId courant non défini sur le PNJ' });

  const currentRace = raceById(currentRaceId);
  const targetRace = raceById(targetRaceId);
  if (!currentRace || !targetRace) return res.status(400).json({ message: 'Race source ou cible invalide' });

  const path = (currentRace.evolutionPaths || []).find(ep => ep.toRaceId === targetRaceId);
  if (!path) return res.status(400).json({ message: 'Aucun chemin d’évolution direct vers la race cible' });

  if (path.minLevel && p.level < path.minLevel) {
    return res.status(400).json({ message: `Niveau insuffisant (requis ${path.minLevel})` });
  }

  // Met à niveau les stats de base si la race cible est supérieure
  if (targetRace.baseStats) {
    for (const [k, v] of Object.entries(targetRace.baseStats)) {
      if (typeof p.stats[k] === 'number' && typeof v === 'number') {
        p.stats[k] = Math.max(p.stats[k], v);
      }
    }
  }

  p.raceId = targetRace.id;
  p.raceName = targetRace.name;
  p.evolutionHistory.push(targetRace.id);
  p.evolutionStage = p.evolutionStage ? `${p.evolutionStage} → ${targetRace.name}` : targetRace.name;

  res.json(p);
});

// ---------------- Lancement ----------------
app.listen(port, () => {
  console.log(`JDR API en ligne sur http://localhost:${port}`);
});





