/**
 * One-time and maintenance functions. Run them from the Apps Script editor.
 *
 *   setupNotion()          adds every column and the Follow Up formula to your database.
 *                          Safe to re-run: existing columns are left alone, the formula is
 *                          rewritten from CONFIG (run it again after editing FOLLOW_UP_*).
 *   installDailyTrigger()  runs processInbox() every day at CONFIG.RUN_HOUR.
 *   startBackfill()        moves the checkpoint back CONFIG.BACKFILL_DAYS days. Then run
 *                          processInbox() by hand until the log stops finding messages.
 *   clearSenderCache()     forgets every sender -> company mapping learned from Gemini.
 */

const STATUS_OPTIONS = [
  ["Applied", "blue"], ["Interviewing", "yellow"], ["Offer", "green"], ["Rejected", "red"],
  ["Withdrawn", "gray"], ["Trial", "orange"], ["Active", "green"], ["Cancelled", "gray"], ["Expired", "brown"]
];

const SCHEMA = {
  "Type": { select: { options: [{ name: "Job Application", color: "blue" }, { name: "Subscription", color: "purple" }] } },
  "Status": { select: { options: STATUS_OPTIONS.map(([name, color]) => ({ name, color })) } },
  "Role / Plan": { rich_text: {} },
  "First Seen": { date: {} },
  "Last Email": { date: {} },
  "Times Applied": { number: { format: "number" } },
  "Rejected Date": { date: {} },
  "Rejection Reason": { rich_text: {} },
  "Details": { rich_text: {} },
  "Sender": { rich_text: {} },
  "Subject": { rich_text: {} },
  "Key": { rich_text: {} }
};

function setupNotion() {
  const cfg = getConfig_();
  const db = notion_(cfg, "get", `databases/${cfg.dbId}`);
  if (!db) throw new Error("Cannot read the database. Open it in Notion, then ... > Connections > add your integration.");

  const existing = db.properties;
  const props = {};
  const titleName = Object.keys(existing).find(k => existing[k].type === "title");
  if (titleName && titleName !== "Name" && !existing["Name"]) props[titleName] = { name: "Name" };
  Object.keys(SCHEMA).forEach(name => { if (!existing[name]) props[name] = SCHEMA[name]; });

  // Columns first: the formula below refers to them.
  if (Object.keys(props).length && !notion_(cfg, "patch", `databases/${cfg.dbId}`, { properties: props })) {
    throw new Error("Adding columns failed, see the log.");
  }
  const formula = { "Follow Up": { formula: { expression: buildFollowUpFormula_() } } };
  if (!notion_(cfg, "patch", `databases/${cfg.dbId}`, { properties: formula })) {
    throw new Error("Writing the Follow Up formula failed, see the log.");
  }
  Logger.log(`Notion ready. Added: ${Object.keys(props).join(", ") || "nothing new"}. Follow Up formula updated.`);
}

function buildFollowUpFormula_() {
  const days = 'dateBetween(now(), prop("Last Email"), "days")';
  const parts = [
    'prop("Type") == "Job Application"',
    'prop("Status") == "Applied"',
    `${days} >= ${CONFIG.FOLLOW_UP_MIN_DAYS}`,
    `${days} <= ${CONFIG.FOLLOW_UP_MAX_DAYS}`
  ];
  // Quotes, backslashes and regex operators would break the formula string, so drop them.
  const skip = CONFIG.FOLLOW_UP_SKIP
    .map(s => s.toLowerCase().replace(/["\\|()[\]{}*+?^$]/g, "").trim())
    .filter(Boolean).join("|");
  if (skip) parts.push(`not test(lower(prop("Sender") + " " + prop("Name")), "${skip}")`);
  return parts.join(" and ");
}

function installDailyTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === "processInbox")
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger("processInbox").timeBased().everyDays(1).atHour(CONFIG.RUN_HOUR).create();
  Logger.log(`Daily trigger set for ${CONFIG.RUN_HOUR}:00.`);
}

function startBackfill() {
  const since = Date.now() - CONFIG.BACKFILL_DAYS * DAY_MS;
  PropertiesService.getScriptProperties().setProperty("LAST_MESSAGE_TS", String(since));
  Logger.log(`Checkpoint moved back ${CONFIG.BACKFILL_DAYS} days. Now run processInbox() until it finds 0 messages.`);
}

function clearSenderCache() {
  const p = PropertiesService.getScriptProperties();
  const keys = p.getKeys().filter(k => k.startsWith(CACHE_PREFIX));
  keys.forEach(k => p.deleteProperty(k));
  Logger.log(`Cleared ${keys.length} cached senders.`);
}
