/**
 * gmail-assistant: Gmail -> Notion job application and subscription tracker.
 *
 * Token budget: rules classify most emails for free. Gemini is called only when the
 * rules, the thread and the sender cache together cannot name company + role, with a
 * short body and a small JSON schema. Duplicates are merged in code by a normalized Key.
 *
 * Messages are processed one by one from a timestamp checkpoint, so a reply that lands
 * in an already processed thread (a rejection after a confirmation) is still read.
 */

const NOTION_VERSION = "2022-06-28";
const MAX_RUN_MS = 5 * 60 * 1000;
const SAVE_EVERY = 20; // progress is saved this often, so a cancelled run repeats at most this many messages
const DAY_MS = 24 * 3600 * 1000;
const CACHE_PREFIX = "sender:";

const RX = {
  ignore: /newsletter|job alert|jobs for you|recommended jobs|new jobs matching|jobempfehlung|webinar|digest|% off|sale ends/i,
  rejected: /unfortunately|leider|not to move forward|not be moving forward|nicht weiter|other candidates|anderen kandidat|absage|decided not to|not been selected|position has been filled|not proceed/i,
  interview: /interview|vorstellungsgespr|kennenlern|assessment|coding challenge|schedule a call|invitation to|einladung/i,
  interviewBody: /invite you to an? (interview|call|conversation)|would like to (invite|schedule|meet)|einladung zu(m|r)|laden (sie|dich) .{0,30}ein/i,
  applied: /thank(s| you) for (your )?(appl|interest)|application (has been )?(received|submitted|sent)|bewerbung (ist )?eingegangen|vielen dank f(ü|ue)r (ihre|deine) bewerbung|received your application|der erste schritt|your application (to|for)/i,
  trial: /trial (has )?(started|begins|ends|ending)|free trial|testphase/i,
  expired: /trial (has )?(ended|expired)|subscription (has )?expired/i,
  cancelled: /(subscription|plan) (has been )?cancel|cancellation confirm|gekündigt/i,
  billed: /receipt|invoice|rechnung|payment (received|confirm)|your subscription|renew/i,
  teamWords: /\b(hiring team|recruiting team|recruiting|recruitment|talent acquisition|careers?|career at|jobs at|karriere|people services|hr)\b/ig,
  role: /(?:application|bewerbung|applying|applied)\s+(?:for|als|as|to)\s+(?:the\s+)?(?:position\s+(?:of\s+)?)?["'“]?(.+?)["'”]?(?:\s+(?:at|bei|with)\s+|\s*[|!.]|$)/i
};

// ---------- Daily sync ----------

function processInbox() {
  const cfg = getConfig_();
  const started = Date.now();
  const store = PropertiesService.getScriptProperties();
  const doneLabel = label_(CONFIG.LABEL_PROCESSED);
  const reviewLabel = label_(CONFIG.LABEL_REVIEW);

  const checkpoint = Number(store.getProperty("LAST_MESSAGE_TS")) || started - CONFIG.LOOKBACK_DAYS * DAY_MS;
  const retries = JSON.parse(store.getProperty("RETRY_IDS") || "{}");
  const items = retryItems_(retries).concat(newMessages_(checkpoint));
  Logger.log(`${items.length} messages to process (${Object.keys(retries).length} retries).`);

  let lastTs = checkpoint, aiCalls = 0, handled = 0, seen = 0;
  const save = () => {
    store.setProperty("LAST_MESSAGE_TS", String(lastTs));
    store.setProperty("RETRY_IDS", JSON.stringify(retries));
  };
  for (const item of items) {
    if (Date.now() - started > MAX_RUN_MS) { Logger.log("Time limit reached, the rest runs next time."); break; }

    const email = toEmail_(item.msg);
    const outcome = handleMessage_(cfg, email, item);
    if (outcome.ai) aiCalls++;

    const id = item.msg.getId();
    if (outcome.state === "retry") {
      retries[id] = (retries[id] || 0) + 1;
      if (retries[id] >= CONFIG.MAX_RETRIES) { item.thread.addLabel(reviewLabel); delete retries[id]; }
    } else {
      delete retries[id];
      item.thread.addLabel(outcome.state === "review" ? reviewLabel : doneLabel);
      handled++;
    }
    if (!item.retry) lastTs = Math.max(lastTs, email.ts);
    if (++seen % SAVE_EVERY === 0) save();
  }

  save();
  Logger.log(`Done. ${handled} handled, ${aiCalls} Gemini calls, ${Object.keys(retries).length} waiting for retry.`);
}

// Returns { state: "done" | "review" | "retry", ai: boolean }.
function handleMessage_(cfg, email, item) {
  let r = classifyByRules_(email);
  if (r.category === "IGNORE") return { state: "done", ai: false };

  if (r.category === "Job Application" && !r.role) r.role = roleFromThread_(item.thread, item.index);
  if (!r.company) r.company = cachedCompany_(email.sender);

  let ai = false;
  if (!isResolved_(r)) {
    if (!CONFIG.USE_AI) {
      if (!(r.category && r.company)) return { state: "review", ai };
    } else {
      const g = classifyWithGemini_(cfg, email);
      ai = true;
      Utilities.sleep(CONFIG.AI_DELAY_MS);
      if (!g) return { state: "retry", ai }; // Gemini failed, try again next run
      if (g.category === "IGNORE") return { state: "done", ai };
      rememberSender_(email.sender, g.company);
      // Rules are exact where they matched, Gemini fills the gaps.
      r = {
        category: r.category || g.category,
        status: r.status || g.status,
        company: r.company || g.company,
        role: r.role || g.role,
        reason: r.reason || g.reason
      };
      if (!r.company) return { state: "review", ai };
    }
  }
  return { state: upsertRecord_(cfg, r, email) ? "done" : "retry", ai };
}

function isResolved_(r) {
  return Boolean(r.category && r.company && (r.category === "Subscription" || r.role));
}

function newMessages_(sinceMs) {
  const query = `after:${Math.floor(sinceMs / 1000)} ${keywordQuery_()}`;
  const me = (Session.getEffectiveUser().getEmail() || "").toLowerCase();
  const kw = keywordRx_();
  const items = [];
  for (let start = 0; start < CONFIG.MAX_THREADS; start += 50) {
    const page = GmailApp.search(query, start, 50);
    page.forEach(thread => thread.getMessages().forEach((msg, index) => {
      if (msg.getDate().getTime() <= sinceMs) return;
      const from = msg.getFrom() || "";
      if (me && from.toLowerCase().includes(me)) return; // your own replies
      if (!kw.test(`${from} ${msg.getSubject() || ""} ${bodyText_(msg)}`)) return;
      items.push({ msg, thread, index, retry: false });
    }));
    if (page.length < 50) break;
  }
  return items.sort((a, b) => a.msg.getDate() - b.msg.getDate());
}

function retryItems_(retries) {
  const items = [];
  Object.keys(retries).forEach(id => {
    const msg = GmailApp.getMessageById(id);
    if (!msg) { delete retries[id]; return; }
    const thread = msg.getThread();
    const index = thread.getMessages().findIndex(m => m.getId() === id);
    items.push({ msg, thread, index, retry: true });
  });
  return items;
}

function toEmail_(msg) {
  const date = msg.getDate();
  return {
    subject: msg.getSubject() || "",
    sender: msg.getFrom() || "",
    date: date.toISOString(),
    ts: date.getTime(),
    body: bodyText_(msg)
  };
}

function bodyText_(msg) {
  return (msg.getPlainBody() || (msg.getBody() || "").replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ").substring(0, CONFIG.BODY_CHARS);
}

// ---------- Rules ----------

function classifyByRules_(email) {
  const text = `${email.subject} ${email.body}`;
  if (RX.ignore.test(email.subject)) return { category: "IGNORE" };

  let category = "", status = "";
  if (RX.rejected.test(text)) { category = "Job Application"; status = "Rejected"; }
  else if (RX.applied.test(text)) { category = "Job Application"; status = "Applied"; }
  else if (RX.interview.test(email.subject) || RX.interviewBody.test(email.body.substring(0, 300))) {
    category = "Job Application"; status = "Interviewing";
  }
  else if (RX.expired.test(text)) { category = "Subscription"; status = "Expired"; }
  else if (RX.cancelled.test(text)) { category = "Subscription"; status = "Cancelled"; }
  else if (RX.trial.test(text)) { category = "Subscription"; status = "Trial"; }
  else if (RX.billed.test(email.subject)) { category = "Subscription"; status = "Active"; }

  const roleMatch = category === "Job Application" ? email.subject.match(RX.role) : null;
  return {
    category,
    status,
    company: companyFromSender_(email.sender),
    role: roleMatch ? roleMatch[1].trim() : "",
    reason: status === "Rejected" ? rejectionSentence_(email.body) : ""
  };
}

function companyFromSender_(sender) {
  const display = sender.split("<")[0].replace(/["']/g, "").replace(/\(via [^)]*\)/i, "").trim();
  if (!display || display.includes("@")) return "";
  const fromMatch = display.match(/\bfrom\s+(.+)$/i); // "Jane Doe from Acme Germany"
  if (fromMatch) return fromMatch[1].trim();
  RX.teamWords.lastIndex = 0;
  if (!RX.teamWords.test(display)) return ""; // likely a person's name
  RX.teamWords.lastIndex = 0;
  return display.replace(RX.teamWords, "").replace(/\b(the|von|team|do not reply|noreply|no-reply)\b/ig, "")
    .replace(/[-|@]+/g, " ").replace(/\s+/g, " ").trim();
}

function rejectionSentence_(body) {
  const sentences = body.split(/(?<=[.!?])\s+/);
  const hit = sentences.find(s => RX.rejected.test(s));
  return hit ? hit.substring(0, 200) : "";
}

// A reply often drops the job title. The message it answers usually still has it.
function roleFromThread_(thread, index) {
  const msgs = thread.getMessages();
  for (let i = Math.min(index, msgs.length) - 1; i >= 0; i--) {
    const m = (msgs[i].getSubject() || "").match(RX.role);
    if (m) return m[1].trim();
  }
  return "";
}

// ---------- Sender cache ----------

function senderCacheKey_(sender) {
  const m = sender.match(/<([^>]+)>/);
  const address = (m ? m[1] : sender).trim().toLowerCase();
  const domain = address.split("@")[1] || "";
  if (!domain || CONFIG.SHARED_SENDER_DOMAINS.some(d => domain === d || domain.endsWith("." + d))) return "";
  const display = normText_(sender.split("<")[0].replace(/["']/g, "")).trim();
  return `${CACHE_PREFIX}${display}|${address}`;
}

function cachedCompany_(sender) {
  const key = senderCacheKey_(sender);
  return key ? PropertiesService.getScriptProperties().getProperty(key) || "" : "";
}

function rememberSender_(sender, company) {
  const key = senderCacheKey_(sender);
  if (key && company) PropertiesService.getScriptProperties().setProperty(key, company);
}

// ---------- Gemini ----------

function classifyWithGemini_(cfg, email) {
  const prompt = `Classify this email. Return JSON only.
category: "Job Application" (application sent, status update, interview, assessment, rejection), "Subscription" (paid plan, trial, receipt, renewal), or "IGNORE" (newsletter, marketing, job alert digest).
company: employer or service name, not the ATS (not Workday, Greenhouse, Lever, Personio, join.com).
role: exact job title or plan, "" if not stated.
status: the state this email puts the application or subscription in.
reason: for rejections, the stated reason in max 15 words, else "".
From: ${email.sender}
Subject: ${email.subject}
Body: ${email.body}`;

  const payload = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0,
      maxOutputTokens: 200,
      // Gemini 2.x turns thinking off with a budget, 3.x and later only accept a level.
      thinkingConfig: /^gemini-2\./.test(cfg.model) ? { thinkingBudget: 0 } : { thinkingLevel: "minimal" },
      responseMimeType: "application/json",
      responseSchema: {
        type: "OBJECT",
        properties: {
          category: { type: "STRING", enum: ["Job Application", "Subscription", "IGNORE"] },
          company: { type: "STRING" },
          role: { type: "STRING" },
          status: { type: "STRING", enum: ["Applied", "Interviewing", "Offer", "Rejected", "Withdrawn", "Trial", "Active", "Cancelled", "Expired"] },
          reason: { type: "STRING" }
        },
        required: ["category", "company", "role", "status", "reason"]
      }
    }
  };

  // Key goes in a header, never in the URL, so it cannot leak into logged URLs.
  const res = UrlFetchApp.fetch(`https://generativelanguage.googleapis.com/v1beta/models/${cfg.model}:generateContent`, {
    method: "post",
    contentType: "application/json",
    headers: { "x-goog-api-key": cfg.geminiKey },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) {
    Logger.log(`Gemini ${res.getResponseCode()}: ${res.getContentText().substring(0, 300)}`);
    return null;
  }
  try {
    const json = JSON.parse(res.getContentText());
    return JSON.parse(json.candidates[0].content.parts[0].text);
  } catch (e) {
    Logger.log("Gemini parse error: " + e);
    return null;
  }
}

// ---------- Notion upsert ----------

function upsertRecord_(cfg, r, email) {
  const isJob = r.category === "Job Application";
  const key = makeKey_(r.category, r.company, isJob ? r.role : "");

  let page = findByKey_(cfg, key);
  if (!page && isJob) page = matchCompanyRow_(cfg, r);

  if (!page) {
    const props = {
      "Name": { title: [{ text: { content: r.company || "Unknown" } }] },
      "Type": { select: { name: r.category } },
      "Status": { select: { name: r.status } },
      "Role / Plan": richText_(r.role || ""),
      "Key": richText_(key),
      "First Seen": { date: { start: email.date } },
      "Last Email": { date: { start: email.date } },
      "Sender": richText_(email.sender),
      "Subject": richText_(email.subject),
      "Details": richText_(r.reason || email.subject),
      "Times Applied": { number: 1 }
    };
    addRejection_(props, r, email);
    return notion_(cfg, "post", "pages", { parent: { database_id: cfg.dbId }, properties: props }) !== null;
  }

  const old = readRow_(page);
  const props = {};
  if (r.role && !old.role) props["Role / Plan"] = richText_(r.role);

  // Older or already seen news (a retry, or a re-read after the checkpoint moved back)
  // must not overwrite newer state.
  const isNewer = !old.lastEmail || email.ts > new Date(old.lastEmail).getTime();
  if (isNewer) {
    props["Last Email"] = { date: { start: email.date } };
    props["Sender"] = richText_(email.sender);
    props["Subject"] = richText_(email.subject);
    props["Status"] = { select: { name: nextStatus_(old.status, r.status) } };
    // Re-application: a fresh "Applied" more than a day after the last email on this row.
    if (r.status === "Applied" && old.lastEmail && email.ts - new Date(old.lastEmail).getTime() > DAY_MS) {
      props["Times Applied"] = { number: (old.timesApplied || 1) + 1 };
    }
    if (r.reason) props["Details"] = richText_(r.reason);
    addRejection_(props, r, email);
  }

  if (!Object.keys(props).length) return true;
  return notion_(cfg, "patch", `pages/${page.id}`, { properties: props }) !== null;
}

// No exact key: look at this company's rows. A role-less email joins the company's only
// row, a titled one joins a row whose title is close enough.
function matchCompanyRow_(cfg, r) {
  const rows = queryAll_(cfg, { property: "Key", rich_text: { starts_with: makeKey_(r.category, r.company, "") } });
  if (!rows.length) return null;
  const role = normRole_(r.role);
  if (!role) return rows.length === 1 ? rows[0] : null;

  let best = null, bestScore = 0;
  rows.forEach(p => {
    const score = roleSimilarity_(role, normRole_(readRow_(p).role));
    if (score > bestScore) { best = p; bestScore = score; }
  });
  if (!best || bestScore < CONFIG.FUZZY_MIN_OVERLAP) return null;
  Logger.log(`FUZZY MERGE ${r.company}: "${r.role}" -> "${readRow_(best).role}" (${bestScore.toFixed(2)})`);
  return best;
}

// Word overlap (Jaccard) of two normalized titles, ignoring location words.
// Titles at different seniority levels never match.
function roleSimilarity_(a, b) {
  if (!a || !b) return 0;
  const level = s => CONFIG.SENIORITY_WORDS.filter(w => new RegExp(`\\b${w}\\b`).test(s)).sort().join(",");
  if (level(a) !== level(b)) return 0;
  const words = s => new Set(s.split(" ").filter(w => w && !CONFIG.LOCATION_WORDS.includes(w)));
  const A = words(a), B = words(b);
  const shared = [...A].filter(w => B.has(w)).length;
  const union = new Set([...A, ...B]).size;
  return union ? shared / union : 0;
}

function addRejection_(props, r, email) {
  if (r.status !== "Rejected") return;
  props["Rejected Date"] = { date: { start: email.date } };
  if (r.reason) props["Rejection Reason"] = richText_(r.reason);
}

// A plain confirmation email must not undo progress. Re-applying after a rejection is allowed.
function nextStatus_(oldStatus, incoming) {
  const rank = { Applied: 1, Interviewing: 2, Offer: 3 };
  if (rank[oldStatus] && rank[incoming] && rank[incoming] < rank[oldStatus]) return oldStatus;
  return incoming;
}

function findByKey_(cfg, key) {
  const res = notion_(cfg, "post", `databases/${cfg.dbId}/query`,
    { filter: { property: "Key", rich_text: { equals: key } }, page_size: 1 });
  return res && res.results.length ? res.results[0] : null;
}

// ---------- Normalization ----------

function normText_(s) {
  return (s || "").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n)).replace(/&amp;/g, "&")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

function normCompany_(name) {
  const c = normText_(name).replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\b(gmbh|ag|se|inc|ltd|llc|plc|kg|co|company|group|gruppe|holding|germany|deutschland|europe|berlin)\b/g, " ")
    .replace(/\s+/g, " ").trim();
  return CONFIG.COMPANY_ALIASES[c] || c;
}

function normRole_(role) {
  return normText_(role)
    .replace(/\(\s*[a-z*]{1,2}(\s*[\/|,*]\s*[a-z*]{1,2}){1,3}\s*\)/g, " ") // (m/w/d), (f/m/x), (w/m/d)
    .replace(/\((gn|all genders|d)\)/g, " ")
    .replace(/[-:(]?\s*\b\d{5,}\b\)?/g, " ")                                 // requisition ids like 85053
    .replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
}

function makeKey_(category, company, role) {
  return `${category === "Subscription" ? "sub" : "job"}|${normCompany_(company)}|${category === "Subscription" ? "" : normRole_(role)}`
    .replace(/\|$/, category === "Subscription" ? "" : "|");
}

// ---------- Helpers ----------

function readRow_(page) {
  const p = page.properties;
  const txt = x => x ? ((x.rich_text || x.title || []).map(t => t.plain_text).join("")) : "";
  return {
    id: page.id,
    name: txt(p["Name"]),
    role: txt(p["Role / Plan"]),
    status: p["Status"] && p["Status"].select ? p["Status"].select.name : "",
    details: txt(p["Details"]),
    firstSeen: p["First Seen"] && p["First Seen"].date ? p["First Seen"].date.start : null,
    lastEmail: p["Last Email"] && p["Last Email"].date ? p["Last Email"].date.start : null,
    timesApplied: p["Times Applied"] ? p["Times Applied"].number : null
  };
}

function queryAll_(cfg, filter) {
  const out = [];
  let cursor;
  do {
    const body = { filter, page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    const res = notion_(cfg, "post", `databases/${cfg.dbId}/query`, body);
    if (!res) break;
    out.push(...res.results);
    cursor = res.has_more ? res.next_cursor : null;
  } while (cursor);
  return out;
}

function notion_(cfg, method, path, body) {
  const opts = {
    method,
    headers: { "Authorization": `Bearer ${cfg.notionToken}`, "Notion-Version": NOTION_VERSION },
    contentType: "application/json",
    muteHttpExceptions: true
  };
  if (body) opts.payload = JSON.stringify(body);
  const res = UrlFetchApp.fetch(`https://api.notion.com/v1/${path}`, opts);
  const code = res.getResponseCode();
  if (code >= 300) {
    Logger.log(`Notion ${method} ${path} -> ${code}: ${res.getContentText().substring(0, 300)}`);
    return null;
  }
  return JSON.parse(res.getContentText());
}

function richText_(s) {
  return { rich_text: [{ text: { content: (s || "").substring(0, 1900) } }] };
}

function label_(name) {
  return GmailApp.getUserLabelByName(name) || GmailApp.createLabel(name);
}

function keywordQuery_() {
  return "(" + CONFIG.KEYWORDS.map(k => /\s/.test(k) ? `"${k}"` : k).join(" OR ") + ")";
}

function keywordRx_() {
  return new RegExp(CONFIG.KEYWORDS.map(escapeRx_).join("|"), "i");
}

function escapeRx_(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getConfig_() {
  const p = PropertiesService.getScriptProperties();
  const required = ["NOTION_TOKEN", "NOTION_DATABASE_ID"].concat(CONFIG.USE_AI ? ["GEMINI_API_KEY"] : []);
  const missing = required.filter(k => !p.getProperty(k));
  if (missing.length) throw new Error(`Set ${missing.join(", ")} in Project Settings > Script Properties.`);
  return {
    geminiKey: p.getProperty("GEMINI_API_KEY"),
    notionToken: p.getProperty("NOTION_TOKEN"),
    dbId: p.getProperty("NOTION_DATABASE_ID"),
    model: p.getProperty("GEMINI_MODEL") || CONFIG.GEMINI_MODEL
  };
}
