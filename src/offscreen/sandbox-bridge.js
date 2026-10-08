// Talks to the sandbox page (iframe#sandbox in offscreen.html), which runs
// work that needs eval.

const frame = document.getElementById("sandbox");
let resolveReady;
const ready = new Promise((r) => (resolveReady = r));
let nextId = 0;
const calls = new Map();

window.addEventListener("message", async (e) => {
  if (e.source !== frame.contentWindow) return;
  const m = e.data;
  if (m?.op === "ready") resolveReady();
  if (m?.op === "result") {
    const call = calls.get(m.id);
    calls.delete(m.id);
    if (m.error) call?.reject(new Error(m.error));
    else call?.resolve(m.result);
  }
});

export async function callSandbox(op, payload) {
  await ready;
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    calls.set(id, { resolve, reject });
    frame.contentWindow.postMessage({ op, id, ...payload }, "*");
  });
}
