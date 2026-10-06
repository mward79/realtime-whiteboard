import { loadName, saveName, newRoomCode, roomFromInput, roomUrl, recentRooms, forgetRoom } from './shared.js';

const lobby = document.getElementById('lobby');
const nameInput = document.getElementById('name');
const joinForm = document.getElementById('join-form');
const joinInput = document.getElementById('join-code');
const joinError = document.getElementById('join-error');
const recentWrap = document.getElementById('recent-wrap');
const recentList = document.getElementById('recent');

lobby.hidden = false;
document.title = 'Whiteboard';
nameInput.value = loadName();

function go(roomId) {
  saveName(nameInput.value);
  location.href = roomUrl(roomId);
}

nameInput.addEventListener('change', () => (nameInput.value = saveName(nameInput.value)));

document.getElementById('create').addEventListener('click', () => go(newRoomCode()));

joinForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const roomId = roomFromInput(joinInput.value);
  if (!roomId) {
    joinError.textContent = 'Enter a room code (like k7p2mx) or paste an invite link.';
    joinInput.focus();
    return;
  }
  go(roomId);
});
joinInput.addEventListener('input', () => (joinError.textContent = ''));

function timeAgo(ms) {
  const mins = Math.round((Date.now() - ms) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

function renderRecent() {
  const rooms = recentRooms();
  recentWrap.hidden = rooms.length === 0;
  recentList.replaceChildren(
    ...rooms.map((r) => {
      const li = document.createElement('li');
      const open = document.createElement('button');
      open.className = 'recent-open';
      open.innerHTML = '<strong></strong><span></span>';
      open.querySelector('strong').textContent = r.id;
      open.querySelector('span').textContent = timeAgo(r.at);
      open.addEventListener('click', () => go(r.id));
      const remove = document.createElement('button');
      remove.className = 'recent-remove';
      remove.textContent = '×';
      remove.setAttribute('aria-label', `Remove ${r.id} from recent boards`);
      remove.addEventListener('click', () => {
        forgetRoom(r.id);
        renderRecent();
      });
      li.append(open, remove);
      return li;
    })
  );
}
renderRecent();
