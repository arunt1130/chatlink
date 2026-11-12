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
