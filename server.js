const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");
const publicDir = path.join(__dirname, "public");
const rooms = new Map();
const idOf = (value) =>
  String(value || "presentation")
    .replace(/[^a-zA-Z0-9_-]/g, "")
    .slice(0, 48) || "presentation";
// [CRDT-01] 방은 현재 문서 문자열이 아니라, 모든 삽입·삭제 연산과 중복 방지용 ID 집합을 보관한다.
const roomFor = (id) => {
  if (!rooms.has(id))
    rooms.set(id, {
      operations: [],
      operationIds: new Set(),
      clients: new Set(),
    });
  return rooms.get(id);
};
const broadcast = (room, message) => {
  const body = JSON.stringify(message);
  for (const client of room.clients)
    if (client.readyState === client.OPEN) client.send(body);
};
const server = http.createServer((req, res) => {
  const pathname = req.url.split("?")[0];
  const requested = pathname === "/" ? "/index.html" : pathname;
  const target = path.resolve(publicDir, `.${requested}`);
  if (
    !target.startsWith(publicDir) ||
    !fs.existsSync(target) ||
    fs.statSync(target).isDirectory()
  ) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }
  const types = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
  };
  res.writeHead(200, {
    "Content-Type": types[path.extname(target)] || "application/octet-stream",
    "Cache-Control": "no-store",
  });
  fs.createReadStream(target).pipe(res);
});
const wss = new WebSocketServer({ server });
wss.on("connection", (socket) => {
  let activeRoom;
  socket.on("message", (raw) => {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    // [CRDT-02] 새 참여자에게는 확정 텍스트 대신 누적 연산 로그 전체를 전달해, 브라우저가 복제본을 다시 구성하게 한다.
    if (message.type === "join") {
      activeRoom = roomFor(idOf(message.room));
      activeRoom.clients.add(socket);
      socket.send(
        JSON.stringify({
          type: "snapshot",
          operations: activeRoom.operations,
          peers: activeRoom.clients.size,
        }),
      );
      broadcast(activeRoom, {
        type: "presence",
        peers: activeRoom.clients.size,
      });
      return;
    }
    if (
      message.type !== "operation" ||
      !activeRoom ||
      !message.operation?.id ||
      !["insert", "delete"].includes(message.operation.type)
    )
      return;
    if (activeRoom.operationIds.has(message.operation.id)) return;
    // [CRDT-03] 서버는 연산 내용을 변환하지 않는다. ID 중복만 막고, 같은 연산을 모든 복제본으로 중계한다.
    const timestamp = new Date().toISOString();
    message.operation.timestamp = timestamp;
    activeRoom.operationIds.add(message.operation.id);
    activeRoom.operations.push(message.operation);
    broadcast(activeRoom, {
      type: "operation",
      operation: message.operation,
      author: message.clientId,
      timestamp,
    });
  });
  socket.on("close", () => {
    if (!activeRoom) return;
    activeRoom.clients.delete(socket);
    broadcast(activeRoom, { type: "presence", peers: activeRoom.clients.size });
  });
});
const port = Number(process.env.PORT) || 3000;
server.listen(port, () =>
  console.log(`CRDT demo listening on http://localhost:${port}`),
);
