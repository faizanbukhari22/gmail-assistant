/**
 * Optional, for an existing database full of duplicates (for example rows imported from an
 * older tracker). New users can delete this file.
 *
 *   dryRunCleanup()  logs which rows would merge. Changes nothing.
 *   applyCleanup()   merges them: keeps the oldest row, takes status from the newest email,
 *                    counts Times Applied, archives the extras (restorable from Notion trash).
 *
 * Every row's Key is rewritten to the current format, so run this before the first
 * processInbox() when you migrate.
 */

function dryRunCleanup() { cleanup_(false); }
function applyCleanup() { cleanup_(true); }

function cleanup_(apply) {
  const cfg = getConfig_();
  const rows = queryAll_(cfg, { property: "Type", select: { equals: "Job Application" } }).map(readRow_);
  Logger.log(`${rows.length} job rows loaded.`);

  const groups = {};
  rows.forEach(row => {
    row.newKey = makeKey_("Job Application", row.name, row.role);
    (groups[row.newKey] = groups[row.newKey] || []).push(row);
  });

  // Role-less rows join the company's single titled group, if there is exactly one.
  Object.keys(groups).filter(k => k.endsWith("|")).forEach(emptyKey => {
    const titled = Object.keys(groups).filter(k => k !== emptyKey && k.startsWith(emptyKey));
    if (titled.length === 1) {
      groups[titled[0]] = groups[titled[0]].concat(groups[emptyKey]);
      delete groups[emptyKey];
    }
  });

  let merges = 0, updates = 0;
  Object.keys(groups).forEach(key => {
    const g = groups[key].sort((a, b) => (a.firstSeen || "").localeCompare(b.firstSeen || ""));
    const primary = g[0];
    const latest = g.reduce((a, b) => ((b.lastEmail || "") > (a.lastEmail || "") ? b : a));
    const rejectedRow = latest.status === "Rejected" ? latest : null;
    const role = g.map(x => x.role).filter(Boolean).sort((a, b) => b.length - a.length)[0] || "";

    if (g.length > 1) {
      merges += g.length - 1;
      Logger.log(`MERGE ${g.length} -> "${primary.name} | ${role}" status=${latest.status}  [${g.map(x => x.name + " / " + (x.role || "-")).join("  +  ")}]`);
    }

    const props = {
      "Key": richText_(key),
      "Role / Plan": richText_(role),
      "Status": { select: { name: latest.status } },
      "Times Applied": { number: g.filter(x => x.status !== "Interviewing").length || 1 }
    };
    if (primary.firstSeen) props["First Seen"] = { date: { start: primary.firstSeen } };
    if (latest.lastEmail) props["Last Email"] = { date: { start: latest.lastEmail } };
    if (rejectedRow && rejectedRow.lastEmail) {
      props["Rejected Date"] = { date: { start: rejectedRow.lastEmail } };
      if (rejectedRow.details) props["Rejection Reason"] = richText_(rejectedRow.details);
    }

    if (apply) {
      updates++;
      notion_(cfg, "patch", `pages/${primary.id}`, { properties: props });
      g.slice(1).forEach(dup => notion_(cfg, "patch", `pages/${dup.id}`, { archived: true }));
      Utilities.sleep(350); // Notion allows about 3 requests per second
    }
  });

  // Near-duplicates are only reported, never merged automatically.
  const keys = Object.keys(groups);
  keys.forEach(a => keys.forEach(b => {
    const [, ca, ra] = a.split("|"), [, cb, rb] = b.split("|");
    if (a < b && ca === cb && ra && rb && (ra.startsWith(rb) || rb.startsWith(ra))) {
      Logger.log(`CHECK manually: ${groups[a][0].name} | "${ra}"  vs  "${rb}"`);
    }
  }));

  Logger.log(`${apply ? "APPLIED" : "DRY RUN"}: ${merges} duplicate rows ${apply ? "archived" : "would be archived"}, ` +
    `${apply ? updates + " rows updated" : Object.keys(groups).length + " rows would remain"}.`);
}
