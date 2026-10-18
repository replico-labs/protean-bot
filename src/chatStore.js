import path from "path";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";
import { readJson, updateJson, writeJsonAtomic } from "./jsonFile.js";
import { supabaseMessage } from "./supabaseError.js";

/**
 * Where chat links live (db.js reads and writes through here).
 *
 * File (default): data/chats.json on the volume, shared by every process
 * under a lock file.
 *
 * Supabase (CHAT_LINKS_STORE=supabase): one row per chat in `chat_links`
 * (supabase/schema.sql), so links survive losing the volume and every
 * service sees the same ones. db.js's functions stay synchronous: each
 * process keeps all links in memory, loaded before anything else runs
 * (top-level await below), re-read every REFRESH_MS, and changes are
 * applied in memory at once and written to Supabase in order, retried
 * until they land.
 *
 * A chat is only ever changed by its own platform's process (keys are
 * "<platform>:<chatId>"), so a copy that's a few seconds old in another
 * process is never the base of a change - the listeners and keeper only
 * read.
 *
 * The first time a process finds the table empty it imports
 * data/chats.json, so switching over keeps every existing link. A copy of
 * the latest links is kept in data/chats.supabase-cache.json and used if
 * Supabase can't be reached at startup.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE_PATH = path.join(__dirname, "..", "data", "chats.json");
const CACHE_PATH = path.join(__dirname, "..", "data", "chats.supabase-cache.json");
const TABLE = "chat_links";
const REFRESH_MS = 10_000;
const PAGE = 1000;

const useSupabase = (process.env.CHAT_LINKS_STORE ?? "file").toLowerCase() === "supabase";

let links = {};               // Supabase mode: every chat's entry, by key
const pending = new Map();    // key -> entry (null = delete) not yet written
let flushing = null;
let failing = false;
let refreshFailing = false;

function client() {
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) throw new Error("CHAT_LINKS_STORE=supabase needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
  return createClient(url, serviceKey, { auth: { persistSession: false } });
}
const supabase = useSupabase ? client() : null;

async function fetchAll() {
  const all = {};
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase.from(TABLE).select("chat_key, data").order("chat_key").range(from, from + PAGE - 1);
    if (error) throw tableError(error);
    for (const row of data) all[row.chat_key] = row.data;
    if (data.length < PAGE) return all;
  }
}

function tableError(error) {
  if (error.code === "PGRST205" || error.code === "42P01") {
    return Object.assign(new Error(`Supabase has no "${TABLE}" table yet - run the chat_links part of supabase/schema.sql in the SQL editor, or unset CHAT_LINKS_STORE.`), { fatal: true });
  }
  return new Error(`Supabase ${TABLE}: ${supabaseMessage(error)}`);
}

const saveCache = () => {
  try {
    writeJsonAtomic(CACHE_PATH, links);
  } catch (err) {
    console.warn(`Couldn't write ${path.basename(CACHE_PATH)}: ${err.message}`);
  }
};

async function upsert(entries) {
  for (let i = 0; i < entries.length; i += PAGE) {
    const rows = entries.slice(i, i + PAGE).map(([chat_key, data]) => ({ chat_key, data, updated_at: new Date().toISOString() }));
    const { error } = await supabase.from(TABLE).upsert(rows);
    if (error) throw tableError(error);
  }
}

/** Loads every link; imports data/chats.json into an empty table. Falls back to the cache file if Supabase is unreachable. */
async function load() {
  for (let attempt = 1; ; attempt++) {
    try {
      links = await fetchAll();
      break;
    } catch (err) {
      if (err.fatal) throw err;
      if (attempt === 3) {
        links = readJson(CACHE_PATH, null) ?? readJson(FILE_PATH, {});
        console.warn(`Chat links: Supabase unreachable (${err.message}) - starting from the local copy (${Object.keys(links).length} chats), retrying in the background.`);
        return;
      }
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
  if (Object.keys(links).length === 0) {
    const file = readJson(FILE_PATH, {});
    const entries = Object.entries(file);
    if (entries.length) {
      await upsert(entries);
      links = file;
      console.log(`Chat links: imported ${entries.length} chats from data/chats.json into Supabase.`);
    }
  }
  saveCache();
}

async function refresh() {
  try {
    const remote = await fetchAll();
    // Not-yet-written local changes win over what Supabase still has.
    for (const [k, entry] of pending) {
      if (entry === null) delete remote[k];
      else remote[k] = entry;
    }
    links = remote;
    saveCache();
    if (refreshFailing) console.log("Chat links: Supabase reads are going through again.");
    refreshFailing = false;
  } catch (err) {
    // Once per outage, not once a minute.
    if (!failing && !refreshFailing) console.warn(`Chat links: refresh failed (${err.message}); using the copy in memory until Supabase is back.`);
    refreshFailing = true;
  }
}

/** Writes pending changes in order; on failure keeps them and retries with backoff. */
function flush() {
  if (flushing) return flushing;
  flushing = (async () => {
    for (let delay = 1000; pending.size; delay = Math.min(delay * 2, 30_000)) {
      const batch = [...pending];
      try {
        const upserts = batch.filter(([, e]) => e !== null);
        const deletes = batch.filter(([, e]) => e === null).map(([k]) => k);
        if (upserts.length) await upsert(upserts);
        if (deletes.length) {
          const { error } = await supabase.from(TABLE).delete().in("chat_key", deletes);
          if (error) throw tableError(error);
        }
        // Drop what was written, unless it changed again meanwhile.
        for (const [k, e] of batch) if (pending.get(k) === e) pending.delete(k);
        if (failing) console.log("Chat links: Supabase writes are going through again.");
        failing = false;
        delay = 500;
      } catch (err) {
        if (!failing) console.error(`Chat links: couldn't save to Supabase (${err.message}) - kept in memory, retrying.`);
        failing = true;
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  })().finally(() => {
    flushing = null;
  });
  return flushing;
}

if (useSupabase) {
  await load();
  setInterval(refresh, REFRESH_MS).unref();
}

/** Every chat link, by key. Callers must not change it. */
export function readLinks() {
  return useSupabase ? links : readJson(FILE_PATH, {});
}

/** Lets `mutate` edit all links in place and saves what changed. Returning false skips the save. */
export function updateLinks(mutate) {
  if (!useSupabase) return updateJson(FILE_PATH, {}, mutate);
  const next = structuredClone(links);
  if (mutate(next) === false) return;
  for (const k of new Set([...Object.keys(links), ...Object.keys(next)])) {
    if (!(k in next)) pending.set(k, null);
    else if (JSON.stringify(next[k]) !== JSON.stringify(links[k])) pending.set(k, next[k]);
  }
  links = next;
  saveCache();
  flush();
}

/** Resolves once every change made so far is in Supabase (scripts call this before exiting). */
export function chatLinksSaved() {
  return useSupabase ? flush() : Promise.resolve();
}

export const chatLinksStore = useSupabase ? "supabase" : "file";
