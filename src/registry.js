// Concept Registry — versioned storage, vector index, lineage, access control.

import { id, insert, find, findOne, update, remove, all, stats as storeStats } from './store.js';
import { embed, topK, cosine } from './embedding.js';

export function createConcept({ name, description, tenant, schema, tags = [], visibility = 'private' }) {
  const concept = {
    id: id('cpt'),
    name,
    description: description || name,
    tenant,
    schema: schema || null,
    tags,
    visibility,
    head_version: null,
    version_count: 0,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  insert('concepts', concept);
  return concept;
}

export function publishVersion({ concept_id, source, evaluation, lineage = {}, semver }) {
  const c = findOne('concepts', x => x.id === concept_id);
  if (!c) throw new Error(`concept ${concept_id} not found`);

  // Name and description carry the strongest signal of meaning; tags weighted next; source excerpt last.
  const text = [
    c.name, c.name, c.name,                       // name x3
    c.description, c.description,                 // description x2
    (c.tags || []).join(' '),
    source.slice(0, 400),
  ].join('\n');
  const vector = embed(text);
  const version = c.version_count + 1;
  const versionRow = {
    id: id('ver'),
    concept_id,
    version,
    semver: semver || `0.${version}.0`,
    source,
    vector,
    evaluation,
    lineage,
    size_bytes: Buffer.byteLength(source, 'utf8'),
    created_at: new Date().toISOString(),
  };
  insert('versions', versionRow);
  update('concepts', x => x.id === concept_id, {
    head_version: versionRow.id,
    version_count: version,
    updated_at: versionRow.created_at,
  });
  return versionRow;
}

export function getConcept(concept_id, tenant) {
  const c = findOne('concepts', x => x.id === concept_id);
  if (!c) return null;
  if (!canRead(c, tenant)) return null;
  const versions = find('versions', v => v.concept_id === concept_id);
  return { ...c, versions: versions.map(stripVector) };
}

export function getVersion(version_id, tenant) {
  const v = findOne('versions', x => x.id === version_id);
  if (!v) return null;
  const c = findOne('concepts', x => x.id === v.concept_id);
  if (!c || !canRead(c, tenant)) return null;
  return { concept: c, version: v };
}

export function getHead(concept_id, tenant) {
  const c = findOne('concepts', x => x.id === concept_id);
  if (!c || !canRead(c, tenant)) return null;
  if (!c.head_version) return null;
  return findOne('versions', v => v.id === c.head_version);
}

export function searchSimilar({ query, tenant, k = 10, tag }) {
  const q = embed(query);
  const concepts = all('concepts').filter(c => canRead(c, tenant));
  const filtered = tag ? concepts.filter(c => (c.tags || []).includes(tag)) : concepts;
  const candidates = filtered
    .map(c => {
      const head = c.head_version ? findOne('versions', v => v.id === c.head_version) : null;
      return head ? { concept: c, head } : null;
    })
    .filter(Boolean);

  const scored = candidates.map(({ concept, head }) => ({
    concept_id: concept.id,
    name: concept.name,
    description: concept.description,
    tags: concept.tags,
    quality_score: head.evaluation?.quality_score ?? null,
    score: cosine(q, head.vector),
    version_id: head.id,
    semver: head.semver,
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
}

export function listConcepts({ tenant, tag, limit = 50 }) {
  let cs = all('concepts').filter(c => canRead(c, tenant));
  if (tag) cs = cs.filter(c => (c.tags || []).includes(tag));
  cs = cs.slice(-limit).reverse();
  return cs.map(c => ({
    id: c.id, name: c.name, description: c.description,
    tags: c.tags, visibility: c.visibility,
    versions: c.version_count, head_version: c.head_version,
    updated_at: c.updated_at,
  }));
}

export function deleteConcept(concept_id, tenant) {
  const c = findOne('concepts', x => x.id === concept_id);
  if (!c) return 0;
  if (c.tenant !== tenant) throw new Error('forbidden');
  const versionN = remove('versions', v => v.concept_id === concept_id);
  const conceptN = remove('concepts', x => x.id === concept_id);
  return versionN + conceptN;
}

export function lineageOf(concept_id, tenant) {
  const head = getHead(concept_id, tenant);
  if (!head) return null;
  const upstream = (head.lineage?.synthesized_from || []).map(ref => findOne('versions', v => v.id === ref));
  const downstream = all('versions').filter(v => (v.lineage?.dependencies || []).includes(concept_id));
  return {
    concept_id,
    head_version: head.id,
    upstream: upstream.filter(Boolean).map(stripVector),
    downstream: downstream.map(stripVector),
  };
}

function canRead(concept, tenant) {
  if (concept.visibility === 'public') return true;
  return concept.tenant === tenant;
}

function stripVector(v) {
  if (!v) return v;
  const { vector, ...rest } = v;
  return { ...rest, vector_dim: vector?.length || 0 };
}

export function registryStats() {
  return storeStats();
}
