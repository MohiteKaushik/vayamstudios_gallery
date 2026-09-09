/**
 * Sign-up validation and client-data export.
 *
 *   npm run test:members
 */

import {
  normalisePhone,
  validatePhone,
  validateName,
  validateEmail,
  validatePassword,
  validateSignUp,
  formatPhone,
  membersToCsv,
  csvFileName,
  REQUIRE_GMAIL,
  type MemberRow,
} from "../src/lib/members.ts";

let failures = 0;
const check = (name: string, pass: boolean, detail = "") => {
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!pass) failures++;
};

// ===========================================================================
console.log("\n=== 1. mobile numbers must start 9, 8, 7 or 6 ===");
for (const first of ["9", "8", "7", "6"]) {
  const n = first + "876543210".slice(0, 9);
  check(`${first} accepted`, validatePhone(n) === null, n);
}
for (const first of ["0", "1", "2", "3", "4", "5"]) {
  const n = first + "876543210".slice(0, 9);
  check(`${first} rejected`, validatePhone(n) !== null, validatePhone(n) ?? "");
}
check("nine digits rejected", validatePhone("987654321") !== null);
check("eleven digits rejected", validatePhone("98765432101") !== null);
check("empty rejected", validatePhone("") !== null);
check("letters rejected", validatePhone("abcdefghij") !== null);

console.log("\n=== 2. numbers people actually type ===");
check("+91 with spaces", validatePhone("+91 98765 43210") === null);
check("leading zero", validatePhone("098765 43210") === null);
check("hyphenated", validatePhone("98765-43210") === null);
check("brackets", validatePhone("(+91) 9876543210") === null);
check("normalises to ten bare digits", normalisePhone("+91 98765-43210") === "9876543210",
  normalisePhone("+91 98765-43210"));
check("a valid 91-prefixed number survives", normalisePhone("919876543210") === "9876543210");
check("display form", formatPhone("9876543210") === "98765 43210", formatPhone("9876543210"));

console.log("\n=== 3. names ===");
check("plain name", validateName("Gagan Sharma") === null);
check("apostrophe", validateName("D'Souza") === null);
check("hyphen", validateName("Anne-Marie") === null);
check("non-latin script", validateName("गगन") === null);
check("empty rejected", validateName("  ") !== null);
check("single letter rejected", validateName("A") !== null);
check("digits rejected", validateName("User123") !== null);
check("leading symbol rejected", validateName("<script>") !== null);

console.log("\n=== 4. email and password ===");
check("ordinary address", validateEmail("gagan@gmail.com") === null);
check("uppercase tolerated", validateEmail("Gagan@Gmail.COM") === null);
check("missing @ rejected", validateEmail("gagan.gmail.com") !== null);
check("missing domain rejected", validateEmail("gagan@") !== null);
console.log(`    REQUIRE_GMAIL is ${REQUIRE_GMAIL}, so a work address is ${REQUIRE_GMAIL ? "rejected" : "accepted"}`);
check("non-gmail matches the flag",
  (validateEmail("gagan@vayamdesigners.com") === null) === !REQUIRE_GMAIL);

check("short password rejected", validatePassword("abc123") !== null);
check("letters only rejected", validatePassword("password") !== null);
check("digits only rejected", validatePassword("12345678") !== null);
check("letters and digits accepted", validatePassword("vayam2024") === null);

console.log("\n=== 5. the whole form at once ===");
{
  const good = validateSignUp({
    fullName: "Gagan Sharma", phone: "+91 98765 43210",
    email: "gagan@gmail.com", password: "vayam2024",
  });
  check("valid form has no errors", Object.keys(good).length === 0, JSON.stringify(good));

  const bad = validateSignUp({ fullName: "", phone: "12345", email: "nope", password: "x" });
  check("every bad field is reported", Object.keys(bad).length === 4, Object.keys(bad).join(", "));
  check("each message is human", Object.values(bad).every((m) => typeof m === "string" && m.length > 8));
}

// ===========================================================================
console.log("\n=== 6. CSV export ===");
{
  const members: MemberRow[] = [
    {
      id: "1", fullName: "Gagan Sharma", phone: "9876543210", email: "gagan@gmail.com",
      joinedAt: "2026-09-01T10:00:00Z", lastSignInAt: "2026-09-09T08:00:00Z",
      hasFaceProfile: true, photosFound: 42,
    },
    {
      id: "2", fullName: "Anne-Marie O'Brien", phone: "8123456789", email: "anne@example.com",
      joinedAt: "2026-09-05T10:00:00Z", lastSignInAt: null,
      hasFaceProfile: false, photosFound: 0,
    },
  ];

  const csv = membersToCsv(members);
  const rows = csv.split("\r\n");
  check("header plus one row per member", rows.length === 3, `${rows.length} lines`);
  check("header names the columns", rows[0] === "Name,Phone,Email,Joined,Last signed in,Face profile,Photos found", rows[0]);
  check("dates trimmed to the day", rows[1]!.includes("2026-09-01"));
  check("never signed in is readable", rows[2]!.includes("Never"));
  check("face profile as yes/no", rows[1]!.includes("Yes") && rows[2]!.includes("No"));
  check("photo count carried", rows[1]!.endsWith(",42"));
  check("filename is dated", /^vayam-members-\d{4}-\d{2}-\d{2}\.csv$/.test(csvFileName()), csvFileName());
}

console.log("\n=== 7. a hostile name cannot execute in a spreadsheet ===");
{
  // A member controls their own name. Excel and Sheets treat a leading =, +, -
  // or @ as a formula, so an export is a live attack surface if unescaped.
  const nasty: MemberRow[] = [
    {
      id: "3", fullName: '=HYPERLINK("http://evil.test","click")', phone: "9000000000",
      email: "x@y.com", joinedAt: null, lastSignInAt: null, hasFaceProfile: false, photosFound: 0,
    },
    {
      id: "4", fullName: 'Smith, "Bob"\nsecond line', phone: "9000000001",
      email: "b@y.com", joinedAt: null, lastSignInAt: null, hasFaceProfile: false, photosFound: 0,
    },
    {
      id: "5", fullName: "+1234", phone: "9000000002",
      email: "c@y.com", joinedAt: null, lastSignInAt: null, hasFaceProfile: false, photosFound: 0,
    },
  ];
  const csv = membersToCsv(nasty);
  check("formula is neutralised", csv.includes(`"'=HYPERLINK`), csv.split("\r\n")[1]!.slice(0, 40));
  check("leading plus is neutralised", csv.includes("'+1234"));
  check("no bare formula start survives",
    !csv.split("\r\n").slice(1).some((r) => /^[=+@]/.test(r)));
  check("quotes are doubled", csv.includes('""Bob""'));
  check("embedded comma and newline are quoted", csv.includes('"Smith, ""Bob""\nsecond line"'));
  // Records are separated by CRLF; the newline inside a quoted name is a bare
  // LF, so it stays part of its field instead of splitting the row.
  check("header plus three records", csv.split("\r\n").length === 4, `${csv.split("\r\n").length}`);
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED"}`);
process.exit(failures === 0 ? 0 : 1);
