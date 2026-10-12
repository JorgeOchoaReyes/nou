// Starter plugin: lets the model read a web page (docs, an issue, a changelog) as plain text.
const MAX_CHARS = 20_000;
const TIMEOUT_MS = 15_000;

const ENTITIES = { nbsp: " ", lt: "<", gt: ">", quot: "\"", "#39": "'", amp: "&" };

/** Rough HTML to text: drops scripts, styles and tags, keeps the words. */
export function htmlToText(html) {
  // Repeat until nothing changes: removing one tag can join the pieces of another ("<scr<b>ipt>").
  let text = html;
  let previous;
  do {
    previous = text;
    text = text
      .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1\s*>/gi, "")
      .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)[^>]*>/gi, "\n")
      .replace(/<[^>]*>/g, "");
  } while (text !== previous);
  // Entities last, in one pass, so "&amp;lt;" becomes "&lt;" rather than "<".
  return text
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
