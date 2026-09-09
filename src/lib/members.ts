/**
 * Member sign-up rules and the client-data export.
 *
 * Pure functions only, so the same rules run in the browser form, in the server
 * function that stores the record, and in the test suite. Validation that lives
 * only in the form is not validation; anyone can post around it.
 */

/**
 * Whether the email has to be an @gmail.com address specifically.
 *
 * The brief said "gmail", which in common use often just means "email address".
 * Accepting any valid address is the safer default, since rejecting a member's
 * work address at sign-up is a support call. Set this to true if you meant
 * Gmail literally.
 */
export const REQUIRE_GMAIL = false;

export type MemberDetails = {
  fullName: string;
  phone: string;
  email: string;
  password: string;
};

export type FieldErrors = Partial<Record<keyof MemberDetails, string>>;

/**
 * Indian mobile numbers are ten digits starting 6, 7, 8 or 9.
 * Accepts what people actually type: +91 98765 43210, 098765-43210, and so on.
 */
export function normalisePhone(input: string): string {
  let digits = input.replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith("91")) digits = digits.slice(2);
  else if (digits.length === 11 && digits.startsWith("0")) digits = digits.slice(1);
  return digits;
}

export function validatePhone(input: string): string | null {
  const digits = normalisePhone(input);
  if (!digits) return "Enter your mobile number";
  if (digits.length !== 10) return "A mobile number is 10 digits";
  if (!/^[6-9]/.test(digits)) return "Mobile numbers start with 9, 8, 7 or 6";
  return null;
}

export function validateName(input: string): string | null {
  const name = input.trim();
  if (!name) return "Enter your name";
  if (name.length < 2) return "That name looks too short";
  if (name.length > 80) return "That name is too long";
  if (!/^[\p{L}][\p{L}\s'.-]*$/u.test(name)) return "Use letters, spaces, hyphens and apostrophes only";
  return null;
}

export function validateEmail(input: string): string | null {
  const email = input.trim().toLowerCase();
  if (!email) return "Enter your email";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return "That email doesn't look right";
  if (REQUIRE_GMAIL && !email.endsWith("@gmail.com")) return "Use a Gmail address";
  return null;
}

export function validatePassword(input: string): string | null {
  if (input.length < 8) return "Use at least 8 characters";
  if (!/[a-zA-Z]/.test(input) || !/[0-9]/.test(input)) return "Include at least one letter and one number";
  return null;
}

/** Every sign-up field at once. Empty object means the form is good to submit. */
export function validateSignUp(d: MemberDetails): FieldErrors {
  const errors: FieldErrors = {};
  const name = validateName(d.fullName);
  const phone = validatePhone(d.phone);
  const email = validateEmail(d.email);
  const password = validatePassword(d.password);
  if (name) errors.fullName = name;
  if (phone) errors.phone = phone;
  if (email) errors.email = email;
  if (password) errors.password = password;
  return errors;
}

/** Display form: 98765 43210. Storage stays as ten bare digits. */
export function formatPhone(digits: string): string {
  const d = normalisePhone(digits);
  return d.length === 10 ? `${d.slice(0, 5)} ${d.slice(5)}` : digits;
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export type MemberRow = {
  id: string;
  fullName: string;
  phone: string;
  email: string;
  joinedAt: string | null;
  lastSignInAt: string | null;
  hasFaceProfile: boolean;
  photosFound: number;
};

/**
 * Escapes one CSV field.
 *
 * The leading apostrophe on anything starting =, +, - or @ is deliberate.
 * Spreadsheet software treats those as formulas, so a member who signs up as
 * `=HYPERLINK(...)` would otherwise get their text executed on the machine of
 * whoever opens the export. Names come from strangers on the internet; treat
 * them as data.
 */
function csvField(value: string | number | boolean | null): string {
  if (value === null || value === undefined) return "";
  let s = String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\n\r]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

const COLUMNS: { header: string; get: (m: MemberRow) => string | number | boolean | null }[] = [
  { header: "Name", get: (m) => m.fullName },
  { header: "Phone", get: (m) => m.phone },
  { header: "Email", get: (m) => m.email },
  { header: "Joined", get: (m) => (m.joinedAt ? m.joinedAt.slice(0, 10) : "") },
  { header: "Last signed in", get: (m) => (m.lastSignInAt ? m.lastSignInAt.slice(0, 10) : "Never") },
  { header: "Face profile", get: (m) => (m.hasFaceProfile ? "Yes" : "No") },
  { header: "Photos found", get: (m) => m.photosFound },
];

/** The member list as a CSV that Excel and Sheets both open cleanly. */
export function membersToCsv(members: MemberRow[]): string {
  const lines = [COLUMNS.map((c) => csvField(c.header)).join(",")];
  for (const m of members) lines.push(COLUMNS.map((c) => csvField(c.get(m))).join(","));
  // CRLF is what the CSV spec asks for and what Excel is happiest with.
  return lines.join("\r\n");
}

/** Dated filename so repeated exports do not overwrite each other. */
export function csvFileName(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `vayam-members-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.csv`;
}
