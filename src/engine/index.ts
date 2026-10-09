// The engine: atoms, line trees, projections, claims and conflicts. Pure
// TypeScript with no Node imports, so it can run in a Worker.
//
// Typical flow:
//   const graph = new Graph();
//   graph.add(buildBase(files, { author, message }));          // a0
//   let shared = new Set(['a0']);
//   const draft = buildAtom(new View(graph, shared), { author, message, edits });
//   const report = checkDraft(graph, shared, draft);            // touches, conflicts, warnings
//   graph.add(draft); shared.add(draft.id);
//   project(graph, shared);                                      // path -> text

export * from "./build.ts";
export * from "./conflicts.ts";
export * from "./graph.ts";
export * from "./keys.ts";
export * from "./labels.ts";
export * from "./sets.ts";
export * from "./text.ts";
export * from "./types.ts";
export * from "./view.ts";
