// ==== JDR Backend (PNJ Postgres + Moteur contexte + Canon + Bulk Patch + LockedTraits) ====
// Basé sur ton fichier pasted.txt, avec corrections "refresh moteur" (sans fetch HTTP) + sûreté patch/merge.

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json({ limit: '15mb' }));

// ----------------- Postgres -----------------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Render/Neon: souvent ssl requis. Tu gardes ton override via PGSSL=false.
  ssl: process.env.PGSSL === 'false' ? false : { rejectUnauthorized: false },
});

// ----------------- Utils -----------------
function normalizeText(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

/**
 * Deep merge pour JSON (objets récursifs + arrays overwrite).
 */
function deepMerge(target, source) {
  if (!source || typeof source !== 'object') return target;
  if (!target || typeof target !== 'object') return source;

  const out = Array.isArray(target) ? [...target] : { ...target };

  for (const [k, v] of Object.entries(source)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = deepMerge(out[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Retire du patch ce qui est verrouillé via lockedTraits (sauf adminOverride).
 * Supporte:
 *  - lockedTraits = ['skills', 'race', ...]
 *  - lockedTraits = [{ key: 'skills' }, ...]
 */
function stripLockedPatch(current, patch, adminOverride = false) {
  if (adminOverride) return { patch, locked: [] };

  const lockedTraitsRaw = current?.lockedTraits;
  const lockedKeys = Array.isArray(lockedTraitsRaw)
    ? lockedTraitsRaw
        .map(x => (typeof x === 'string' ? x : x?.key))
        .filter(Boolean)
    : [];

  if (!lockedKeys.length) return { patch, locked: [] };

  const cleaned = { ...(patch || {}) };
  const ignored = [];

  for (const key of lockedKeys) {
    if (key in cleaned) {
      delete cleaned[key];
      ignored.push(key);
    }
  }

  return { patch: cleaned, locked: ignored };
}

function continuityDossier(p) {
  return {
    id: p.id,
    name: p.name,
    coreFacts: [
      (p.raceName || p.raceId || p.race || p?.stats?.race)
        ? `Race: ${p.raceName || p.raceId || p.race || p?.stats?.race}`
        : null,
      Array.isArray(p.personalityTraits) && p.personalityTraits.length
        ? `Traits: ${p.personalityTraits.slice(0, 5).join(', ')}`
        : null,
      p.locationId ? `Loc: ${p.locationId}` : null,
      p?.canon?.status ? `Canon: ${p.canon.status}` : null,
    ].filter(Boolean),
  };
}

// ----------------- DB loaders -----------------
async function loadAllPnjs() {
  const r = await pool.query('SELECT id, data FROM pnjs');
  return r.rows.map(row => ({ id: row.id, ...(row.data || {}) }));
}
async function loadAllLocations() {
  const r = await pool.query('SELECT id, data FROM locations');
  return r.rows.map(row => ({ id: row.id, ...(row.data || {}) }));
}
async function loadAllCanonEvents() {
  const r = await pool.query('SELECT id, data FROM canon_events');
  return r.rows.map(row => ({ id: row.id, ...(row.data || {}) }));
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
      CREATE TABLE IF NOT EXISTS canon_events (
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

    console.log('✅ Tables OK');
  } catch (e) {
    console.error('❌ Init tables error', e);
  }
})();

// ----------------- Memory Sessions (Engine) -----------------
const sessions = new Map();

function getSession(sid = 'default') {
  if (!sessions.has(sid)) {
    sessions.set(sid, {
      sid,
      createdAt: Date.now(),
      data: {
        dossiersById: {},
        lastContext: null,
        lastRefreshAt: null,
      },
    });
  }
  return sessions.get(sid);
}

/**
 * ✅ CORRECTION MAJEURE :
 * Rafraîchit le moteur en interne (sans fetch HTTP vers ton propre backend).
 * Ça évite: instance mismatch / échecs réseau / refresh silencieux.
 */
async function refreshEngine(sid = 'default') {
  const sess = getSession(sid);

  const [pnjs, locations, canonEvents] = await Promise.all([
    loadAllPnjs(),
    loadAllLocations(),
    loadAllCanonEvents(),
  ]);

  const dossiersById = {};
  for (const p of pnjs) dossiersById[p.id] = continuityDossier(p);

  sess.data.dossiersById = dossiersById;
  sess.data.lastRefreshAt = Date.now();
  sess.data.lastContext = { pnjs, locations, canonEvents };

  return {
    sid,
    refreshedAt: sess.data.lastRefreshAt,
    counts: { pnjs: pnjs.length, locations: locations.length, canonEvents: canonEvents.length },
    sampleDossiers: Object.values(dossiersById).slice(0, 5),
  };
}

// ----------------- Health -----------------
app.get('/health', (req, res) => res.json({ ok: true }));

// ----------------- PNJ CRUD -----------------
app.get('/api/pnjs', async (req, res) => {
  try {
    const result = await pool.query('SELECT id, data FROM pnjs ORDER BY id');
    res.json({
      ok: true,
      pnjs: result.rows.map(r => ({ id: r.id, ...(r.data || {}) })),
    });
  } catch (err) {
    console.error('[GET PNJS]', err);
    res.status(500).json({ ok: false, message: 'Erreur serveur lors de la récupération des PNJs', error: err.message });
  }
});

// 🔎 Recherche PNJ (simple)
app.get('/api/pnjs/search', async (req, res) => {
  try {
    const q = normalizeText(req.query.q || '');
    if (!q) return res.json({ ok: true, results: [] });

    const result = await pool.query('SELECT id, data FROM pnjs');
    const all = result.rows.map(r => ({ id: r.id, ...(r.data || {}) }));

    const hits = all
      .map(p => {
        const name = normalizeText(p.name);
        const race = normalizeText(p.raceName || p.raceId || p.race || p?.stats?.race);
        const traits = Array.isArray(p.personalityTraits) ? p.personalityTraits.map(normalizeText).join(' ') : '';
        const blob = `${name} ${race} ${traits}`;
        const score = blob.includes(q) ? (q.length / Math.max(1, blob.length)) : 0;
        return { p, score };
      })
      .filter(x => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 50)
      .map(x => ({
        id: x.p.id,
        name: x.p.name,
        race: x.p.raceName || x.p.raceId || x.p.race || x.p?.stats?.race || null,
      }));

    res.json({ ok: true, results: hits });
  } catch (err) {
    console.error('[SEARCH PNJ ERROR]', err);
    res.status(500).json({ ok: false, message: 'Erreur serveur lors de la recherche PNJ' });
  }
});

// 🔎 Récupère un PNJ par ID
app.get('/api/pnjs/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('SELECT data FROM pnjs WHERE id = $1', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ ok: false, message: `PNJ ${id} introuvable` });
    }
    res.json({ ok: true, id, data: result.rows[0].data });
  } catch (err) {
    console.error('[GET PNJ BY ID]', err);
    res.status(500).json({ ok: false, message: 'Erreur serveur lors de la récupération du PNJ', error: err.message });
  }
});

// ----------------- Patch normalisation -----------------
function normalizePnjPatchForEngine(patch) {
  if (!patch || typeof patch !== 'object') return {};
  const out = { ...patch };

  // UI: "race" => moteur: "raceName"
  if (typeof out.race === 'string' && out.race.trim()) {
    out.raceName = out.race.trim();
    delete out.race;
  }

  // Si quelqu'un envoie stats.race
  if (out.stats && typeof out.stats === 'object') {
    const sr = out.stats.race;
    if (typeof sr === 'string' && sr.trim()) out.raceName = sr.trim();
  }

  // Safety: jamais via patch
  if ('id' in out) delete out.id;

  return out;
}

function moveMisplacedFieldsIntoStats(base, patch) {
  const nestedFix = { ...patch };
  const keysToStats = ['statut', 'royaume', 'compétence ultime']; // volontairement exclut "race"

  for (const key of keysToStats) {
    if (nestedFix[key] != null && nestedFix[key] !== '') {
      base.stats = { ...(base.stats || {}) };
      base.stats[key] = nestedFix[key];
      delete nestedFix[key];
    }
  }

  return { base, nestedFix };
}

// ✅ BULK PATCH
// Body attendu:
// {
//   "ids": ["id1","id2"],
//   "patch": { "race": "Elfe", "skills": [...] },
//   "adminOverride": true,
//   "dryRun": false
// }
app.patch('/api/pnjs/bulk', async (req, res) => {
  try {
    const body = (req.body && typeof req.body === 'object') ? req.body : {};
    const ids = Array.isArray(body.ids) ? body.ids.map(x => String(x).trim()).filter(Boolean) : [];
    const isAdminOverride = body.adminOverride === true;
    const dryRun = body.dryRun === true;

    let patch = (body.patch && typeof body.patch === 'object') ? body.patch : body;

    // Retire meta-champs si le user a envoyé "direct"
    if (patch && typeof patch === 'object') {
      delete patch.ids;
      delete patch.adminOverride;
      delete patch.dryRun;
    }

    if (!ids.length) return res.status(400).json({ ok: false, message: 'ids[] requis (au moins 1).' });
    if (!patch || typeof patch !== 'object' || Object.keys(patch).length === 0) {
      return res.status(400).json({ ok: false, message: 'patch requis (objet non vide).' });
    }

    const MAX_BULK = 300;
    if (ids.length > MAX_BULK) {
      return res.status(400).json({ ok: false, message: `Trop d'ids (${ids.length}). Max=${MAX_BULK}` });
    }

    const results = [];

    for (const id of ids) {
      try {
        const existing = await pool.query('SELECT data FROM pnjs WHERE id = $1', [id]);
        if (existing.rows.length === 0) {
          results.push({ id, ok: false, error: 'PNJ introuvable' });
          continue;
        }

        const currentData = existing.rows[0].data || {};

        const stripped = stripLockedPatch(currentData, patch, isAdminOverride);
        const cleanedPatchRaw = (stripped && stripped.patch) ? stripped.patch : stripped;
        const locked = (stripped && stripped.locked) ? stripped.locked : [];

        if (!cleanedPatchRaw || typeof cleanedPatchRaw !== 'object' || Object.keys(cleanedPatchRaw).length === 0) {
          results.push({
            id,
            ok: false,
            error: isAdminOverride ? 'Patch vide après nettoyage' : 'Champs verrouillés (patch ignoré)',
            lockedTraitsIgnored: locked,
          });
          continue;
        }

        const cleanedPatch = normalizePnjPatchForEngine(cleanedPatchRaw);

        // Base de travail (clone)
        let base = { ...currentData, stats: { ...(currentData.stats || {}) } };

        const moved = moveMisplacedFieldsIntoStats(base, cleanedPatch);
        base = moved.base;
        const nestedFix = moved.nestedFix;

        const mergedData = deepMerge(base, nestedFix);

        if (!dryRun) {
          await pool.query(
            'UPDATE pnjs SET data = jsonb_strip_nulls($1::jsonb) WHERE id = $2',
            [JSON.stringify(mergedData), id]
          );
        }

        results.push({
          id,
          ok: true,
          dryRun,
          lockedTraitsIgnored: locked,
          updatedKeys: Object.keys(cleanedPatch),
        });
      } catch (e) {
        results.push({ id, ok: false, error: String(e?.message || e) });
      }
    }

    // ✅ Refresh moteur 1 fois, en interne
    try { await refreshEngine('default'); } catch (_) {}

    res.json({
      ok: true,
      dryRun,
      requested: ids.length,
      updated: results.filter(r => r.ok).length,
      failed: results.filter(r => !r.ok).length,
      results,
    });
  } catch (err) {
    console.error('[PATCH PNJ BULK]', err);
    res.status(500).json({ ok: false, message: err.message });
  }
});

// ✅ PATCH PNJ ID
app.patch('/api/pnjs/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const body = (req.body && typeof req.body === 'object') ? req.body : {};

    // support 2 formats:
    // A) direct:  { adminOverride: true, ultimateSkills: [] }
    // B) wrapped: { adminOverride: true, patch: { ultimateSkills: [] } }
    const isAdminOverride = body.adminOverride === true;
    let patch = (body.patch && typeof body.patch === 'object') ? body.patch : body;

    // ne jamais autoriser id/adminOverride dans la data
    if (patch && typeof patch === 'object') {
      if ('id' in patch) delete patch.id;
      if ('adminOverride' in patch) delete patch.adminOverride;
    }

    if (!patch || typeof patch !== 'object' || Object.keys(patch).length === 0) {
      return res.status(400).json({ ok: false, message: 'Aucune donnée à modifier.' });
    }

    const existing = await pool.query('SELECT data FROM pnjs WHERE id = $1', [id]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ ok: false, message: `PNJ ${id} introuvable.` });
    }

    const currentData = existing.rows[0].data || {};

    const stripped = stripLockedPatch(currentData, patch, isAdminOverride);
    const cleanedPatchRaw = (stripped && stripped.patch) ? stripped.patch : stripped;
    const locked = (stripped && stripped.locked) ? stripped.locked : [];

    if (!cleanedPatchRaw || typeof cleanedPatchRaw !== 'object' || Object.keys(cleanedPatchRaw).length === 0) {
      return res.status(400).json({
        ok: false,
        message: isAdminOverride
          ? 'Aucune donnée applicable après nettoyage.'
          : 'Aucune donnée applicable (champs verrouillés). Ajoute adminOverride:true si nécessaire.',
        lockedTraitsIgnored: locked,
      });
    }

    const cleanedPatch = normalizePnjPatchForEngine(cleanedPatchRaw);

    // Base clone
    let base = { ...currentData, stats: { ...(currentData.stats || {}) } };
    const moved = moveMisplacedFieldsIntoStats(base, cleanedPatch);
    base = moved.base;
    const nestedFix = moved.nestedFix;

    const mergedData = deepMerge(base, nestedFix);

    const updateQuery = `
      UPDATE pnjs
      SET data = jsonb_strip_nulls($1::jsonb)
      WHERE id = $2
      RETURNING data;
    `;
    const result = await pool.query(updateQuery, [JSON.stringify(mergedData), id]);

    // ✅ Refresh moteur en interne (non bloquant)
    try { await refreshEngine('default'); } catch (_) {}

    res.json({
      ok: true,
      id,
      message: '✅ PNJ mis à jour avec succès (intelligent merge).',
      lockedTraitsIgnored: locked,
      data: result.rows[0].data,
    });
  } catch (err) {
    console.error('[PATCH PNJ INTELLIGENT]', err);
    res.status(500).json({ ok: false, message: err.message });
  }
});

