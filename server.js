import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync } from "node:fs";

// Events are read from events.json each time, so you can edit that file
// without restarting anything.
const eventsFile = new URL("./events.json", import.meta.url);
const loadEvents = () => JSON.parse(readFileSync(eventsFile, "utf8"));

const format = (e) =>
  `${e.name}\n  When: ${e.date} at ${e.time}\n  Where: ${e.location}\n  ${e.description}`;

const server = new McpServer({ name: "meridian-hill-events", version: "1.0.0" });

// Tool 1: list upcoming events
server.tool(
  "list_events",
  "List upcoming events at Meridian Hill Park (Malcolm X Park), soonest first.",
  {},
  async () => {
    const today = new Date().toISOString().slice(0, 10);
    const upcoming = loadEvents()
      .filter((e) => e.date >= today)
      .sort((a, b) => a.date.localeCompare(b.date));
    const text = upcoming.length
      ? upcoming.map(format).join("\n\n")
      : "There are no upcoming events right now.";
    return { content: [{ type: "text", text }] };
  }
);

// Tool 2: search events by a word (name, description, or location)
server.tool(
  "search_events",
  "Search Meridian Hill Park events by keyword, e.g. 'yoga' or 'picnic'.",
  { keyword: z.string().describe("Word to look for") },
  async ({ keyword }) => {
    const k = keyword.toLowerCase();
    const found = loadEvents().filter((e) =>
      `${e.name} ${e.description} ${e.location}`.toLowerCase().includes(k)
    );
    const text = found.length
      ? found.map(format).join("\n\n")
      : `No events found matching "${keyword}".`;
    return { content: [{ type: "text", text }] };
  }
);

// ---- Photos ----
// Photos are described in photos.json (caption, date, event, location, tags).
// Searching looks at those written details, not at the pictures themselves.
const photosFile = new URL("./photos.json", import.meta.url);
const loadPhotos = () => JSON.parse(readFileSync(photosFile, "utf8"));

const formatPhoto = (p) =>
  `${p.caption}\n  File: ${p.file}\n  Taken: ${p.date}` +
  (p.event ? `\n  Event: ${p.event}` : "") +
  `\n  Where: ${p.location}\n  Tags: ${p.tags.join(", ")}`;

server.tool(
  "search_photos",
  "Search photos taken at Meridian Hill Park by keyword. Matches captions, event names, locations, and tags.",
  { keyword: z.string().describe("Word to look for, e.g. 'fountain' or 'drum circle'") },
  async ({ keyword }) => {
    const k = keyword.toLowerCase();
    const found = loadPhotos().filter((p) =>
      `${p.caption} ${p.event} ${p.location} ${p.tags.join(" ")}`.toLowerCase().includes(k)
    );
    const text = found.length
      ? found.map(formatPhoto).join("\n\n")
      : `No photos found matching "${keyword}".`;
    return { content: [{ type: "text", text }] };
  }
);

server.tool(
  "list_photos",
  "List all photos taken at Meridian Hill Park, newest first.",
  {},
  async () => {
    const all = loadPhotos().sort((a, b) => b.date.localeCompare(a.date));
    return { content: [{ type: "text", text: all.map(formatPhoto).join("\n\n") }] };
  }
);

// ---- Public photos (open licenses only) ----
// Sources: Wikimedia Commons and Openverse. Neither needs an account or key.
const UA = { "User-Agent": "meridian-events-mcp/1.0 (class project)" };
const stripHtml = (t = "") => t.replace(/<[^>]*>/g, "").trim();

async function searchCommons(query, limit) {
  const url =
    "https://commons.wikimedia.org/w/api.php?action=query&format=json&generator=search" +
    `&gsrnamespace=6&gsrlimit=${limit}&gsrsearch=${encodeURIComponent(query)}` +
    "&prop=imageinfo&iiprop=url|extmetadata&iiurlwidth=600";
  const res = await fetch(url, { headers: UA });
  if (!res.ok) throw new Error(`Wikimedia Commons returned ${res.status}`);
  const pages = Object.values((await res.json()).query?.pages ?? {});
  return pages
    .filter((p) => p.imageinfo?.[0])
    .map((p) => {
      const info = p.imageinfo[0];
      const m = info.extmetadata ?? {};
      return {
        title: p.title.replace(/^File:/, ""),
        image: info.thumburl || info.url,
        page: info.descriptionurl,
        author: stripHtml(m.Artist?.value) || "Unknown",
        license: m.LicenseShortName?.value || "See page",
        source: "Wikimedia Commons",
      };
    });
}

async function searchOpenverse(query, limit) {
  const url = `https://api.openverse.org/v1/images/?q=${encodeURIComponent(query)}&page_size=${limit}`;
  const res = await fetch(url, { headers: UA });
  if (!res.ok) throw new Error(`Openverse returned ${res.status}`);
  return ((await res.json()).results ?? []).map((r) => ({
    title: r.title || "Untitled",
    image: r.thumbnail || r.url,
    page: r.foreign_landing_url,
    author: r.creator || "Unknown",
    license: `${(r.license || "").toUpperCase()} ${r.license_version || ""}`.trim() || "See page",
    source: `Openverse (${r.source})`,
  }));
}

server.tool(
  "find_public_photos",
  "Find openly licensed (Creative Commons / public domain) photos from Wikimedia Commons and Openverse. Returns image links with photographer credit and license.",
  {
    query: z.string().describe("What to look for, e.g. 'Meridian Hill Park fountain'"),
    limit: z.number().int().min(1).max(10).default(5).describe("Results per source"),
  },
  async ({ query, limit }) => {
    const results = [];
    const problems = [];
    for (const [name, fn] of [["Wikimedia Commons", searchCommons], ["Openverse", searchOpenverse]]) {
      try {
        results.push(...(await fn(query, limit)));
      } catch (err) {
        problems.push(`${name} unavailable: ${err.message}`);
      }
    }
    const lines = results.map(
      (r) =>
        `${r.title}\n  Image: ${r.image}\n  Page: ${r.page}\n  Credit: ${r.author} — ${r.license} (${r.source})`
    );
    let text = lines.length ? lines.join("\n\n") : `No public photos found for "${query}".`;
    if (lines.length) text += "\n\nRemember to credit the author and license when using these photos.";
    if (problems.length) text += "\n\n" + problems.join("\n");
    return { content: [{ type: "text", text }] };
  }
);

await server.connect(new StdioServerTransport());
