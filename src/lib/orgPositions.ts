/**
 * Positions and default offices for the organisation.
 *
 * A position is a ready-made job: it sets the account's rank (role), where it sits in the
 * hierarchy (orgRole), the duties it carries (tags) and the permissions it needs. The admin
 * picks a position when creating a staff account and can still adjust anything afterwards.
 */
export type OrgRole = "director" | "hod" | "supervisor" | "officer";
export const ORG_ROLES: OrgRole[] = ["director", "hod", "supervisor", "officer"];

export type Position = {
  key: string;
  title: string;
  orgRole: OrgRole;
  role: "agent" | "alphaAgent";
  tags: Array<"news" | "secretary">;
  /** null = the defaults for the role */
  caps: string[] | null;
  blurb: string;
  /** What this person does day to day; shown on their dashboard. */
  duties: string[];
};

export const POSITIONS: Position[] = [
  { key: "director", title: "Director", orgRole: "director", role: "alphaAgent", tags: [], caps: null,
    blurb: "Leads a directorate and supervises every office and staff member under it.",
    duties: ["Supervise heads of department", "Approve and escalate requests", "Set priorities and assign work", "Review activity across the directorate"] },
  { key: "hod", title: "Head of Department (HOD)", orgRole: "hod", role: "agent", tags: [],
    caps: ["users.view", "documents.review", "documents.manage", "files.center", "courses.manage", "cbt.manage", "tests.manage", "requests.review", "activity.view", "announcements.publish", "feeds.moderate", "moderation.manage", "notifications.send"],
    blurb: "Runs a department and supervises the staff in it.",
    duties: ["Supervise department staff", "Assign and review tasks", "Review submissions from the department", "Report to the Director"] },
  { key: "team-lead", title: "Team Lead", orgRole: "supervisor", role: "agent", tags: [],
    caps: ["users.view", "documents.review", "requests.review", "feeds.moderate", "moderation.manage", "activity.view"],
    blurb: "Supervises a small team of officers day to day.",
    duties: ["Check the team's work", "Hand out tasks", "Unblock officers"] },
  { key: "content-officer", title: "Academic Content Officer", orgRole: "officer", role: "agent", tags: [],
    caps: ["users.view", "documents.review", "documents.manage", "files.center", "courses.manage", "academics.manage"],
    blurb: "Keeps materials, courses and the academic catalogue accurate.",
    duties: ["Review uploaded materials", "Maintain courses and the catalogue", "Clean up the Document Center"] },
  { key: "assessment-officer", title: "Assessment Officer", orgRole: "officer", role: "agent", tags: [],
    caps: ["users.view", "cbt.manage", "utme.manage", "tests.manage"],
    blurb: "Writes and maintains practice questions, UTME banks and timed tests.",
    duties: ["Write and import CBT questions", "Maintain the UTME bank", "Schedule and mark tests"] },
  { key: "finance-officer", title: "Finance & Payments Officer", orgRole: "officer", role: "agent", tags: [],
    caps: ["users.view", "payments.review", "requests.review", "activity.view"],
    blurb: "Verifies payments and subscriptions.",
    duties: ["Review payment claims", "Resolve billing requests", "Audit payment activity"] },
  { key: "support-officer", title: "Student Support Officer", orgRole: "officer", role: "agent", tags: [],
    caps: ["users.view", "users.edit", "users.suspend", "users.password", "requests.review", "support.tickets", "notifications.send"],
    blurb: "Helps students with accounts, profile changes and access problems.",
    duties: ["Handle support tickets and profile-change requests", "Reset access when students are locked out", "Send support notifications"] },
  { key: "moderator", title: "Community Moderator", orgRole: "officer", role: "agent", tags: [],
    caps: ["users.view", "feeds.moderate", "moderation.manage"],
    blurb: "Keeps feeds, groups and comments healthy.",
    duties: ["Work the moderation queue", "Remove rule-breaking posts", "Warn or mute repeat offenders"] },
  { key: "newsroom", title: "Newsroom Officer", orgRole: "officer", role: "agent", tags: ["news"],
    caps: ["users.view", "announcements.publish", "feeds.moderate"],
    blurb: "Writes and publishes Academicall News and announcements.",
    duties: ["Write and publish stories", "Publish announcements", "Keep the newsroom calendar"] },
  { key: "secretary", title: "Secretary", orgRole: "officer", role: "agent", tags: ["secretary"],
    caps: ["users.view", "secretariat.records", "secretariat.activity"],
    blurb: "Keeps the records: memos, minutes, letters and reports.",
    duties: ["File memos and minutes", "Maintain the activity journal"] },
  { key: "admissions-officer", title: "Admissions & Aspirants Officer", orgRole: "officer", role: "agent", tags: [],
    caps: ["users.view", "aspirants.view", "aspirants.manage", "houses.manage", "tests.manage"],
    blurb: "Looks after aspirants and their houses.",
    duties: ["Support aspirants", "Moderate aspirant houses", "Run aspirant tests"] },
  { key: "ict-officer", title: "ICT & Data Officer", orgRole: "officer", role: "agent", tags: [],
    caps: ["users.view", "files.center", "activity.view"],
    blurb: "Keeps an eye on the platform's data, files and audit trail.",
    duties: ["Monitor the audit trail", "Manage stored files"] },
];

export type OfficeSeed = { code: string; name: string; kind: "directorate" | "department" | "unit"; description: string; parent?: string };

/** Offices created by "Set up default offices". Safe to run again: existing ones are skipped. */
export const DEFAULT_OFFICES: OfficeSeed[] = [
  { code: "DAA", name: "Directorate of Academic Affairs", kind: "directorate", description: "Everything students study: materials, courses and assessments." },
  { code: "CNT", name: "Content & Courses", kind: "department", description: "Materials, courses and the academic catalogue.", parent: "DAA" },
  { code: "ASM", name: "Assessment & Examinations", kind: "department", description: "CBT, UTME banks and timed tests.", parent: "DAA" },
  { code: "DSA", name: "Directorate of Student Affairs", kind: "directorate", description: "Student welfare, community and admissions." },
  { code: "SUP", name: "Student Support", kind: "department", description: "Accounts, requests, support tickets and access.", parent: "DSA" },
  { code: "MOD", name: "Community & Moderation", kind: "department", description: "Feeds, groups and reports.", parent: "DSA" },
  { code: "ADM", name: "Admissions & Aspirants", kind: "department", description: "Aspirants, houses and UTME preparation.", parent: "DSA" },
  { code: "DFO", name: "Directorate of Finance & Operations", kind: "directorate", description: "Money, platform operations and data." },
  { code: "PAY", name: "Payments & Subscriptions", kind: "department", description: "Payment claims and subscriptions.", parent: "DFO" },
  { code: "ICT", name: "ICT & Data", kind: "department", description: "Audit trail, files and platform health.", parent: "DFO" },
  { code: "NEWS", name: "Newsroom", kind: "unit", description: "Academicall News and announcements." },
  { code: "SEC", name: "Secretariat", kind: "unit", description: "Records, memos and minutes." },
];
