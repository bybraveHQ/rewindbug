// stdout belongs to the MCP stdio protocol: diagnostics go to stderr only
export const log = (message: string): void => {
  process.stderr.write(`rewindbug-mcp: ${message}\n`);
};
