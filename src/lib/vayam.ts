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

/**
 * The studio's office, as shown under "Contact us" on every page.
 *
 * The phone and WhatsApp come from `contact` above, so the site shows one number
 * everywhere and changing it is a change in one place. The address, hours and
 * the info@ mailbox are the office's own and appear only here.
 */
export const office = {
  address: "SVL Pride, 501, Nagole, Hyderabad, Telangana 500039",
  // The office's exact pin. A search for the address landed on the wrong building.
  mapsHref: "https://www.google.com/maps?q=17.383149,78.553669",
  hours: "Sunday to Saturday, 9:00 AM to 9:00 PM",
  email: "info@vayamdesigners.com",
  emailHref: "mailto:info@vayamdesigners.com",
  phoneDisplay: contact.phoneDisplay,
  phoneHref: contact.phoneHref,
  whatsappHref: contact.whatsappHref,
  websiteDisplay: "vayamdesigners.com",
  websiteHref: "https://vayamdesigners.com",
} as const;

export type VayamEvent = {
  /** Never shown. Renames are stored against it, so it must never change. */
  id: string;
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
  { id: "careernexus-2024", name: "CareerNexus", year: "2024" },
  { id: "t-hub-community-fest", name: "T Hub Community Fest" },
  { id: "8matrix-design-conclave", name: "8Matrix Design Conclave" },
  { id: "sattva-wellness-conclave", name: "Sattva Wellness Conclave" },
  { id: "careernexus-2025", name: "CareerNexus", year: "2025" },
  { id: "indian-russian-cultural-harmony", name: "Indian Russian Cultural Harmony" },
  { id: "tribemeet-24", name: "TribeMeet 24", place: "Hyderabad" },
  { id: "tribemeet-25", name: "TribeMeet 25", place: "Vijayawada" },
  { id: "conyape-retreat", name: "The Conyape Retreat" },
  // One event run under both names, so it reads as a single line rather than
  // as two entries a visitor would take for separate pieces of work.
  { id: "district-150-ioniq-connect", name: "District 150-Ioniq Connect" },
  { id: "ttpoc-carreer-nexus-3", name: "TTPOC CARREER NEXUS 3.0" },
];

/** The full title as it should read on screen, before any rename. */
export function eventTitle(e: VayamEvent): string {
  return [e.name, e.year].filter(Boolean).join(" ");
}

/** Renamed titles an admin saved, by event id. */
export type EventRenames = Record<string, string>;

/** The title to show: the admin's rename if there is one. */
export function shownTitle(e: VayamEvent, renames: EventRenames | undefined): string {
  return renames?.[e.id] ?? eventTitle(e);
}

export function eventSubtitle(e: VayamEvent): string | null {
  return e.place ?? null;
}
