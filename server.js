const express = require('express');
const cors = require('cors');
const fs = require('fs');

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

let pnjs = require('./pnjs.json');
let storyState = require('./storyState.json');
let narrativeStyle = { styleText: "" };

// Liste PNJs
app.get('/api/pnjs', (req, res) => {
  res.json(pnjs);
});

// Créer PNJ
app.post('/api/pnjs', (req, res) => {
  const newPnj = req.body;
  if (pnjs.length >= 50) {
    return res.status(400).json({ message: "Maximum 50 PNJ autorisés." });
  }
  newPnj.id = Date.now().toString();
  pnjs.push(newPnj);
  res.status(201).json(newPnj);
});

// Modifier PNJ
app.put('/api/pnjs/:id', (req, res) => {
  const id = req.params.id;
  const index = pnjs.findIndex(p => p.id === id);
  if (index === -1) return res.status(404).json({ message: 'PNJ non trouvé.' });
  pnjs[index] = { ...pnjs[index], ...req.body };
  res.json(pnjs[index]);
});

// Lire état de l'histoire
app.get('/api/story/state', (req, res) => {
  res.json(storyState);
});

// Mettre à jour l'histoire
app.post('/api/story/state', (req, res) => {
  storyState = req.body;
  res.json(storyState);
});

// Style narratif
app.post('/api/style', (req, res) => {
  narrativeStyle = req.body;
  res.json({ message: "Style mis à jour." });
});

// Générer une scène
app.post('/api/generate/scene', (req, res) => {
  const { prompt } = req.body;
  const scene = `🎭 STYLE: ${narrativeStyle.styleText.slice(0, 40)}... \n\nScène générée : ${prompt}`;
  res.json({ narrativeText: scene });
});

// ======================= RACES (CRUD) ==========================
const racesPath = './races.json';
let races = require('./races.json');

function saveRaces() {
  try {
    fs.writeFileSync(racesPath, JSON.stringify(races, null, 2), 'utf-8');
  } catch (e) {
    console.error('Erreur d\'écriture races.json:', e);
  }
}
function slugifyId(str) {
  return String(str || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .replace(/[^a-z0-9]+/g,'-')
    .replace(/(^-|-$)/g,'') || Date.now().toString();
}

// Liste
app.get('/api/races', (req, res) => {
  res.json(races);
});

// Lire par id
app.get('/api/races/:id', (req, res) => {
  const race = races.find(r => r.id === req.params.id);
  if (!race) return res.status(404).json({ message: 'Race non trouvée' });
  res.json(race);
});

// Créer
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

// Mettre à jour
app.put('/api/races/:id', (req, res) => {
  const i = races.findIndex(r => r.id === req.params.id);
  if (i === -1) return res.status(404).json({ message: 'Race non trouvée' });
  const updated = { ...races[i], ...req.body, id: races[i].id };
  races[i] = updated;
  saveRaces();
  res.json(updated);
});

// Supprimer
app.delete('/api/races/:id', (req, res) => {
  const i = races.findIndex(r => r.id === req.params.id);
  if (i === -1) return res.status(404).json({ message: 'Race non trouvée' });
  const removed = races.splice(i, 1)[0];
  saveRaces();
  res.json(removed);
});
// ==============================================================


app.listen(port, () => {
  console.log(`JDR API en ligne sur http://localhost:${port}`);
});




