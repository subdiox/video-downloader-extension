// Extension sandbox page: the only extension context where eval is allowed.
// Runs the code youtubei.js extracts from YouTube's player JS to transform the
// signature and `n` parameters of stream URLs, and returns { sig, n }.

window.addEventListener("message", async (e) => {
  const m = e.data;
  if (m?.op !== "eval") return;
  try {
    e.source.postMessage({ op: "result", id: m.id, result: await new Function(m.code)() }, "*");
  } catch (err) {
    e.source.postMessage({ op: "result", id: m.id, error: String(err?.message ?? err) }, "*");
  }
});

parent.postMessage({ op: "ready" }, "*");
