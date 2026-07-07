#!/usr/bin/env node
// Smoke test for SOP Generator, run against the LIVE deployed site.
// Runs TWO generations: one with a reference SOP (tests the RAG/style-match
// path and the styleMatched flag) and one without (tests the plain path).
//
// Usage: node scripts/smoke-test.mjs [base_url]

const BASE_URL = process.argv[2] || 'https://cosmik-sop-generator.netlify.app';
const POLL_MS = 2000;
const MAX_POLLS = 45;

const PROCESS_INPUT = `
When a candidate no-shows an interview: wait 15 minutes past the scheduled time first.
Then send a follow-up email asking to reschedule, always CC the hiring manager,
contact them at hr-team@example.com if needed, or call +91 98765 43210 for urgent cases.
If they don't respond in 48 hours, mark them as unresponsive in the tracker.
If it's a SECOND no-show, don't offer a reschedule, just close the candidate out.
`.trim();

// A short, clearly-formatted reference SOP to test style-matching without leakage.
const REFERENCE_SOP = `
TITLE: Vendor Invoice Approval
PURPOSE: Ensure every vendor invoice is verified before payment release.
STEPS:
1. Finance receives invoice via email.
2. Match invoice to purchase order number.
3. Manager approves if amount is under budget threshold.
4. Finance releases payment within 5 business days.
EXCEPTIONS:
- If invoice exceeds threshold, escalate to Director for sign-off.
`.trim();

function log(msg) { console.log(msg); }
function fail(msg) { console.log('FAIL: ' + msg); process.exitCode = 1; }
function pass(msg) { console.log('PASS: ' + msg); }

async function runOne(label, text, reference) {
  const jobId = label.toLowerCase().replace(/\s+/g, '-') + '-' + Date.now();
  log(`\n=== ${label} (job ${jobId}) ===`);
  const startedAt = Date.now();

  let kickoff;
  try {
    kickoff = await fetch(`${BASE_URL}/.netlify/functions/generate-sop-background`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId, text, reference: reference || '' })
    });
  } catch (e) {
    fail(`${label}: could not reach generate-sop-background: ${e.message}`);
    return null;
  }
  if (kickoff.status !== 202 && kickoff.status !== 200) {
    fail(`${label}: unexpected status ${kickoff.status}`);
    return null;
  }

  let record = null;
  for (let i = 0; i < MAX_POLLS; i++) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    let res;
    try {
      res = await fetch(`${BASE_URL}/.netlify/functions/check-sop?jobId=${encodeURIComponent(jobId)}`);
    } catch (e) { continue; }
    const data = await res.json();
    if (data.status === 'done' || data.status === 'error') { record = data; break; }
  }

  const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
  if (!record) { fail(`${label}: timed out after ~90s.`); return null; }
  if (record.status === 'error') { fail(`${label}: server error: ${record.message}`); return null; }

  if (Number(elapsedSec) <= 90) pass(`${label}: generated in ${elapsedSec}s (within 90s budget).`);
  else fail(`${label}: took ${elapsedSec}s, over budget.`);

  return record;
}

async function main() {
  log(`Testing ${BASE_URL}`);

  // --- Run 1: no reference ---
  const noRef = await runOne('No-reference run', PROCESS_INPUT, '');
  if (noRef) {
    const s = noRef.sop || {};
    const issues = [];
    if (!s.title) issues.push('missing title');
    if (!Array.isArray(s.steps) || s.steps.length < 3) issues.push('expected 3+ steps, got ' + (s.steps || []).length);
    if (!Array.isArray(s.exceptions) || s.exceptions.length < 1) issues.push('expected 1+ exception (second no-show case)');
    if (issues.length === 0) pass(`No-reference run: structure correct (${s.steps.length} steps, ${s.exceptions.length} exceptions).`);
    else fail(`No-reference run: ${issues.join(', ')}`);

    if (noRef.styleMatched === false) pass('No-reference run: styleMatched correctly false.');
    else fail('No-reference run: styleMatched should be false with no reference provided.');

    const scrub = noRef.scrubCounts || {};
    if ((scrub.emails || 0) >= 1 && (scrub.phones || 0) >= 1) {
      pass(`No-reference run: PII scrub confirmed (${scrub.emails} email, ${scrub.phones} phone).`);
    } else {
      fail(`No-reference run: expected PII scrubbed, got emails=${scrub.emails||0} phones=${scrub.phones||0}.`);
    }

    if (Array.isArray(s.audit_flags)) pass('No-reference run: auditor ran.');
    else fail('No-reference run: no audit_flags field, auditor may not have run.');
  }

  // --- Run 2: with reference (tests RAG/style path + no content leakage) ---
  const withRef = await runOne('Reference-style run', PROCESS_INPUT, REFERENCE_SOP);
  if (withRef) {
    const s = withRef.sop || {};
    if (withRef.styleMatched === true) pass('Reference-style run: styleMatched correctly true.');
    else fail('Reference-style run: styleMatched should be true when a reference is provided.');

    // Leakage check: none of the reference's specific content should appear in the new SOP.
    const flat = JSON.stringify(s).toLowerCase();
    const leakTerms = ['vendor invoice', 'purchase order', 'director for sign-off', 'budget threshold'];
    const leaked = leakTerms.filter((t) => flat.includes(t));
    if (leaked.length === 0) {
      pass('Reference-style run: no reference content leaked into output (checked for vendor/invoice/PO terms).');
    } else {
      fail('Reference-style run: possible content leakage, found terms: ' + leaked.join(', '));
    }

    if (s.title && /no-?show|interview|candidate/i.test(JSON.stringify(s))) {
      pass('Reference-style run: output is actually about the submitted process (candidate no-shows), not the reference.');
    } else {
      fail('Reference-style run: output does not clearly reflect the submitted process.');
    }
  }

  log('\n--- Full SOPs (for manual eyeballing) ---');
  if (noRef) log('No-reference:\n' + JSON.stringify(noRef.sop, null, 2));
  if (withRef) log('\nReference-style:\n' + JSON.stringify(withRef.sop, null, 2));
}

main();
