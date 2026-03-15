# Session 7dbc73b2-addc-4baa-b824-514222880f34

Date: 2026-03-13T14:06:12.557Z

session: 7dbc73b2
count: 3

1. You ran 3 grep/rg searches this session. For faster semantic code exploration:
  `claudemem --agent map "your concept"` -- understands intent, not just text
  `claudemem --agent symbol "SymbolName"` -- direct AST symbol lookup
  Skill: use the Skill tool with `code-analysis:claudemem-search`
2. Session files detected in /tmp/ -- these are cleared on reboot. Use persistent paths:
  `ai-docs/sessions/{task-slug}-{timestamp}-{random}/` for research artifacts
  `.claude/.coaching/` for plugin state
  See: CLAUDE.md Session Directories section
3. You read 23 files before delegating to an agent (pre-digestion anti-pattern).
  For investigation tasks, give agents the raw problem -- they investigate independently.
  Pre-digested context reduces multi-model diversity. See: MEMORY.md 'Raw Task vs Pre-Digested Context'
