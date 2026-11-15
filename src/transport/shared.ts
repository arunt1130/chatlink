/**
 * Contents of the shared repo's own config files. First-run setup (M4) writes
 * them; tests use them to seed the fake remote.
 */

/** Only logs/<author>/*.jsonl, space.json, .gitignore and .gitattributes are ever shared. */
export const SHARED_GITIGNORE = `# chatlink shared repo: only raw logs and space.json are shared.
/*
!/.gitignore
!/.gitattributes
!/space.json
!/logs/
/logs/**
!/logs/*/
!/logs/*/*.jsonl
`;

/** LF everywhere, so logs are byte-identical on every OS. */
export const SHARED_GITATTRIBUTES = `*.jsonl text eol=lf
space.json text eol=lf
`;

/**
 * The shared space's own file. Fixed contents (members are the folders under
 * logs/), so two people setting up at the same time write identical files.
 */
export const SHARED_SPACE_JSON = `${JSON.stringify({ v: 1, app: "chatlink", members: {} }, null, 2)}
`;

/** Files first-run setup creates when the shared repo doesn't have them. */
export const SHARED_FILES: readonly { path: string; content: string }[] = [
  { path: ".gitignore", content: SHARED_GITIGNORE },
  { path: ".gitattributes", content: SHARED_GITATTRIBUTES },
  { path: "space.json", content: SHARED_SPACE_JSON },
];
