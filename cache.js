import fs from "fs";
import path from "path";

const CACHE_DIR = "./cache";
if(!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR);

/**
 * Save JSON object to cache
 * @param {string} key - unique cache key
 * @param {object} data - JSON data to store
 */
export function saveCache(key,data){
  const filePath = path.join(CACHE_DIR,key+".json");
  fs.writeFileSync(filePath,JSON.stringify(data));
}

/**
 * Load JSON object from cache
 * @param {string} key
 * @returns {object|null}
 */
export function loadCache(key){
  const filePath = path.join(CACHE_DIR,key+".json");
  if(!fs.existsSync(filePath)) return null;
  try{
    return JSON.parse(fs.readFileSync(filePath));
  }catch{return null;}
}
