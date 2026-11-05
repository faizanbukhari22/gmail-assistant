const test = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./harness");

const ACME = "Acme Recruiting <jobs@acme.io>";

test("normalization collapses suffixes, gender tags and requisition ids", () => {
  const t = load();
  assert.equal(t.run('makeKey_("Job Application", "Northwind SE", "Engineer (m/w/d)")'),
    t.run('makeKey_("Job Application", "Northwind Group", "Engineer")'));
  assert.equal(t.run('normRole_("Test Engineer - 85053")'), "test engineer");
  assert.equal(t.run('normCompany_("Müller GmbH")'), "muller");
  assert.equal(t.run('makeKey_("Subscription", "Spotify AB", "")'), "sub|spotify ab");
});

test("rules resolve a confirmation without AI", () => {
  const t = load();
  const r = t.run(`classifyByRules_({ subject: "Thank you for your application for QA Engineer",
    sender: ${JSON.stringify(ACME)}, body: "We received your application." })`);
  assert.equal(r.category, "Job Application");
  assert.equal(r.status, "Applied");
  assert.equal(r.company, "Acme");
  assert.equal(r.role, "QA Engineer");
});

test("sender cache skips ATS and free-mail senders", () => {
  const t = load();
  assert.equal(t.run('senderCacheKey_("Acme via Greenhouse <no-reply@greenhouse.io>")'), "");
  assert.equal(t.run('senderCacheKey_("Anna <anna.recruits@gmail.com>")'), "");
  assert.equal(t.run('senderCacheKey_("Lena Fischer <lena@beta.io>")'), "sender:lena fischer|lena@beta.io");
});

test("fuzzy title match ignores location words and guards seniority", () => {
  const t = load();
  assert.equal(t.run('roleSimilarity_("qa engineer", "qa engineer berlin")'), 1);
  assert.equal(t.run('roleSimilarity_("senior qa engineer", "qa engineer")'), 0);
  assert.ok(t.run('roleSimilarity_("qa engineer", "qa automation engineer mobile")') < 0.8);
});

test("follow-up formula is built from config", () => {
  const t = load();
  t.run('CONFIG.FOLLOW_UP_SKIP = ["BigCorp", "bad\\"quote"]');
  const f = t.run("buildFollowUpFormula_()");
  assert.match(f, /dateBetween\(now\(\), prop\("Last Email"\), "days"\) >= 10/);
  assert.match(f, /<= 30/);
  assert.match(f, /"bigcorp\|badquote"/);
});

test("regression: a rejection replying in an already processed thread is read", () => {
  const t = load();
  t.email("acme", { from: ACME, subject: "Thank you for your application for QA Engineer",
    body: "We received your application.", hoursAgo: 48 });
  t.run("processInbox()");
  assert.deepEqual(t.rows().map(r => [r.name, r.status]), [["Acme", "Applied"]]);

  // The reply drops the title. Thread context finds it, so no Gemini call is needed.
  t.email("acme", { from: ACME, subject: "Update",
    body: "Unfortunately we decided not to move forward with your application.", hoursAgo: 1 });
  t.run("processInbox()");
  const rows = t.rows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "Rejected");
  assert.ok(rows[0].rejectedDate);
  assert.equal(t.calls.gemini, 0);
});

test("re-reading old messages changes nothing", () => {
  const t = load();
  t.email("acme", { from: ACME, subject: "Thank you for your application for QA Engineer",
    body: "We received your application.", hoursAgo: 48 });
  t.email("acme", { from: ACME, subject: "Update",
    body: "Unfortunately we decided not to move forward.", hoursAgo: 1 });
  t.run("processInbox()");
  t.props.delete("LAST_MESSAGE_TS"); // as after an upgrade: the last 3 days are read again
  t.run("processInbox()");
  const rows = t.rows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "Rejected");
  assert.equal(rows[0].timesApplied, 1);
});

test("Gemini result is cached per sender, and a re-application is counted", () => {
  const t = load();
  t.calls.geminiReply = () => ({ category: "Job Application", company: "Beta", role: "Data Analyst",
    status: "Applied", reason: "" });
  const lena = "Lena Fischer <lena@beta.io>";
  t.email("b1", { from: lena, subject: "Your application for Data Analyst",
    body: "Thank you for your application.", hoursAgo: 50 });
  t.email("b2", { from: lena, subject: "Your application for Data Analyst",
    body: "Thank you for your application.", hoursAgo: 2 });
  t.run("processInbox()");
  assert.equal(t.calls.gemini, 1);
  const rows = t.rows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].timesApplied, 2);
});

test("a close title variant joins the existing row", () => {
  const t = load();
  t.email("a1", { from: ACME, subject: "Thank you for your application for QA Engineer",
    body: "Received.", hoursAgo: 60 });
  t.email("a2", { from: ACME, subject: "Thank you for your application for QA Engineer (m/w/d) - Berlin",
    body: "Received.", hoursAgo: 1 });
  t.run("processInbox()");
  assert.equal(t.rows().length, 1);
  assert.ok(t.logs.some(l => l.startsWith("FUZZY MERGE")));
});

test("rules-only mode never calls Gemini and labels unknowns for review", () => {
  const t = load();
  t.run("CONFIG.USE_AI = false");
  t.props.delete("GEMINI_API_KEY");
  t.email("x", { from: "Anna <anna@somewhere.io>", subject: "Hello",
    body: "About your application: unfortunately the role is filled.", hoursAgo: 1 });
  t.run("processInbox()");
  assert.equal(t.calls.gemini, 0);
  assert.equal(t.rows().length, 0);
  assert.ok(t.gmail.threads[0].labels.has("Needs_Review"));
});

test("a failed Gemini call is retried, then sent to review", () => {
  const t = load();
  t.email("x", { from: "Anna <anna@somewhere.io>", subject: "Hello",
    body: "About your application.", hoursAgo: 1 });
  for (let i = 0; i < 3; i++) t.run("processInbox()");
  assert.equal(t.calls.gemini, 3);
  assert.ok(t.gmail.threads[0].labels.has("Needs_Review"));
  assert.equal(t.props.get("RETRY_IDS"), "{}");
});

test("setupNotion adds missing columns and the formula", () => {
  const t = load();
  t.run("setupNotion()");
  for (const col of ["Type", "Status", "Key", "Times Applied", "Rejected Date"]) assert.ok(t.notion.schema[col], col);
  assert.match(t.notion.schema["Follow Up"].formula.expression, /prop\("Status"\) == "Applied"/);
});
