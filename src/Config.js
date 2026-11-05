/**
 * Everything you are expected to edit lives in this file.
 * Secrets never go here: set them in Project Settings > Script Properties.
 *   NOTION_TOKEN, NOTION_DATABASE_ID       always
 *   GEMINI_API_KEY                         only when USE_AI is true
 *   GEMINI_MODEL                           optional, overrides GEMINI_MODEL below
 */
const CONFIG = {
  // false = rules only. No email text leaves Gmail, and no Gemini key is needed.
  // Emails the rules cannot resolve get the LABEL_REVIEW label instead.
  USE_AI: true,
  GEMINI_MODEL: "gemini-2.5-flash-lite",
  AI_DELAY_MS: 4000, // pause after each Gemini call, keeps the free tier under its per-minute limit

  LABEL_PROCESSED: "AI_Processed",
  LABEL_REVIEW: "Needs_Review",

  RUN_HOUR: 7,          // daily trigger hour, in the script's time zone
  LOOKBACK_DAYS: 3,     // first run only, later runs continue from the last message seen
  BACKFILL_DAYS: 180,   // used by startBackfill()
  MAX_THREADS: 300,     // per run, the rest is picked up next run
  MAX_RETRIES: 3,       // failed messages are retried this many runs, then labeled for review
  BODY_CHARS: 1000,     // how much of an email body is read, and sent to Gemini at most

  // Gmail search terms. A message must also contain one of them to be processed.
  KEYWORDS: [
    "application", "applying", "Bewerbung", "interview", "Vorstellungsgespräch",
    "unfortunately", "leider", "assessment", "receipt", "invoice", "Rechnung",
    "subscription", "trial", "renewal",
    "greenhouse", "workday", "lever", "teamtailor", "personio", "smartrecruiters",
    "ashbyhq", "recruitee", "join.com", "successfactors", "softgarden"
  ],

  // Follow Up formula in Notion: flags "Applied" rows with no news for this many days.
  FOLLOW_UP_MIN_DAYS: 10,
  FOLLOW_UP_MAX_DAYS: 30,
  // Rows whose sender or company matches any of these are never flagged.
  // Add large employers or agencies you would not follow up with, e.g. "bigcorp".
  FOLLOW_UP_SKIP: [
    "workday", "smartrecruiters", "successfactors", "taleo", "icims",
    "linkedin", "indeed", "stepstone", "xing", "recruit", "staffing"
  ],

  // Company names that normalize differently but are the same employer.
  // Keys are lowercase, without legal suffixes like GmbH or Inc.
  COMPANY_ALIASES: {
    // "acme animal health": "acme"
  },

  // Senders on these domains write on behalf of many companies, so they are never cached.
  SHARED_SENDER_DOMAINS: [
    "greenhouse.io", "greenhouse-mail.io", "myworkday.com", "workday.com", "lever.co",
    "smartrecruiters.com", "successfactors.com", "successfactors.eu", "taleo.net",
    "personio.de", "personio.com", "ashbyhq.com", "recruitee.com", "join.com",
    "teamtailor.com", "softgarden.io", "softgarden.de", "icims.com", "jobvite.com",
    "bamboohr.com", "linkedin.com", "indeed.com", "stepstone.de", "xing.com",
    "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "yahoo.com",
    "gmx.de", "gmx.net", "web.de", "icloud.com"
  ],

  // Fuzzy title match: two titles at one company are the same job when at least this
  // share of their words overlap, ignoring location words, and their seniority matches.
  FUZZY_MIN_OVERLAP: 0.8,
  SENIORITY_WORDS: [
    "senior", "sr", "junior", "jr", "lead", "principal", "staff", "head", "chief",
    "intern", "internship", "werkstudent", "working student", "trainee", "praktikum"
  ],
  LOCATION_WORDS: [
    "remote", "hybrid", "onsite", "germany", "deutschland", "europe", "emea",
    "berlin", "munich", "munchen", "hamburg", "frankfurt", "cologne", "koln", "stuttgart"
  ]
};
