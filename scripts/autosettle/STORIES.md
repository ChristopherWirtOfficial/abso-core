# Auto-settle: stories

Christopher, 2026-10-14: "we give it to everyone for free but we have a gate on it. The gate defaults to on but can be turned off with the runtime controls… on a given project… off - advice only - attempt auto-merge and maybe set the slider or something for confidence… The website especially needs affordances for this."

What exists (abso-core 204, issue 19):
- On a held push, the server asks Clef which settle fits each collision: keep yours, keep theirs, keep both, or leave it to an agent. Code checks run before and after the model.
- Under advice, the held push's answer carries that advice, and the agent still settles.
- Under settle, the client pulls, settles the collisions advised a side, and pushes again, with "Settled automatically" in the message.
- Today one server-wide variable, `AUTOSETTLE`, picks off, `on` (advice) or `act` (settle).

Words: hold (a push refused for colliding), settle, advice, confidence, auto-settle.

## Gate (environment-wide)
- **G1** · Operator · Auto-settle is a runtime control beside CI and sign-ins. It is open unless stopped. Stopping it takes effect on the next push, everywhere, with a reason in the control's audit log.
- **G2** · Anyone · While the gate is stopped, held pushes look exactly as they do without auto-settle. A project's setting is kept, and the website says "Stopped by abso for now" beside it.
- **G3** · Operator · If the control can't be read, or the model fails or is slow, the push gets no advice rather than an error. A hold never gets worse because of auto-settle.

## Project setting
- **P1** · Owner · Project Settings has an Auto-settle section with three choices: **Off**, **Advise**, **Settle**. New projects start on Advise. *(Pitch: Advise is free and changes nothing an agent does. Settle is opt-in per project.)*
- **P2** · Owner · Under Settle, a confidence slider sets how sure the model must be before abso settles (default 0.5). Below it, the hold stays with the agent, carrying the advice.
- **P3** · Owner · Beside the slider: "At this setting, the last N holds would have gone: X settled, Y to an agent". The figures come from the project's own past holds, so the slider shows its effect before I save.
- **P4** · Owner · The CLI matches: `abso autosettle [off|advise|settle] [--at 0.6]`. With no argument it shows the setting and who changed it last.
- **P5** · Writer, Reader · I see the setting read-only, and who set it.
- **P6** · Owner · A change to the setting is a line on the project's Now: "Christopher set auto-settle to Settle at 0.6".

## Agent
- **A1** · Agent · When my push is held under Advise, the hold's text gives each collision's advice in one line: the pick, the confidence, and the reason.
- **A2** · Agent · Under Settle, a held push that abso can settle goes through as one push. The output says which files abso settled and how, and how to see or undo it.
- **A3** · Agent · If any collision in my push is left to an agent, nothing is settled for me, not even the rest. I get the hold as today, with advice on every collision.
- **A4** · Agent · `ABSO_AUTOSETTLE=off` on my machine means I always settle by hand, whatever the project says.
- **A5** · Other agent · When abso settles a hold against my work, my news says so, like any settle: "abso settled X's collision with your version N in file: kept theirs (confidence 0.81: reason)".

## Record and undo
- **R1** · Anyone · A version abso settled is marked on Activity and on the version page: "Settled automatically", with each file's pick, confidence and reason. `abso why file:line` names it too.
- **R2** · Writer · On that version there's an **Undo** button: it drops the version (as `abso drop`) and gives the hold back to the agent who pushed it. If later versions build on it, it says so first.
- **R3** · Owner · Project Settings shows the last 30 days: holds advised, settled automatically, left to agents, and undone. Undos are the sign the slider is too low.

## Cost
- **C1** · Anyone · Auto-settle is free on every project, public or private. It runs on abso's Workers AI.
- **C2** · Operator · Each project has a ceiling on model calls per hour. Past it, holds get no advice until the hour turns, and Settings says so. This keeps one busy project from spending everyone's share.

## Tonight
In order, cut-first:
1. Gate as a runtime control (G1–G3) and the project setting stored on the project (P1, P2, P5), read on publish in place of the server-wide variable.
2. Website Settings section: the three choices and the slider (P1, P2, P5), plus the "Stopped by abso" line (G2).
3. "Settled automatically" on Activity and the version page (R1), and news to the other agent (A5).
4. Later: the slider preview (P3), Undo (R2), the 30-day figures (R3), the call ceiling (C2), and the CLI command (P4).

## Open
- Does the server settle, or the client? Today the client settles, because a server-side settle moves the agent's base without its folder knowing. The client way works on every client at 204 or newer. Older clients only see advice.
- Default for new projects: Advise (pitched above), or Settle?
