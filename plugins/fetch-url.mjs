// Starter plugin: lets the model read a web page (docs, an issue, a changelog) as plain text.
const MAX_CHARS = 20_000;
const TIMEOUT_MS = 15_000;

const ENTITIES = { nbsp: " ", lt: "<", gt: ">", quot: "\"", "#39": "'", amp: "&" };

/** Elements whose contents aren't page text. */
const SKIPPED = new Set(["script", "style", "noscript", "svg"]);
/** Tags that end a line of text. */
const BREAKS = new Set(["br", "/p", "/div", "/li", "/tr", "/h1", "/h2", "/h3", "/h4", "/h5", "/h6"]);

/**
 * Keeps the text between tags. Every "<" starts a tag (page text writes a literal one as &lt;), which
 * runs to the next ">"; skipped elements lose their contents too. Nothing tag-like can survive.
 */
function stripTags(html) {
  const lower = html.toLowerCase();
  let out = "";
  let i = 0;
  while (i < html.length) {
    const open = lower.indexOf("<", i);
    if (open < 0) return out + html.slice(i);
    out += html.slice(i, open);
    const end = lower.indexOf(">", open);
    if (end < 0) return out; // a tag that never closes: the rest is inside it
    // "p" for <p class=x>, "/p" for </p>, "br" for <br/>.
    const inner = lower.slice(open + 1, end);
    const closing = inner.startsWith("/");
    const name = `${closing ? "/" : ""}${inner.slice(closing ? 1 : 0).split(/[\s/]/)[0]}`;
    if (BREAKS.has(name)) out += "\n";
    i = end + 1;
    if (SKIPPED.has(name)) {
      const close = lower.indexOf(`</${name}`, i);
      if (close < 0) return out; // never closed: the rest is its contents
      const closeEnd = lower.indexOf(">", close);
      i = closeEnd < 0 ? html.length : closeEnd + 1;
    }
  }
  return out;
}

/** Rough HTML to text: drops scripts, styles and tags, keeps the words. */
export function htmlToText(html) {
  // Entities after the tags, in one pass, so "&amp;lt;" becomes "&lt;", not "<".
  return stripTags(html)
    .replace(/&(nbsp|lt|gt|quot|#39|amp);/g, (_, name) => ENTITIES[name])
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n\n")
    .trim();
}

async function fetchText(url) {
  if (!/^https?:\/\//i.test(url)) throw new Error("only http(s) URLs");
  const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { "user-agent": "nou-fetch-url" } });
  const type = response.headers.get("content-type") ?? "";
  const body = await response.text();
  const text = type.includes("html") ? htmlToText(body) : body;
  const cut = text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}\n[... ${text.length - MAX_CHARS} more chars cut]` : text;
  return `${response.status} ${response.statusText} · ${url}\n\n${cut}`;
}

export default {
  name: "Fetch URL",
  version: "0.1.0",
  description: "Adds a fetch_url tool so the model can read docs and web pages (asks first).",

  tools: [
    {
      // Not read-only: it reaches the network, so you approve each URL.
      definition: {
        name: "fetch_url",
        description: "Fetch a web page or file over http(s) and return it as text",
        parameters: {
          type: "object",
          properties: { url: { type: "string", description: "The http(s) URL" } },
          required: ["url"],
        },
      },
      run: (args) => fetchText(String(args.url)),
    },
  ],
};
