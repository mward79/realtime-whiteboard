// Helpers shared by the lobby and the board.

export const PALETTE = ['#1d1d1b', '#2557d6', '#d6352a', '#1f8a4c', '#e58a00', '#8a3ffc'];

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

export const newId = () => crypto.randomUUID?.() ?? Math.random().toString(36).slice(2) + Date.now().toString(36);

function storageGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function storageSet(key, value) {
  try { localStorage.setItem(key, value); } catch {}
}

// ---------- Room codes ----------
export const normalizeRoom = (v) => (v ?? '').toString().toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32);

export const roomFromUrl = () => normalizeRoom(new URLSearchParams(location.search).get('room'));

// Accepts a bare code ("k7p2mx") or a pasted invite link ("https://…/?room=k7p2mx").
export function roomFromInput(text) {
  const value = text.trim();
  if (value.includes('room=')) {
    try {
      return normalizeRoom(new URL(value, location.href).searchParams.get('room'));
    } catch {}
  }
  return normalizeRoom(value);
}

// No 0/o, 1/l/i so codes are easy to read aloud and type.
const CODE_CHARS = 'abcdefghjkmnpqrstuvwxyz23456789';
export function newRoomCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return [...bytes].map((b) => CODE_CHARS[b % CODE_CHARS.length]).join('');
}

export const roomUrl = (id) => `${location.origin}${location.pathname}?room=${encodeURIComponent(id)}`;

// ---------- Name ----------
export function loadName() {
  const saved = storageGet('wb-name');
  if (saved) return saved;
  const name = `${pick(['Quick', 'Calm', 'Bold', 'Sly', 'Bright', 'Lucky'])} ${pick(['Otter', 'Heron', 'Lynx', 'Moth', 'Newt', 'Finch'])}`;
  storageSet('wb-name', name);
  return name;
}

export function saveName(name) {
  const clean = name.replace(/[^\w\- ]/g, '').trim().slice(0, 24);
  if (clean) storageSet('wb-name', clean);
  return clean || loadName();
}

// ---------- Recent rooms ----------
export function recentRooms() {
  try {
    const list = JSON.parse(storageGet('wb-recent') ?? '[]');
    return Array.isArray(list) ? list.filter((r) => r && normalizeRoom(r.id) === r.id && r.id) : [];
  } catch {
    return [];
  }
}

export function rememberRoom(id) {
  const list = recentRooms().filter((r) => r.id !== id);
  list.unshift({ id, at: Date.now() });
  storageSet('wb-recent', JSON.stringify(list.slice(0, 6)));
}

export function forgetRoom(id) {
  storageSet('wb-recent', JSON.stringify(recentRooms().filter((r) => r.id !== id)));
}
