// Loads src/ into a sandbox with in-memory fakes of the Google and Notion services,
// so the Apps Script code runs unchanged under `node --test`.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const SRC = path.join(__dirname, "..", "src");
const FILES = ["Config.js", "Code.js", "Setup.js", "Migrate.js"];
const HOUR = 3600 * 1000;

function load() {
  const props = new Map();
  const notion = { pages: [], schema: { Name: { type: "title" } }, nextId: 1 };
  const gmail = { threads: [], labels: new Map() };
  const calls = { gemini: 0, geminiReply: null };
  const logs = [];

  const ctx = {
    console,
    Logger: { log: (...a) => logs.push(a.join(" ")) },
    Utilities: { sleep() {} },
    Session: { getEffectiveUser: () => ({ getEmail: () => "me@example.com" }) },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: k => (props.has(k) ? props.get(k) : null),
        setProperty: (k, v) => props.set(k, String(v)),
        deleteProperty: k => props.delete(k),
        getKeys: () => [...props.keys()]
      })
    },
    GmailApp: {
      getUserLabelByName: n => gmail.labels.get(n) || null,
      createLabel: n => { const l = { name: n }; gmail.labels.set(n, l); return l; },
      search: (query, start, max) => {
        const after = Number((query.match(/after:(\d+)/) || [])[1] || 0) * 1000;
        return gmail.threads.filter(t => t.messages.some(m => m.date.getTime() > after)).slice(start, start + max);
      },
      getMessageById: id => {
        for (const t of gmail.threads) for (const m of t.messages) if (m.id === id) return m.api;
        return null;
      }
    },
    UrlFetchApp: { fetch: (url, opts) => route(url, opts) },
    ScriptApp: {}
  };

  function reply(code, body) {
    return { getResponseCode: () => code, getContentText: () => JSON.stringify(body) };
  }

  // Notion stores input text as plain_text, the way the real API returns it.
  function stored(properties) {
    const out = {};
    for (const [k, v] of Object.entries(properties)) {
      const arr = v.rich_text || v.title;
      if (arr) out[k] = { [v.title ? "title" : "rich_text"]: arr.map(t => ({ plain_text: t.text.content })) };
      else out[k] = v;
    }
    return out;
  }

  function text(page, prop) {
    const v = page.properties[prop];
    return v ? (v.rich_text || v.title || []).map(t => t.plain_text).join("") : "";
  }

  function matches(page, f) {
    if (!f) return true;
    if (f.rich_text && "equals" in f.rich_text) return text(page, f.property) === f.rich_text.equals;
    if (f.rich_text && "starts_with" in f.rich_text) return text(page, f.property).startsWith(f.rich_text.starts_with);
    if (f.select) return (page.properties[f.property] || {}).select?.name === f.select.equals;
    throw new Error("fake Notion: unsupported filter " + JSON.stringify(f));
  }

  function route(url, opts) {
    const body = opts.payload ? JSON.parse(opts.payload) : null;
    if (url.includes("generativelanguage")) {
      calls.gemini++;
      if (url.includes("key=")) throw new Error("Gemini key must not be in the URL");
      const prompt = body.contents[0].parts[0].text;
      const out = calls.geminiReply ? calls.geminiReply(prompt) : null;
      if (!out) return reply(500, { error: "no fake reply" });
      return reply(200, { candidates: [{ content: { parts: [{ text: JSON.stringify(out) }] } }] });
    }
    const p = url.replace("https://api.notion.com/v1/", "");
    const live = notion.pages.filter(pg => !pg.archived);
    if (/^databases\/[^/]+\/query$/.test(p)) {
      return reply(200, { results: live.filter(pg => matches(pg, body.filter)), has_more: false });
    }
    if (/^databases\/[^/]+$/.test(p)) {
      if (opts.method === "patch") Object.assign(notion.schema, body.properties);
      return reply(200, { properties: notion.schema });
    }
    if (p === "pages" && opts.method === "post") {
      const page = { id: "p" + notion.nextId++, properties: stored(body.properties), archived: false };
      notion.pages.push(page);
      return reply(200, page);
    }
    const m = p.match(/^pages\/(.+)$/);
    if (m && opts.method === "patch") {
      const page = notion.pages.find(pg => pg.id === m[1]);
      if (body.archived) page.archived = true;
      if (body.properties) Object.assign(page.properties, stored(body.properties));
      return reply(200, page);
    }
    throw new Error("fake Notion: unhandled " + opts.method + " " + p);
  }

  vm.createContext(ctx);
  for (const f of FILES) vm.runInContext(fs.readFileSync(path.join(SRC, f), "utf8"), ctx, { filename: f });

  props.set("NOTION_TOKEN", "test-token");
  props.set("NOTION_DATABASE_ID", "db1");
  props.set("GEMINI_API_KEY", "test-key");

  let nextMsg = 1;
  // Adds a message to a thread (created on first use) and returns the thread name.
  function email(threadName, { from, subject, body, hoursAgo }) {
    let t = gmail.threads.find(x => x.name === threadName);
    if (!t) {
      t = { name: threadName, messages: [], labels: new Set() };
      t.api = { getMessages: () => t.messages.map(m => m.api), addLabel: l => t.labels.add(l.name) };
      gmail.threads.push(t);
    }
    const m = { id: "m" + nextMsg++, date: new Date(Date.now() - hoursAgo * HOUR) };
    m.api = {
      getId: () => m.id,
      getDate: () => m.date,
      getFrom: () => from,
      getSubject: () => subject,
      getPlainBody: () => body,
      getBody: () => body,
      getThread: () => t.api
    };
    t.messages.push(m);
    return t;
  }
  // GmailApp.search returns thread objects.
  const search = ctx.GmailApp.search;
  ctx.GmailApp.search = (...a) => search(...a).map(t => t.api);

  const rows = () => notion.pages.filter(pg => !pg.archived).map(pg => ({
    name: text(pg, "Name"),
    role: text(pg, "Role / Plan"),
    status: pg.properties.Status?.select?.name,
    timesApplied: pg.properties["Times Applied"]?.number,
    rejectedDate: pg.properties["Rejected Date"]?.date?.start || null,
    key: text(pg, "Key")
  }));

  return {
    ctx, props, notion, gmail, calls, logs, email, rows,
    run: code => vm.runInContext(code, ctx)
  };
}

module.exports = { load, HOUR };
