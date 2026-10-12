// Starter plugin: lets the model read a web page (docs, an issue, a changelog) as plain text.
const MAX_CHARS = 20_000;
const TIMEOUT_MS = 15_000;

const ENTITIES = { nbsp: " ", lt: "<", gt: ">", quot: "\"", "#39": "'", amp: "&" };

/** Elements whose contents aren't page text. */
const SKIPPED = ["script", "style", "noscript", "svg"];

/** Cuts out <script>...</script> and the other SKIPPED elements, contents included. */
function dropSkipped(html) {
  const lower = html.toLowerCase();
  let out = "";
  let i = 0;
  while (i < html.length) {
    const open = lower.indexOf("<", i);
    if (open < 0) return out + html.slice(i);
    const name = SKIPPED.find((tag) => lower.startsWith(tag, open + 1) && !/[a-z0-9-]/.test(lower[open + 1 + tag.length] ?? ""));
    if (!name) {
      out += html.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    out += html.slice(i, open);
    const close = lower.indexOf(`</${name}`, open);
    if (close < 0) return out; // never closed: the rest is its contents
    const end = lower.indexOf(">", close);
    i = end < 0 ? html.length : end + 1;
  }
  return out;
}

/** Rough HTML to text: drops scripts, styles and tags, keeps the words. */
export function htmlToText(html) {
  // Any "<" left after removing tags began one that never closed (page text writes it as &lt;): drop
  // it too, so no tag survives. Entities last, in one pass, so "&amp;lt;" becomes "&lt;", not "<".
  return dropSkipped(html)
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)[^>]*>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/</g, "")
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
