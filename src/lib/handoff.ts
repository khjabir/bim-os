// Passes files from one viewer page to another without a round trip through
// disk: the NWD page exports an IFC and hands it to the IFC viewer, which
// picks it up when its engine is ready. Works because moving between pages
// is a client-side navigation and this module stays loaded.

let pending: File[] = [];

export function handOffFiles(files: File[]) {
  pending = files;
}

/** Returns the files left for the next viewer, once. */
export function takeHandedOffFiles(): File[] {
  const files = pending;
  pending = [];
  return files;
}
