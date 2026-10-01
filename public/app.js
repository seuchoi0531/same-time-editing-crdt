const clientId = crypto.randomUUID();
const root = "__root__";
const editor = document.querySelector("#editor");
const highlighter = document.querySelector("#highlighter");
const colorInput = document.querySelector("#color");
const roomInput = document.querySelector("#room");
const params = new URLSearchParams(location.search);
let room =
  (params.get("room") || "presentation")
    .replace(/[^a-zA-Z0-9_-]/g, "")
    .slice(0, 48) || "presentation";
roomInput.value = room;
let socket,
  ready = false,
  counter = 0,
  operationCount = 0,
  applying = false;
const nodes = new Map();
const children = new Map([[root, new Set()]]);
const deletedBeforeInsert = new Set();
const seenOperations = new Set();
const $ = (selector) => document.querySelector(selector);
colorInput.value =
  localStorage.getItem("crdt-editor-color") || colorInput.value;
// [CRDT-08] 새 문자 원소를 ID로 저장하고, after와 right가 가리키는 양쪽 경계를 보존한다. 삭제가 먼저 도착한 원소도 처리한다.
function addNode(atom) {
  if (!atom?.id || nodes.has(atom.id)) return;
  const node = {
    ...atom,
    right: atom.right || null,
    deleted: deletedBeforeInsert.has(atom.id),
  };
  nodes.set(atom.id, node);
  if (!children.has(node.after)) children.set(node.after, new Set());
  children.get(node.after).add(node.id);
  if (!children.has(node.id)) children.set(node.id, new Set());
}
function rightChainLeadsTo(node, targetId) {
  const visited = new Set();
  let nextId = node.right;
  while (nextId && !visited.has(nextId)) {
    if (nextId === targetId) return true;
    visited.add(nextId);
    nextId = nodes.get(nextId)?.right || null;
  }
  return false;
}
// [CRDT-09] right 경계가 가리키는 원소보다 앞에 배치하고, 같은 경계를 공유하는 동시 삽입만 ID로 정렬한다.
function compareSiblings(leftId, rightId) {
  const left = nodes.get(leftId);
  const right = nodes.get(rightId);
  if (!left || !right) return leftId.localeCompare(rightId);
  if (rightChainLeadsTo(left, rightId)) return -1;
  if (rightChainLeadsTo(right, leftId)) return 1;
  return leftId.localeCompare(rightId);
}
function orderedIds(parent = root, output = []) {
  const siblings = [...(children.get(parent) || [])].sort(compareSiblings);
  for (const id of siblings) {
    const node = nodes.get(id);
    if (!node) continue;
    if (!node.deleted) output.push(id);
    orderedIds(id, output);
  }
  return output;
}
function current() {
  const ids = orderedIds();
  return { ids, text: ids.map((id) => nodes.get(id).value).join("") };
}
function updateStats() {
  const visible = current();
  $("#elements").textContent = nodes.size;
  $("#tombstones").textContent = [...nodes.values()].filter(
    (node) => node.deleted,
  ).length;
  $("#characters").textContent = `${visible.text.length}자`;
}
function paint(view) {
  highlighter.replaceChildren();
  let start = 0;
  while (start < view.text.length) {
    const color = nodes.get(view.ids[start]).color || "#dbe7ef";
    let end = start + 1;
    while (
      end < view.text.length &&
      (nodes.get(view.ids[end]).color || "#dbe7ef") === color
    )
      end++;
    const mark = document.createElement("span");
    mark.className = "author-mark";
    mark.style.setProperty("--mark", color);
    mark.textContent = view.text.slice(start, end);
    highlighter.append(mark);
    start = end;
  }
  if (view.text.endsWith("\n"))
    highlighter.append(document.createElement("br"));
  highlighter.scrollTop = editor.scrollTop;
  highlighter.scrollLeft = editor.scrollLeft;
}
// [CRDT-10] 삭제 표식이 없는 원소만 문자열과 색상 레이어로 렌더링해 현재 문서 복제본을 표시한다.
function render(
  selectionStart = editor.selectionStart,
  selectionEnd = editor.selectionEnd,
) {
  const view = current();
  applying = true;
  editor.value = view.text;
  paint(view);
  editor.setSelectionRange(
    Math.min(selectionStart, view.text.length),
    Math.min(selectionEnd, view.text.length),
  );
  applying = false;
  updateStats();
}
function label(operation) {
  if (operation.type === "delete") return `삭제 ${operation.ids.length}개 원소`;
  const first = operation.atoms[0];
  return `삽입 ${operation.atoms.length}개 · after ${first?.after === root ? "ROOT" : "원소"} · right ${first?.right ? "원소" : "끝"}`;
}
function timeOf(value = new Date()) {
  const date = new Date(value);
  const clock = new Intl.DateTimeFormat("ko-KR", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
  return `${clock}.${String(Math.floor(date.getMilliseconds() / 10)).padStart(2, "0")}`;
}
function log(operation, kind, timestamp) {
  const list = $("#log");
  list.querySelector(".empty")?.remove();
  const color = operation.color || operation.atoms?.[0]?.color || "#9aaba0";
  const item = document.createElement("li");
  item.style.gridTemplateColumns = "70px 10px 1fr";
  item.innerHTML = `<time>${timeOf(timestamp)}</time><i class="log-swatch" style="--editor-color:${color}"></i><span>${kind} · ${label(operation)}</span>`;
  list.prepend(item);
  while (list.children.length > 16) list.lastElementChild.remove();
}
function anchorAt(index) {
  const ids = current().ids;
  return index > 0 ? ids[index - 1] : root;
}
function indexAfter(anchor, fallback) {
  if (anchor === root) return 0;
  const index = current().ids.indexOf(anchor);
  return index === -1 ? fallback : index + 1;
}
// [CRDT-07] 삽입 원소는 추가하고, 삭제 연산은 대상 ID에 tombstone을 남긴 뒤 현재 복제본을 다시 렌더링한다.
function integrate(operation, kind, timestamp, { renderDocument = true } = {}) {
  if (!operation?.id || seenOperations.has(operation.id)) return false;
  seenOperations.add(operation.id);
  operationCount++;
  const startAnchor = anchorAt(editor.selectionStart),
    endAnchor = anchorAt(editor.selectionEnd);
  const oldStart = editor.selectionStart,
    oldEnd = editor.selectionEnd;
  if (operation.type === "insert")
    for (const atom of operation.atoms || []) addNode(atom);
  if (operation.type === "delete")
    for (const id of operation.ids || []) {
      const node = nodes.get(id);
      if (node) node.deleted = true;
      else deletedBeforeInsert.add(id);
    }
  if (renderDocument)
    render(indexAfter(startAnchor, oldStart), indexAfter(endAnchor, oldEnd));
  log(operation, kind, timestamp || operation.timestamp);
  return true;
}
// [CRDT-05] 현재 위치의 앞·뒤 원소 ID를 after와 right에 기록한다. 따라서 삽입은 숫자 위치가 아니라 양쪽 원소 관계를 전송한다.
function createInsert(position, text) {
  const ids = current().ids;
  let after = position === 0 ? root : ids[position - 1];
  const right = ids[position] || null;
  const atoms = [...text].map((value) => {
    const atom = {
      id: `${clientId}:${++counter}`,
      after,
      right,
      value,
      color: colorInput.value,
    };
    after = atom.id;
    return atom;
  });
  return { type: "insert", id: `${clientId}:op:${++counter}`, atoms };
}
// [CRDT-05] 삭제도 숫자 범위 대신 현재 위치에 있던 원소 ID 목록으로 만든다.
function createDelete(position, length) {
  return {
    type: "delete",
    id: `${clientId}:op:${++counter}`,
    color: colorInput.value,
    ids: current().ids.slice(position, position + length),
  };
}
// [CRDT-06] 로컬 연산들을 먼저 한 번에 병합하고, 입력 뒤 브라우저가 만든 커서 위치를 유지한 채 서버로 전송한다.
function send(operations, selectionStart, selectionEnd) {
  for (const operation of operations)
    integrate(operation, "내 수정", undefined, { renderDocument: false });
  render(selectionStart, selectionEnd);
  if (socket?.readyState !== WebSocket.OPEN) return;
  for (const operation of operations)
    socket.send(JSON.stringify({ type: "operation", clientId, operation }));
}
function diff(before, after) {
  let prefix = 0;
  while (
    prefix < before.length &&
    prefix < after.length &&
    before[prefix] === after[prefix]
  )
    prefix++;
  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before.at(-1 - suffix) === after.at(-1 - suffix)
  )
    suffix++;
  return {
    position: prefix,
    removed: before.length - prefix - suffix,
    added: after.slice(prefix, after.length - suffix),
  };
}
// [CRDT-04] 입력 이벤트에서 달라진 텍스트 범위를 찾아 삽입 또는 삭제 연산 생성을 시작한다.
editor.addEventListener("input", () => {
  if (applying || !ready) return;
  const before = current().text,
    change = diff(before, editor.value);
  const operations = [];
  if (change.removed) operations.push(createDelete(change.position, change.removed));
  if (change.added) operations.push(createInsert(change.position, change.added));
  if (operations.length)
    send(operations, editor.selectionStart, editor.selectionEnd);
});
// [CRDT-06] 연결 시 받은 전체 연산 로그와 이후 중계 연산을 수신해 같은 integrate 경로로 처리한다.
function connect() {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  socket = new WebSocket(`${protocol}//${location.host}`);
  socket.addEventListener("open", () => {
    $("#connection").textContent = "동기화 중";
    socket.send(JSON.stringify({ type: "join", room }));
  });
  socket.addEventListener("close", () => {
    ready = false;
    editor.disabled = true;
    $("#connection").textContent = "재연결 중";
    setTimeout(connect, 1200);
  });
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    if (message.type === "snapshot") {
      for (const operation of message.operations)
        integrate(operation, "기존 기록", operation.timestamp);
      ready = true;
      editor.disabled = false;
      $("#connection").textContent = "연결됨";
      $("#peers").textContent = `${message.peers}명`;
      return;
    }
    if (message.type === "operation")
      integrate(
        message.operation,
        message.author === clientId ? "내 수정" : "다른 사람",
        message.timestamp,
      );
    if (message.type === "presence")
      $("#peers").textContent = `${message.peers}명`;
  });
}
editor.addEventListener("scroll", () => {
  highlighter.scrollTop = editor.scrollTop;
  highlighter.scrollLeft = editor.scrollLeft;
});
colorInput.addEventListener("input", () =>
  localStorage.setItem("crdt-editor-color", colorInput.value),
);
function tickClock() {
  $("#clock").textContent = timeOf();
}
tickClock();
setInterval(tickClock, 10);
$("#copy").addEventListener("click", () => {
  const next =
    roomInput.value.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 48) ||
    "presentation";
  location.href = `${location.pathname}?room=${encodeURIComponent(next)}`;
});
$("#clear-log").addEventListener("click", () => {
  $("#log").innerHTML = '<li class="empty">첫 편집을 기다리고 있습니다.</li>';
});
connect();
