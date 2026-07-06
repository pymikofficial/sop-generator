# SOP Generator

Ramble through a process, however messy or out of order, and get back a clean, numbered Standard Operating Procedure: purpose, steps, tools referenced, and exceptions. Optionally paste a real SOP you already have, and the new one will match its structure and tone, without reusing any of its actual content.

**Live:** [sop-generator.netlify.app](https://sop-generator.netlify.app)

## The headache

At God Crew I wrote 9 SOPs by hand for a founder's internal operations, each one meant a real process explained verbally or in fragments, then manually shaped into a document someone new could follow without me in the room. The actual bottleneck was never the writing, it was translating a messy explanation into the right structure. This tool automates that translation, not the judgment behind it.

## The machinery: retrieval, not just extraction

This is the first tool in the cosmik.work suite built around retrieval rather than pure extraction. Every other tool here (Fieldnote, Meeting Minutes, Executive Briefing Generator) takes one input and structures it. This one can optionally take a **second input**, an existing SOP, and use it as grounding material.

The reference SOP is deliberately scoped to style only:

- The drafter prompt is explicit that the reference teaches formality, phrasing conventions, step granularity, and exception framing, never actual content.
- The auditor's second pass includes a dedicated leakage check: did the draft accidentally reuse a specific step, tool, or fact from the reference rather than the submitted process.
- The smoke test verifies this directly, it submits a reference SOP about vendor invoice approval alongside a completely unrelated process (candidate no-shows), then asserts none of the reference's specific terms (purchase order, budget threshold, etc.) appear in the output.

This is retrieval-augmented generation in its simplest legitimate form: grounding generation in a real document without letting that document's content contaminate an unrelated output.

## Guardrails

- **PII scrub on both inputs**: emails and phone numbers stripped server-side, in the process description and the reference SOP, before either reaches the API.
- **Daily rate limit**: a Blob-backed counter caps generations per day.
- **Input caps**: 24,000 characters for the process description, 16,000 for the reference SOP.

## Architecture

Same proven pattern as the rest of the suite: background function + polling (Netlify auto-responds 202 for `-background` suffixed functions, avoiding the ~10s synchronous timeout), Netlify Blobs for job state, drafter-then-auditor two-call pipeline.

1. `generate-sop-background.js`: rate limit → PII scrub (both fields) → drafter call (branches on whether a reference was supplied) → auditor call (completeness + leakage check) → result written to Blobs.
2. `check-sop.js`: polling endpoint, hit every 2s by the frontend.
3. Frontend: dual textareas (process + optional reference), voice input via the Web Speech API for the process field (same pattern as Fieldnote/Meeting Minutes), a visible "Style-matched to reference" badge when a reference was used.

## Environment variables (all three required)

| Variable | What it is |
|---|---|
| `ANTHROPIC_API_KEY` | Anthropic API key |
| `NETLIFY_SITE_ID` | This site's ID, from Project details |
| `NETLIFY_BLOBS_TOKEN` | Netlify Personal Access Token |

Note: `getStore()` must be called with explicit `siteID` and `token`, ambient environment configuration doesn't pass through correctly in this deployment setup.

## Smoke test

`node scripts/smoke-test.mjs` runs two full generations against the live site: one without a reference (verifies the plain path and confirms `styleMatched: false`), one with a reference (verifies `styleMatched: true` and directly checks the output for leaked reference content).

Built by [Soumik Chatterjee](https://cosmik.work).
