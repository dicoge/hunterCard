/**
 * Push notification storage helper.
 *
 * Vercel serverless functions have a read-only bundle filesystem, so state is
 * kept under /tmp. This survives within a warm instance but not across cold
 * starts — good enough for the "先用 /tmp + 定期 commit" bootstrap; swap the
 * read/write helpers for Vercel KV once a persistent store is provisioned.
 */
import fs from 'fs';
import path from 'path';

const DATA_DIR = '/tmp';
const TOKENS_FILE = path.join(DATA_DIR, 'push-tokens.json');
const WATCHLIST_FILE = path.join(DATA_DIR, 'push-watchlist.json');

export interface WatchlistEntry {
  cards: string[];
  updatedAt: string;
}

export interface PushWatchlist {
  tokens: Record<string, WatchlistEntry>;
}

export type WatchlistAction = 'add' | 'remove';

function readJson<T>(file: string, fallback: T): T {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as T;
  } catch {
    return fallback;
  }
}

function writeJson(file: string, data: unknown): void {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8');
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Append a device token (deduped). Returns the full token list. */
export function addToken(token: string): string[] {
  const tokens = readJson<string[]>(TOKENS_FILE, []);
  if (!tokens.includes(token)) {
    tokens.push(token);
    writeJson(TOKENS_FILE, tokens);
  }
  return tokens;
}

export function getTokens(): string[] {
  return readJson<string[]>(TOKENS_FILE, []);
}

export function getWatchlist(): PushWatchlist {
  return readJson<PushWatchlist>(WATCHLIST_FILE, { tokens: {} });
}

/** Add or remove a card from a token's watchlist. Returns the updated entry. */
export function updateWatchlist(
  token: string,
  cardNumber: string,
  action: WatchlistAction
): WatchlistEntry {
  const data = getWatchlist();
  const entry = data.tokens[token] || { cards: [], updatedAt: today() };
  const set = new Set(entry.cards);

  if (action === 'add') set.add(cardNumber);
  else set.delete(cardNumber);

  const updated: WatchlistEntry = { cards: [...set], updatedAt: today() };
  data.tokens[token] = updated;
  writeJson(WATCHLIST_FILE, data);
  return updated;
}
