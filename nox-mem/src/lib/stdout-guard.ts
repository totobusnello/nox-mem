/**
 * On a stdio MCP server, stdout carries JSON-RPC and nothing else. Library code logs with
 * console.log (the schema migrations print "[MIGRATE V5] ..." the first time a DB is opened), and
 * one such line on stdout is a frame the client cannot parse. Measured 2026-11-07 on the 3.8.0
 * tarball: a fresh install's first MCP session wrote that line before the first response.
 *
 * Imported FIRST by mcp-server.ts: ES modules evaluate their imports in order, so this runs before
 * any module that could log. The protocol itself writes with process.stdout.write, untouched.
 */
console.log = console.error;
console.info = console.error;
console.debug = console.error;

export {};
