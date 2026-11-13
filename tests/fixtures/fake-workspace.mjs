// A stand-in for a workspace (a whole Nou) in the host tests: says hello, prints what the host tells it, and
// does what it's typed: "s<n>" switches to workspace n, "n<folder>" opens one, "c<n>" closes workspace n (its ×), "r<name>" renames this one, "q" quits.
import net from "net";
const id = process.env.NOU_WORKSPACE_ID;
const socket = net.connect(Number(process.env.NOU_HOST_PORT), "127.0.0.1");
socket.unref();
const send = (msg) => socket.write(`${JSON.stringify(msg)}\n`);
socket.on("connect", () => send({ type: "hello", id, token: process.env.NOU_HOST_TOKEN }));
let carry = "";
socket.on("data", (d) => {
  carry += d;
  for (let at; (at = carry.indexOf("\n")) >= 0; carry = carry.slice(at + 1)) {
    const msg = JSON.parse(carry.slice(0, at));
    if (msg.type === "redraw") process.stdout.write(`[redraw ${id} ${process.cwd().split(/[\\/]/).pop()}]`);
    if (msg.type === "quit") process.exit(0);
    if (msg.type === "tabs") process.stdout.write(`[tabs ${msg.tabs.map((t) => `${t.name}${t.active ? "*" : ""}`).join(",")}]`);
  }
});
process.stdin.setRawMode?.(true);
let typed = "";
process.stdin.on("data", (d) => {
  typed += d.toString();
  if (!typed.endsWith("\r")) return;
  const line = typed.slice(0, -1);
  typed = "";
  if (line === "q") process.exit(0);
  if (line.startsWith("s")) send({ type: "switch", index: Number(line.slice(1)) - 1 });
  if (line.startsWith("n")) send({ type: "new", folder: line.slice(1) });
  if (line.startsWith("c")) send({ type: "close", index: Number(line.slice(1)) - 1 });
  if (line.startsWith("r")) send({ type: "rename", name: line.slice(1) });
});
