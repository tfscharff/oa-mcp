import express from "express";
import fs from "fs";
import path from "path";
import pdfParse from "pdf-parse";
import fetch from "node-fetch";
import OpenAI from "openai";
import { kmeans } from "ml-kmeans";

import { searchOpenAlex } from "./adapters/openalex.js";
import { searchDOAJ } from "./adapters/doaj.js";
import { saveCache, loadCache } from "./cache.js";
import { analyzeArticlesAndReferences } from "./modules/analyze.js";

import 'dotenv/config';

const app = express();
app.use(express.json());

const CACHE_DIR = "./cache";
const PDF_DIR = "./pdfs";
if(!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR);
if(!fs.existsSync(PDF_DIR)) fs.mkdirSync(PDF_DIR);

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const UNPAYWALL_EMAIL = process.env.UNPAYWALL_EMAIL || "YOUR_EMAIL@example.com";

// Candidate pool for semantic search and clustering
let candidateArticlesPool = [];


// -----------------------------------
// OA Verification Helper
// -----------------------------------
async function checkOA(doi){
  const cacheKey = doi.replace(/\//g,"_");
  const cached = loadCache(cacheKey);
  if(cached) return cached;

  const apiUrl = `https://api.unpaywall.org/v2/${encodeURIComponent(doi)}?email=${UNPAYWALL_EMAIL}`;
  try{
    const resp = await fetch(apiUrl);
    if(!resp.ok) return null;
    const data = await resp.json();
    saveCache(cacheKey,data);
    return data;
  }catch{return null;}
}


// -----------------------------------
// Semantic AI-based Related Articles
// -----------------------------------
async function generateRelatedArticles(pdfText, doi) {
  const cacheKey = "embedding_" + doi.replace(/\//g, "_");
  let mainVector = loadCache(cacheKey);

  if (!mainVector) {
    const embResp = await openai.embeddings.create({
      model: "text-embedding-3-large",
      input: pdfText
    });
    mainVector = embResp.data[0].embedding;
    saveCache(cacheKey, mainVector);
  }

  function cosineSim(a, b) {
    const dot = a.reduce((sum, v, i) => sum + v * b[i], 0);
    const magA = Math.sqrt(a.reduce((sum, v) => sum + v * v, 0));
    const magB = Math.sqrt(b.reduce((sum, v) => sum + b * b[i], 0));
    return dot / (magA * magB);
  }

  // Find the cluster whose centroid is closest to this paper
  let closestCluster = null;
  let highestSim = -Infinity;

  for (let i = 0; i < topicCentroids.length; i++) {
    const sim = cosineSim(mainVector, topicCentroids[i]);
    if (sim > highestSim) {
      highestSim = sim;
      closestCluster = i;
    }
  }

  // Prefer articles in the same cluster
  const clusterMembers = topicClusters
    .filter(c => c.cluster === closestCluster && c.article.doi !== doi)
    .map(c => c.article);

  // Fall back to all candidates if cluster is empty
  const searchPool = clusterMembers.length > 0 ? clusterMembers : candidateArticlesPool;

  const scored = [];
  for (const art of searchPool) {
    if (!art.abstract) continue;

    let artEmbedding = loadCache("embedding_" + art.doi.replace(/\//g, "_"));
    if (!artEmbedding) {
      const embResp = await openai.embeddings.create({
        model: "text-embedding-3-large",
        input: art.abstract
      });
      artEmbedding = embResp.data[0].embedding;
      saveCache("embedding_" + art.doi.replace(/\//g, "_"), artEmbedding);
    }

    scored.push({ ...art, score: cosineSim(mainVector, artEmbedding) });
  }

  scored.sort((a, b) => b.score - a.score);

  // Verify OA for top 5–10
  const topCandidates = [];
  for (const art of scored.slice(0, 10)) {
    const oaInfo = await checkOA(art.doi);
    if (oaInfo && oaInfo.is_oa && oaInfo.best_oa_location?.url_for_pdf) {
      topCandidates.push({
        title: art.title,
        doi: art.doi,
        source: art.source || "OA Source",
        pdf_url: oaInfo.best_oa_location.url_for_pdf
      });
    }
  }

  return topCandidates;
}

// -----------------------------------
// Semantic Topic Clustering
// -----------------------------------
let topicClusters = [];
let topicCentroids = [];

async function initializeSemanticClusters() {
  if (candidateArticlesPool.length < 5) {
    console.log("Skipping clustering — too few candidates.");
    return;
  }

  console.log("Building semantic clusters...");

  const embeddings = [];
  for (const art of candidateArticlesPool) {
    let artEmbedding = loadCache("embedding_" + art.doi.replace(/\//g, "_"));
    if (!artEmbedding) {
      const embResp = await openai.embeddings.create({
        model: "text-embedding-3-large",
        input: art.abstract || art.title
      });
      artEmbedding = embResp.data[0].embedding;
      saveCache("embedding_" + art.doi.replace(/\//g, "_"), artEmbedding);
    }
    embeddings.push(artEmbedding);
  }

  const numClusters = Math.min(5, Math.floor(Math.sqrt(candidateArticlesPool.length / 2))); // adaptive
  const kmeansResult = kmeans(embeddings, numClusters);

  topicClusters = kmeansResult.clusters.map((clusterIdx, i) => ({
    cluster: clusterIdx,
    article: candidateArticlesPool[i]
  }));
  topicCentroids = kmeansResult.centroids;

  console.log(`✓ Created ${numClusters} semantic clusters`);
}

// -----------------------------------
// MCP endpoints
// -----------------------------------
app.get("/.well-known/mcp.json",(req,res)=>{
  res.json({
    name:"OA Verified Discovery MCP",
    description:"Search OA articles, serve PDFs, analyze references, suggest related OA articles",
    version:"1.2.0",
    endpoints:[
      {
        name:"search_oa",
        description:"Search OA content with PDF retrieval and AI analysis",
        input_schema:"/schemas/search_oa.json",
        output_schema:"/schemas/search_oa.json"
      }
    ]
  });
});

app.post("/search_oa", async (req,res)=>{
  const { query, type="all", year_from, year_to, max_results=20 } = req.body;
  if(!query) return res.status(400).json({error:"Missing query"});

  // -----------------------------
  // Step 1 & 2: Search and fetch PDFs
  // -----------------------------
  let results = [];
  const [oa1, oa2] = await Promise.all([
    searchOpenAlex(query,type,year_from,year_to,PDF_DIR),
    searchDOAJ(query,type,year_from,year_to,PDF_DIR)
  ]);
  results.push(...oa1,...oa2);

  // Update candidate pool for semantic AI
  candidateArticlesPool.push(...results);
  
  await initializeSemanticClusters();

  // Deduplicate
  const deduped = Object.values(results.reduce((acc,r)=>{
    const key = r.doi.toLowerCase();
    if(!acc[key]) acc[key]=r;
    return acc;
  },{})).slice(0,max_results);

// Step 3: AI analysis and reference verification
const analyzed = await analyzeArticlesAndReferences(deduped);

// Step 4: AI-suggested related articles
res.json({ results: analyzed });
});

// Serve PDFs directly
app.get("/article/:doi/pdf",(req,res)=>{
  const doi = req.params.doi.replace(/\//g,"_");
  const filePath = path.join(PDF_DIR, `${doi}.pdf`);
  if(!fs.existsSync(filePath)) return res.status(404).send("PDF not found");
  res.sendFile(path.resolve(filePath));
});

// -----------------------------------
// 🕒 Optional: Background cluster refresh
// -----------------------------------
const CLUSTER_REFRESH_INTERVAL = 30 * 60 * 1000; // every 30 minutes

setInterval(async () => {
  if (candidateArticlesPool.length > 0) {
    console.log("⏳ Recomputing semantic clusters in background...");
    try {
      await initializeSemanticClusters();
      console.log("✅ Clusters refreshed successfully");
    } catch (err) {
      console.error("❌ Error refreshing clusters:", err.message);
    }
  }
}, CLUSTER_REFRESH_INTERVAL);

// Start server
const PORT = process.env.PORT||3000;
app.listen(PORT,()=>console.log(`OA MCP server with AI running on port ${PORT}`));