// ----------------- Locations -----------------
app.get('/api/locations', async (req, res) => {
  try {
    const result = await pool.query('SELECT id, data FROM locations ORDER BY id');
    res.json({
      ok: true,
      locations: result.rows.map(r => ({ id: r.id, ...(r.data || {}) })),
    });
  } catch (err) {
    console.error('[GET LOCATIONS]', err);
    res.status(500).json({ ok: false, message: 'Erreur serveur lors de la récupération des locations', error: err.message });
  }
});

// ----------------- Canon Events -----------------
app.get('/api/canon', async (req, res) => {
  try {
    const result = await pool.query('SELECT id, data FROM canon_events ORDER BY id');
    res.json({
      ok: true,
      canon: result.rows.map(r => ({ id: r.id, ...(r.data || {}) })),
    });
  } catch (err) {
    console.error('[GET CANON]', err);
    res.status(500).json({ ok: false, message: 'Erreur serveur lors de la récupération du canon', error: err.message });
  }
});

// ----------------- Engine Refresh -----------------
app.post('/api/engine/refresh', async (req, res) => {
  try {
    const body = req.body || {};
    const sid = String(body.sid || 'default');

    const info = await refreshEngine(sid);

    res.json({
      ok: true,
      ...info,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, message: 'engine/refresh error', error: e.message });
  }
});

