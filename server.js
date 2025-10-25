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
import { candidateArticlesPool, addCandidates, initializeSemanticClusters, generateRelatedArticles, checkOA } from "./modules/oa_helpers.js";

import 'dotenv/config';

const app = express();
app.use(express.json());

const CACHE_DIR = "./cache";
const PDF_DIR = "./pdfs";
if(!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR);
if(!fs.existsSync(PDF_DIR)) fs.mkdirSync(PDF_DIR);

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const UNPAYWALL_EMAIL = process.env.UNPAYWALL_EMAIL || "YOUR_EMAIL@example.com";

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
  addCandidates(results);
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