// Naming a copy.
//
// Most things that can be copied here cannot share a name with what they sit beside: collection
// and environment names are unique among active rows, and folder names are unique among their
// siblings. A copy therefore needs a name of its own before it can be written at all, and the
// caller cannot be asked for one - cloning is a single click, not a dialog.

const MAX_NAME_LENGTH = 200;

/**
 * Matches a trailing copy marker so repeated cloning counts up instead of nesting. Without this,
 * copying a copy gives "Payments (copy) (copy)", and the fourth one is unreadable.
 */
const COPY_SUFFIX = /^(.*?)[ \t]*\((?:copy|copy[ \t]+\d+)\)$/i;

/** The name with any trailing copy marker removed, so "Payments (copy 2)" counts from "Payments". */
export function copyStem(name: string): string {
  const stripped = COPY_SUFFIX.exec(name)?.[1]?.trim();
  // A name that is nothing but a marker - "(copy)" - has no stem to count from, so it is kept
  // whole and becomes "(copy) (copy)". That is odd, but it is what the user named it.
  return stripped ? stripped : name;
}

/**
 * The first free name of the form `stem (copy)`, `stem (copy 2)`, ... for a copy of `name`.
 *
 * `isTaken` decides what "free" means, because the scope differs by resource: every active
 * collection, every active environment, or only the folders sharing one parent. Requests are not
 * constrained at all, yet they are numbered too - two identical rows in the tree would leave the
 * user unable to tell the copy from the original, which defeats the point of making one.
 */
export function copyName(name: string, isTaken: (candidate: string) => boolean): string {
  const stem = copyStem(name);
  for (let n = 1; ; n += 1) {
    const marker = n === 1 ? " (copy)" : ` (copy ${n})`;
    // Trimmed from the stem, never from the marker: a name ending in a half-written "(cop" would
    // be worse than a shortened one, and the marker is the part that has to stay readable.
    const candidate = stem.slice(0, MAX_NAME_LENGTH - marker.length).trimEnd() + marker;
    if (!isTaken(candidate)) return candidate;
  }
}
