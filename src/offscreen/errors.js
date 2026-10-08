// Errors meant for the user. The offscreen document has no chrome.i18n, so
// they carry a message key (see extension/_locales) plus substitutions, and
// the service worker translates them.

export class UserError extends Error {
  constructor(key, ...substitutions) {
    super(`${key} ${substitutions.join(" ")}`.trim());
    this.key = key;
    this.substitutions = substitutions;
  }
}

/** { key, substitutions } for the service worker; substitutions may nest. */
export const errorPayload = (e) => ({ key: e.key, substitutions: e.substitutions.map((s) => (s instanceof UserError ? errorPayload(s) : String(s))) });
