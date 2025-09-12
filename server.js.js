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

app.listen(port, () => {
  console.log(`JDR API en ligne sur http://localhost:${port}`);
});




