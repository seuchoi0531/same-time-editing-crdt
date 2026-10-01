const clientId = crypto.randomUUID();
const root = '__root__';
const editor = document.querySelector('#editor');
const highlighter = document.querySelector('#highlighter');
const colorInput = document.querySelector('#color');
const roomInput = document.querySelector('#room');
const params = new URLSearchParams(location.search);
let room = (params.get('room') || 'presentation').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 48) || 'presentation';
roomInput.value = room;
let socket, ready = false, counter = 0, operationCount = 0, applying = false;
const nodes = new Map(); const children = new Map([[root, new Set()]]); const deletedBeforeInsert = new Set(); const seenOperations = new Set();
const $ = (selector) => document.querySelector(selector);
colorInput.value = localStorage.getItem('crdt-editor-color') || colorInput.value;
function addNode(atom) { if (!atom?.id || nodes.has(atom.id)) return; const node = { ...atom, deleted: deletedBeforeInsert.has(atom.id) }; nodes.set(atom.id, node); if (!children.has(node.after)) children.set(node.after, new Set()); children.get(node.after).add(node.id); if (!children.has(node.id)) children.set(node.id, new Set()); }
function orderedIds(parent = root, output = []) { const siblings = [...(children.get(parent) || [])].sort(); for (const id of siblings) { const node = nodes.get(id); if (!node) continue; if (!node.deleted) output.push(id); orderedIds(id, output); } return output; }
function current() { const ids = orderedIds(); return { ids, text: ids.map((id) => nodes.get(id).value).join('') }; }
function updateStats() { const visible = current(); $('#elements').textContent = nodes.size; $('#tombstones').textContent = [...nodes.values()].filter((node) => node.deleted).length; $('#characters').textContent = `${visible.text.length}자`; }
function paint(view) { highlighter.replaceChildren(); let start = 0; while (start < view.text.length) { const color = nodes.get(view.ids[start]).color || '#dbe7ef'; let end = start + 1; while (end < view.text.length && (nodes.get(view.ids[end]).color || '#dbe7ef') === color) end++; const mark = document.createElement('span'); mark.className = 'author-mark'; mark.style.setProperty('--mark', color); mark.textContent = view.text.slice(start, end); highlighter.append(mark); start = end; } if (view.text.endsWith('\n')) highlighter.append(document.createElement('br')); highlighter.scrollTop = editor.scrollTop; highlighter.scrollLeft = editor.scrollLeft; }
function render(selectionStart = editor.selectionStart, selectionEnd = editor.selectionEnd) { const view = current(); applying = true; editor.value = view.text; paint(view); editor.setSelectionRange(Math.min(selectionStart, view.text.length), Math.min(selectionEnd, view.text.length)); applying = false; updateStats(); }
function label(operation) { return operation.type === 'insert' ? `삽입 ${operation.atoms.length}개 · after ${operation.atoms[0]?.after === root ? 'ROOT' : '원소'}` : `삭제 ${operation.ids.length}개 원소`; }
function timeOf(value = new Date()) { return new Intl.DateTimeFormat('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(value)); }
function log(operation, kind, timestamp) { const list = $('#log'); list.querySelector('.empty')?.remove(); const color = operation.color || operation.atoms?.[0]?.color || '#9aaba0'; const item = document.createElement('li'); item.style.gridTemplateColumns = '70px 10px 1fr'; item.innerHTML = `<time>${timeOf(timestamp)}</time><i class="log-swatch" style="--editor-color:${color}"></i><span>${kind} · ${label(operation)}</span>`; list.prepend(item); while (list.children.length > 16) list.lastElementChild.remove(); }
function anchorAt(index) { const ids = current().ids; return index > 0 ? ids[index - 1] : root; }
function indexAfter(anchor, fallback) { if (anchor === root) return 0; const index = current().ids.indexOf(anchor); return index === -1 ? fallback : index + 1; }
function integrate(operation, kind, timestamp) {
  if (!operation?.id || seenOperations.has(operation.id)) return false; seenOperations.add(operation.id); operationCount++;
  const startAnchor = anchorAt(editor.selectionStart), endAnchor = anchorAt(editor.selectionEnd); const oldStart = editor.selectionStart, oldEnd = editor.selectionEnd;
  if (operation.type === 'insert') for (const atom of operation.atoms || []) addNode(atom);
  if (operation.type === 'delete') for (const id of operation.ids || []) { const node = nodes.get(id); if (node) node.deleted = true; else deletedBeforeInsert.add(id); }
  render(indexAfter(startAnchor, oldStart), indexAfter(endAnchor, oldEnd)); log(operation, kind, timestamp || operation.timestamp); return true;
}
function createInsert(position, text) { let after = position === 0 ? root : current().ids[position - 1]; const atoms = [...text].map((value) => { const atom = { id: `${clientId}:${++counter}`, after, value, color: colorInput.value }; after = atom.id; return atom; }); return { type: 'insert', id: `${clientId}:op:${++counter}`, atoms }; }
function createDelete(position, length) { return { type: 'delete', id: `${clientId}:op:${++counter}`, color: colorInput.value, ids: current().ids.slice(position, position + length) }; }
function send(operation) { integrate(operation, '내 수정'); if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'operation', clientId, operation })); }
function diff(before, after) { let prefix = 0; while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++; let suffix = 0; while (suffix < before.length - prefix && suffix < after.length - prefix && before.at(-1 - suffix) === after.at(-1 - suffix)) suffix++; return { position: prefix, removed: before.length - prefix - suffix, added: after.slice(prefix, after.length - suffix) }; }
editor.addEventListener('input', () => { if (applying || !ready) return; const before = current().text, change = diff(before, editor.value); if (change.removed) send(createDelete(change.position, change.removed)); if (change.added) send(createInsert(change.position, change.added)); });
function connect() { const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'; socket = new WebSocket(`${protocol}//${location.host}`); socket.addEventListener('open', () => { $('#connection').textContent = '동기화 중'; socket.send(JSON.stringify({ type: 'join', room })); }); socket.addEventListener('close', () => { ready = false; editor.disabled = true; $('#connection').textContent = '재연결 중'; setTimeout(connect, 1200); }); socket.addEventListener('message', ({ data }) => { const message = JSON.parse(data); if (message.type === 'snapshot') { for (const operation of message.operations) integrate(operation, '기존 기록', operation.timestamp); ready = true; editor.disabled = false; $('#connection').textContent = '연결됨'; $('#peers').textContent = `${message.peers}명`; return; } if (message.type === 'operation') integrate(message.operation, message.author === clientId ? '내 수정' : '다른 사람', message.timestamp); if (message.type === 'presence') $('#peers').textContent = `${message.peers}명`; }); }
editor.addEventListener('scroll', () => { highlighter.scrollTop = editor.scrollTop; highlighter.scrollLeft = editor.scrollLeft; });
colorInput.addEventListener('input', () => localStorage.setItem('crdt-editor-color', colorInput.value));
function tickClock() { $('#clock').textContent = timeOf(); }
tickClock(); setInterval(tickClock, 1000);
$('#copy').addEventListener('click', () => { const next = roomInput.value.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 48) || 'presentation'; location.href = `${location.pathname}?room=${encodeURIComponent(next)}`; });
$('#clear-log').addEventListener('click', () => { $('#log').innerHTML = '<li class="empty">첫 편집을 기다리고 있습니다.</li>'; });
connect();
