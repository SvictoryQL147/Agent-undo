# Contributing

Thanks for helping make agents safer to run.

1. Fork and clone, then `npm install`.
2. Make your change in `src/`. Keep runtime dependencies at zero if at all possible.
3. Add or update a test in `test/` and run `npm test`.
4. Open a PR describing what changed and why.

Good first issues:

- Better name heuristics in `src/classify.ts` for popular MCP servers
- A `.undo` size limit and `agent-undo gc`
- Windows testing
- The local web timeline UI (`agent-undo ui`)

Please open an issue before starting large features (database rollback, new transports) so we can agree on the design.
