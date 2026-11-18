# Gemini CLI as the third execution client

The owner approved merging the desktop team's Gemini client support into main on 2026-11-18. It was
developed on a separate branch, and the schema it needs (12: `team_attempts` and `team_bootstraps`
admitting `gemini`) is already on main from PR #246.

- Extend the existing direct-child launch, team settings, model choices, progress, completion and
  continuation paths. Do not add another execution service.
- Follow the installed 0.68.0 headless protocol: piped stdin for the prompt, `--output-format
  stream-json`, an explicit session id, exact-session resume, and the existing role posture: `yolo`
  for a writer and `plan` for a reviewer.
- Preserve final answers up to the existing turn-message limit, separately from bounded event
  summaries, so reviewer reports and chat replies are not cut to diagnostic length.
- Resolve the Windows npm launcher to its JavaScript entry and run it with the engine's own Node,
  without a command shell.
- Trust only the admitted workspace for the current invocation with `--skip-trust`. The installed
  client exits with code 55 on a fresh candidate tree without it; never modify its saved
  folder-trust settings.
- Admit the per-attempt output directory so native file tools can write the existing report and
  evidence files. A read-only turn instead admits its selected review evidence directory, when
  present, and stays in `plan`.
- Every role also admits the directories of the exact instructions named by its managed prompt,
  including the selected framework source package for relative references. Derive these from the
  existing instruction list; do not admit the shared state root or the parent holding other
  attempts.
- Keep native authentication owned by the installed client. Do not copy credentials, install
  another CLI, or alter the owner's account configuration. The client has no non-interactive
  sign-in status command, so the setup screen reports its state as unknown rather than guessing.
- The removed hardened-isolation path does not gain support, and this amendment does not restore it.