// ----------------- Engine Context -----------------
app.post('/api/engine/context', async (req, res) => {
  try {
    const body = req.body || {};
    const sid = String(body.sid || 'default');
    const userText = String(body.userText || '');

    const includeDrafts = body.includeDrafts === true;

    const pnjIds = Array.isArray(body.pnjIds) ? body.pnjIds.map(String) : [];
    const locationIds = Array.isArray(body.locationIds) ? body.locationIds.map(String) : [];

    const sess = getSession(sid);

    // auto refresh si pas de données
    if (!sess.data.lastContext) {
      await refreshEngine(sid);
    }

    const { pnjs, locations, canonEvents } = sess.data.lastContext;

    // Filtre PNJs en scène
    let pnjsInScene = pnjs;
    if (pnjIds.length) pnjsInScene = pnjsInScene.filter(p => pnjIds.includes(p.id));

    if (!includeDrafts) {
      pnjsInScene = pnjsInScene.filter(p => (p?.canon?.status || 'draft') !== 'draft');
    }

    // Filtre locations en scène
    let locationsInScene = locations;
    if (locationIds.length) locationsInScene = locationsInScene.filter(l => locationIds.includes(l.id));

    const pnjDetails = pnjsInScene.slice(0, 50).map(p => ({
      id: p.id,
      name: p.name,
      appearance: p.appearance ?? null,
      personalityTraits: Array.isArray(p.personalityTraits) ? p.personalityTraits : [],
      backstory: p.backstory ?? '',
      raceName: p.raceName || p.raceId || p.race || p?.stats?.race || null,
      relations: p.relations || p.relationships || null,
      locationId: p.locationId ?? null,
      lockedTraits: Array.isArray(p.lockedTraits) ? p.lockedTraits : [],
      canon: p.canon || { status: 'draft' },
      skills: Array.isArray(p.skills) ? p.skills : [],
      magics: Array.isArray(p.magics) ? p.magics : [],
      weaponTechniques: Array.isArray(p.weaponTechniques) ? p.weaponTechniques : [],
      transformations: Array.isArray(p.transformations) ? p.transformations : [],
      activeTransformation: p.activeTransformation ?? null,
    }));

    const locDetails = locationsInScene.slice(0, 50).map(l => ({
      id: l.id,
      name: l.name,
      description: l.description ?? '',
      tags: Array.isArray(l.tags) ? l.tags : [],
      canon: l.canon || { status: 'draft' },
    }));

    const canonInScene = canonEvents
      .filter(e => (includeDrafts ? true : (e?.canon?.status || 'draft') !== 'draft'))
      .slice(0, 100)
      .map(e => ({
        id: e.id,
        name: e.name,
        summary: e.summary ?? '',
        time: e.time ?? null,
        canon: e.canon || { status: 'draft' },
      }));

    res.json({
      ok: true,
      sid,
      userText,
      scene: {
        pnjs: pnjDetails,
        locations: locDetails,
        canonEvents: canonInScene,
      },
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, message: 'engine/context error', error: e.message });
  }
});

