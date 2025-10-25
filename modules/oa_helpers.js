// modules/oa_helpers.js
import fetch from "node-fetch";
import OpenAI from "openai";
import { saveCache, loadCache } from "../cache.js";

import pkg from "ml-kmeans";
const { kmeans } = pkg;

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const UNPAYWALL_EMAIL = process.env.UNPAYWALL_EMAIL || "YOUR_EMAIL@example.com";

// Shared pool & clustering state
export const candidateArticlesPool = [];
export let topicClusters = [];
export let topicCentroids = [];

/**
 * Add candidate articles to the shared pool (dedupe optional)
 * @param {Array} arr
 */
export function addCandidates(arr = []) {
  // basic dedupe by DOI
  const seen = new Set(candidateArticlesPool.map(a => (a.doi||"").toLowerCase()));
  for (const a of arr) {
    const k = (a.doi || "").toLowerCase();
    if (!k || seen.has(k)) continue;
    candidateArticlesPool.push(a);
    seen.add(k);
  }
}

/** Cached Unpaywall OA check */
export async function checkOA(doi) {
  if (!doi) return null;
  const cacheKey = `unpaywall_${doi.replace(/\//g, "_")}`;
  const cached = loadCache(cacheKey);
  if (cached) return cached;

  const url = `https://api.unpaywall.org/v2/${encodeURIComponent(doi)}?email=${UNPAYWALL_EMAIL}`;
  try {
    const resp = await fetch(url);
    if (!resp.ok) return null;
    const data = await resp.json();
    saveCache(cacheKey, data);
    return data;
  } catch (err) {
    return null;
  }
}

/** Initialize semantic clusters from candidateArticlesPool */
export async function initializeSemanticClusters() {
  if (candidateArticlesPool.length < 2) {
    topicClusters = [];
    topicCentroids = [];
    return;
  }

  const embeddings = [];
  for (const art of candidateArticlesPool) {
    const key = "embedding_" + (art.doi || "").replace(/\//g, "_");
    let emb = loadCache(key);
    if (!emb && (art.abstract || art.title)) {
      const input = art.abstract || art.title;
      const resp = await openai.embeddings.create({ model: "text-embedding-3-large", input });
      emb = resp.data?.[0]?.embedding;
      if (emb) saveCache(key, emb);
    }
    embeddings.push(emb || new Array(1536).fill(0)); // fallback zero vector
  }

  const numClusters = Math.min(5, Math.max(1, Math.floor(Math.sqrt(candidateArticlesPool.length / 2))));
  const km = kmeans(embeddings, numClusters);
  topicClusters = km.clusters.map((clusterIdx, i) => ({ cluster: clusterIdx, article: candidateArticlesPool[i] }));
  topicCentroids = km.centroids;
}

/** Generate related OA articles using embeddings + cluster preference */
export async function generateRelatedArticles(pdfText, doi, opts = {}) {
  // load/create embedding for this doc
  const cacheKey = "embedding_" + (doi || "anon").replace(/\//g, "_");
  let mainVector = loadCache(cacheKey);
  if (!mainVector) {
    const embResp = await openai.embeddings.create({ model: "text-embedding-3-large", input: pdfText });
    mainVector = embResp.data?.[0]?.embedding;
    if (mainVector) saveCache(cacheKey, mainVector);
  }
  if (!mainVector) return [];

  function cosineSim(a, b) {
    if (!a || !b || a.length !== b.length) return -1;
    let dot = 0, ma = 0, mb = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      ma += a[i] * a[i];
      mb += b[i] * b[i];
    }
    ma = Math.sqrt(ma); mb = Math.sqrt(mb);
    return (ma && mb) ? dot / (ma * mb) : -1;
  }

  // find closest cluster centroid
  let closestCluster = null;
  if (topicCentroids && topicCentroids.length) {
    let best = -Infinity;
    for (let i = 0; i < topicCentroids.length; i++) {
      const sim = cosineSim(mainVector, topicCentroids[i] || []);
      if (sim > best) { best = sim; closestCluster = i; }
    }
  }

  const clusterMembers = topicClusters.filter(c => c.cluster === closestCluster && c.article.doi !== doi).map(c => c.article);
  const searchPool = clusterMembers.length ? clusterMembers : candidateArticlesPool;

  // score pool
  const scored = [];
  for (const art of searchPool) {
    if (!art.doi) continue;
    const embKey = "embedding_" + art.doi.replace(/\//g, "_");
    let artEmb = loadCache(embKey);
    if (!artEmb && art.abstract) {
      const resp = await openai.embeddings.create({ model: "text-embedding-3-large", input: art.abstract });
      artEmb = resp.data?.[0]?.embedding;
      if (artEmb) saveCache(embKey, artEmb);
    }
    const score = cosineSim(mainVector, artEmb || []);
    scored.push({ art, score });
  }

  scored.sort((a, b) => (b.score || 0) - (a.score || 0));

  // verify OA for top candidates
  const topCandidates = [];
  for (const s of scored.slice(0, 10)) {
    const oa = await checkOA(s.art.doi);
    if (oa && oa.is_oa && oa.best_oa_location?.url_for_pdf) {
      topCandidates.push({
        title: s.art.title || oa.title || "Unknown",
        doi: s.art.doi,
        source: s.art.source || oa.journal_name || "OA Source",
        pdf_url: oa.best_oa_location.url_for_pdf
      });
    }
  }

  return topCandidates;
}
