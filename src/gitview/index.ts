// The git view and plain git in (Node side; isomorphic-git over node:fs).
//
//   const view = await writeView(graph, 'a7', dir);              // one commit per atom
//   await writeView(graph, shared, dir2, { byLabel: true });      // one commit per label
//   // ... a person clones dir, commits with ordinary git ...
//   const result = await ingest(graph, shared, cloneDir);         // atoms + labels added to graph
//   shared = result.shared;                                       // caller saves graph and shared

export * from "./errors.ts";
export * from "./ingest.ts";
export * from "./trailers.ts";
export * from "./tree.ts";
export * from "./view.ts";
