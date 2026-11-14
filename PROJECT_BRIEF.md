# Rally — project brief
_Last updated: 2026-11-14 by /start-here_

## Core
- What: A table tennis scorer for phones that saves match history and feeds a shared, live leaderboard. Tagline: "Every point counts."
- Users and main action: Anyone with the link scores a match point by point. Finished matches are saved and show up on everyone's leaderboard.
- Status: new
- Version 1 done when: scoring, saved history and a shared leaderboard work on a phone · Deadline: none
- Type: other (shareable web app)

## Design            (pro-design, restyled 2026-11-14)
- Concept: the club practice hall. Setup is the table seen from above, play is a flip-card score keeper, rankings are the ladder board, history is the umpire's score sheet.
- Colours: table blue in full blocks, red/black rubber for the two ends, ball orange as the single accent, blue-tinted chalk neutrals (OKLCH), real dark mode.
- Type: Big Shoulders Display (display, digits) + Archivo (text) + Fragment Mono (labels). Sharp 2–6px radius system.
- Motion: Animate rules (product UI): 200ms flip on the scoring card, sheet and toast ease-out, reduced-motion respected.
- Mockups: Design canvas "Rally Screens" (https://claude.ai/artifact/MZqfZgQ8ZCdE8UHCY9hmD3).

## Other
- Runs on: phone browser, as a shareable claude.ai artifact that can be added to the home screen
- In / out: taps per point → saved matches → Elo leaderboard, head-to-head stats, history
- Tools: single-page HTML app with the artifact's shared database for matches and players
- Limits: free, no payment tier; "premium" means polished pro features

## Working style
- Replies: normal · Check-ins: build it all, then show me

## Assumptions
- Name "Rally" picked by Claude.
- Pro features: Elo ratings, win streaks, head-to-head, games to 11 (win by 2), best of 3/5/7, automatic serve rotation with deuce handling, side-switch reminders, undo, match timer, point-by-point momentum chart, haptics.
- Players are free-text names shared across everyone. There are no accounts.

## Risks
- Anyone with the link can log matches, so the leaderboard runs on trust.
- It isn't a native app-store app.