// ----------------- Engine Commit -----------------
app.post('/api/engine/commit', async (req, res) => {
  try {
    const body = req.body || {};
    const sid = String(body.sid || 'default');
    const updates = Array.isArray(body.updates) ? body.updates : [];

    const results = [];

    for (const upd of updates) {
      const id = String(upd.id || '').trim();
      const patch0 = (upd.patch && typeof upd.patch === 'object') ? upd.patch : null;
      const isAdminOverride = upd.adminOverride === true;

      if (!id || !patch0) {
        results.push({ id: id || null, ok: false, error: 'Missing id/patch' });
        continue;
      }

      const existing = await pool.query('SELECT data FROM pnjs WHERE id = $1', [id]);
      if (existing.rows.length === 0) {
        results.push({ id, ok: false, error: 'PNJ introuvable' });
        continue;
      }

      const currentData = existing.rows[0].data || {};

      const stripped = stripLockedPatch(currentData, patch0, isAdminOverride);
      const cleanedPatchRaw = (stripped && stripped.patch) ? stripped.patch : stripped;
      const locked = (stripped && stripped.locked) ? stripped.locked : [];

      const cleanedPatch = { ...(cleanedPatchRaw || {}) };

      // Comportement existant conservé : protège identité via commit
      delete cleanedPatch.name;
      delete cleanedPatch.race;
      delete cleanedPatch.canon;

      if (!cleanedPatch || typeof cleanedPatch !== 'object' || Object.keys(cleanedPatch).length === 0) {
        results.push({ id, ok: false, error: 'Patch vide après nettoyage', lockedTraitsIgnored: locked });
        continue;
      }

      const mergedData = deepMerge(currentData, cleanedPatch);

      await pool.query(
        'UPDATE pnjs SET data = jsonb_strip_nulls($1::jsonb) WHERE id = $2',
        [JSON.stringify(mergedData), id]
      );

      results.push({ id, ok: true, lockedTraitsIgnored: locked, updatedKeys: Object.keys(cleanedPatch) });
    }

    // ✅ refresh moteur en interne
    try { await refreshEngine('default'); } catch (_) {}

    res.json({ ok: true, sid, results });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, message: 'engine/commit error', error: e.message });
  }
});

// ----------------- Server -----------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Backend running on port ${PORT}`);
});
