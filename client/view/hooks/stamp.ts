// Which avcs-view mod this is (#29), sent with each call to the server as
// X-Abso-Client. The installer (client/src/install.ts) writes the installed
// copy of this file with the version it installs: plugin.json's, plus the
// commit (0.1.0+702c616). Loaded straight from a checkout, it stays undefined.
export const STAMP: string | undefined = undefined;
