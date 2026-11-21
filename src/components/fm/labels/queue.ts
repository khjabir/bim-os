// Assets handed to the Labels page from elsewhere (a selection on the Assets
// page, an asset's own label), kept in memory for the next visit.

import { create } from "zustand";

export const useLabelQueue = create<{ ids: string[] | null }>(() => ({ ids: null }));

export function setLabelQueue(ids: string[]) {
  useLabelQueue.setState({ ids });
}
