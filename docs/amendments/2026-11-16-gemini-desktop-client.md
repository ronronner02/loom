# Additional desktop execution client

The owner approved adding Gemini CLI to the desktop team's selectable clients on 2026-11-16, separately from the character-design submission.

- Extend the existing direct-child launch, team settings, model choices, progress, completion, and continuation paths. Do not add another execution service.
- Follow the installed 0.68.0 headless protocol: stdin prompts, streaming JSON, explicit session IDs, exact-session resume, and the existing role-based read-only posture.
- Preserve final answers up to the existing turn-message limit, separately from bounded event summaries, so reviewer reports and chat replies are not cut to diagnostic length.
- Resolve Windows npm launchers to their JavaScript entry and run it with the engine's Node runtime, without invoking a command shell.
- Trust only the admitted workspace for the current headless invocation with `--skip-trust`. The installed client exits with code 55 on a fresh candidate tree without this flag; do not modify its saved folder-trust settings.
- Include the implementer's per-attempt output directory so native file tools can write the existing report and evidence files. A read-only turn instead includes its selected review evidence directory, when present, and retains plan mode.
- Every role also admits the directories of the exact instructions named by its managed prompt, including the selected framework source package for relative references. The installed client otherwise rejects those reads as outside its workspace. Derive these directories from the existing instruction list; do not add the shared state root or the parent containing other attempts.
- Keep native authentication owned by the installed client. Do not copy credentials, install another CLI, or alter the owner's account configuration.
- Carry existing databases forward before admitting the additional client/provider values. Preserve attempt identities, telemetry, and dependent rows.
- The deferred hardened-isolation path does not gain support. No release, installation, deployment, or Windows export is included.
- Keep the integration PR open for visual verification, as the owner requested on 2026-11-16. Passing component tests and CI do not replace the missing before/after captures.
