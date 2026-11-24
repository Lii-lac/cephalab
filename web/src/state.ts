// Mutable state the v52 sections shared as plain globals (one classic-script scope). Each field is set where v52
// declared it (weapons.ts, editor.ts, data.ts, path.ts); every reader and writer goes through ui.
export const ui: {
  sortMode: any;
  filt: any;
  pick: any;
  beadsRebuilt: any;
  ed: any;
  sel: any;
  edIdx: any;
  edKey?: string | null;   // the build open in the editor, by data.ts bkey (its index can shift)
  edFrom: any;
  gFind: any;
  useChunks: any;
  chunkStop: any;
  lastChunkStop: any;
  useDrinks: any;
  fixedOrder: any;
} = {} as any;
