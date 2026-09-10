/**
 * VAYAM Designers: the studio's own details and the work it has run.
 *
 * Kept in one place because these strings appear in several screens and, unlike
 * most copy, getting one wrong is expensive: a mistyped digit turns the WhatsApp
 * link into a dead end that nobody reports, they just do not get in touch.
 */

/** Ten digits, no country code, no spaces. Everything else is derived from this. */
const MOBILE_NATIONAL = "9032141474";
const COUNTRY_CODE = "91";

export const contact = {
  /** As a person reads it. */
  phoneDisplay: "+91 90321 41474",
  /** As a dialler needs it. */
  phoneHref: `tel:+${COUNTRY_CODE}${MOBILE_NATIONAL}`,
  /**
   * wa.me wants the full international number with no plus, spaces or dashes.
   * Anything else opens WhatsApp to a "phone number shared via url is invalid"
   * screen rather than a chat.
   */
  whatsappHref: `https://wa.me/${COUNTRY_CODE}${MOBILE_NATIONAL}`,

  email: "vayamdesigners@gmail.com",
  emailHref: "mailto:vayamdesigners@gmail.com",

  websiteDisplay: "vayamdesigners.com",
  websiteHref: "https://vayamdesigners.com",
} as const;

export type VayamEvent = {
  name: string;
  /** Where it was held, when that is part of how people refer to it. */
  place?: string;
  year?: string;
};

/**
 * Work the studio has run, in the order the team gave. The order is theirs and
 * is not sorted or grouped, because it is how they present themselves.
 */
export const events: VayamEvent[] = [
  { name: "CareerNexus", year: "2024" },
  { name: "T Hub Community Fest" },
  { name: "8Matrix Design Conclave" },
  { name: "Sattva Wellness Conclave" },
  { name: "CareerNexus", year: "2025" },
  { name: "Indian Russian Cultural Harmony" },
  { name: "TribeMeet 24", place: "Hyderabad" },
  { name: "TribeMeet 25", place: "Vijayawada" },
  { name: "The Conyape Retreat" },
  // One event run under both names, so it reads as a single line rather than
  // as two entries a visitor would take for separate pieces of work.
  { name: "District 150-Ioniq Connect" },
];

/** The full title as it should read on screen. */
export function eventTitle(e: VayamEvent): string {
  return [e.name, e.year].filter(Boolean).join(" ");
}

export function eventSubtitle(e: VayamEvent): string | null {
  return e.place ?? null;
}
