# Chat activity improvement stack

This stack separates native event preservation, run state, helper behavior and
small presentation improvements. Each PR compares against the previous layer
and has one review purpose. The existing chat rail, completed-work disclosure,
answer model footer and technical details remain the presentation baseline.

| Order | Pull request | Purpose | Depends on |
|---|---|---|---|
| 1 | [#5518](https://github.com/different-ai/openwork/pull/5518) | Preserve individual code mode results | dev |
| 2 | [#5519](https://github.com/different-ai/openwork/pull/5519) | Preserve native reply chronology and model identity | #5518 |
| 3 | [#5520](https://github.com/different-ai/openwork/pull/5520) | Preserve run timing through waits and settlement | #5519 |
| 4 | [#5521](https://github.com/different-ai/openwork/pull/5521) | Recover helper decisions and native completions | #5520 |
| 5 | [#5522](https://github.com/different-ai/openwork/pull/5522) | Preserve helper navigation and scoped drafts | #5521 |
| 6 | [#5523](https://github.com/different-ai/openwork/pull/5523) | Steer busy helpers and verify scoped stop | #5522 |
| 7 | [#5524](https://github.com/different-ai/openwork/pull/5524) | Refine reasoning and current-step feedback | #5523 |

[PR #5477](https://github.com/different-ai/openwork/pull/5477) is the final,
documentation-only overview. It targets #5524 and adds this document.

## Review and integration

Review each PR against its declared base; upper branches contain the lower
layers in their history. Integrate from the bottom upward. After a base PR
merges into dev, retarget its successor to dev and rerun the relevant checks
at the updated head. Keep this overview last.

The PR change proof workflow targets dev. Evidence journeys on upper layers
run when those PRs target dev; their inclusion is not a claim that screenshots
or a live runtime journey have already passed. Navigation, helper messaging
and reasoning display each name their proving journey in the PR description.

## Presentation boundary

The stack retains the existing live rail height behavior, reasoning disclosure,
completed-work fold and answer model placement. Original task text is available
through a collapsed disclosure in a helper chat. Captured call output remains
under Technical details.

The previous activity-shell replacement, default raw-result previews, agent
tray, internal engine startup labels and aggregate model-label placement are
excluded. They are not dependencies of event capture or helper controls.

## Preserved source

The original implementation remains available on
[`archive/chat-activity-monolith-2026-10-01`](https://github.com/different-ai/openwork/tree/archive/chat-activity-monolith-2026-10-01).
This preserves the source independently of the rewritten overview branch.
