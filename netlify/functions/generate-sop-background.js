// SOP Generator ~ background function.
// Same verified pipeline as Executive Briefing Generator / Meeting Minutes,
// plus a RAG twist: an optional reference SOP grounds the drafter's output
// in a real house style, without letting the reference's actual content
// leak into the new document (the reference is style material, not a
// content source).

const { getStore } = require('@netlify/blobs');

const BLOBS_CONFIG = {
  siteID: process.env.NETLIFY_SITE_ID,
  token: process.env.NETLIFY_BLOBS_TOKEN
};

const DAILY_CAP = 25;
const MAX_INPUT_CHARS = 24000;   // the messy process description
const MAX_REFERENCE_CHARS = 16000; // the optional reference SOP

exports.handler = async (event) => {
  const store = getStore({ name: 'sops', ...BLOBS_CONFIG });
  let jobId = null;

  try {
    const body = JSON.parse(event.body || '{}');
    jobId = body.jobId;
    const rawText = (body.text || '').slice(0, MAX_INPUT_CHARS);
    const referenceText = (body.reference || '').slice(0, MAX_REFERENCE_CHARS);

    if (!jobId || !rawText.trim()) {
      return;
    }

    await store.setJSON(jobId, { status: 'pending' });

    // --- Guardrail 1: daily rate limit ---
    const today = new Date().toISOString().slice(0, 10);
    const limitStore = getStore({ name: 'rate-limits', ...BLOBS_CONFIG });
    const counterKey = `sops-${today}`;
    let count = 0;
    try {
      const existing = await limitStore.get(counterKey);
      count = existing ? parseInt(existing, 10) : 0;
    } catch (e) {
      count = 0;
    }
    if (count >= DAILY_CAP) {
      await store.setJSON(jobId, {
        status: 'error',
        message: "Today's free generation limit has been reached. Come back tomorrow."
      });
      return;
    }
    await limitStore.set(counterKey, String(count + 1));

    // --- Guardrail 2: PII scrub, both inputs ---
    const { scrubbed: scrubbedProcess, scrubCounts: scrubCountsProcess } = scrubPII(rawText);
    const hasReference = referenceText.trim().length > 0;
    const { scrubbed: scrubbedReference, scrubCounts: scrubCountsReference } = hasReference
      ? scrubPII(referenceText)
      : { scrubbed: '', scrubCounts: { emails: 0, phones: 0 } };

    const scrubCounts = {
      emails: scrubCountsProcess.emails + scrubCountsReference.emails,
      phones: scrubCountsProcess.phones + scrubCountsReference.phones
    };

    // --- Call 1: draft the SOP, optionally grounded on reference style ---
    const draftUserContent = hasReference
      ? DRAFT_PROMPT_WITH_REFERENCE
          .replace('{{REFERENCE}}', scrubbedReference)
          .replace('{{PROCESS}}', scrubbedProcess)
      : DRAFT_PROMPT_NO_REFERENCE.replace('{{PROCESS}}', scrubbedProcess);

    const draft = await callClaude([{ role: 'user', content: draftUserContent }]);
    const draftJSON = parseModelJSON(draft);

    // --- Call 2: auditor ~ completeness + reference-leakage check ---
    const auditUserContent =
      AUDIT_PROMPT +
      (hasReference
        ? '\n\n<reference_sop_style_only>\n' + scrubbedReference + '\n</reference_sop_style_only>'
        : '') +
      '\n\n<raw_process>\n' + scrubbedProcess + '\n</raw_process>\n\n<draft_sop>\n' +
      JSON.stringify(draftJSON) +
      '\n</draft_sop>';

    const audited = await callClaude([{ role: 'user', content: auditUserContent }]);
    const finalJSON = parseModelJSON(audited);

    await store.setJSON(jobId, {
      status: 'done',
      sop: finalJSON,
      styleMatched: hasReference,
      scrubCounts
    });
  } catch (err) {
    console.error('generate-sop error:', err);
    if (jobId) {
      try {
        await store.setJSON(jobId, {
          status: 'error',
          message: 'Generation failed. Try again in a minute.'
        });
      } catch (e) {}
    }
  }
};

// ---------------------------------------------------------------------------

function scrubPII(text) {
  const scrubCounts = { emails: 0, phones: 0 };

  let out = text.replace(
    /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
    () => { scrubCounts.emails++; return '[email removed]'; }
  );

  out = out.replace(
    /(?<![A-Za-z0-9-])(\+?\d[\d\s()./-]{6,}\d)(?![A-Za-z0-9])/g,
    (match) => {
      const digits = match.replace(/\D/g, '');
      const seps = (match.match(/[/-]/g) || []).length;
      const looksLikeDate = digits.length === 8 && seps === 2;
      if (digits.length >= 8 && digits.length <= 15 && !looksLikeDate) {
        scrubCounts.phones++;
        return '[phone removed]';
      }
      return match;
    }
  );

  return { scrubbed: out, scrubCounts };
}

async function callClaude(messages) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 2500,
      messages
    })
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error('Anthropic API ' + res.status + ': ' + errText.slice(0, 300));
  }

  const data = await res.json();
  return data.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

function parseModelJSON(text) {
  const clean = text.replace(/```json|```/g, '').trim();
  const start = clean.indexOf('{');
  const end = clean.lastIndexOf('}');
  if (start === -1 || end === -1) {
    throw new Error('Model did not return JSON.');
  }
  return JSON.parse(clean.slice(start, end + 1));
}

// ---------------------------------------------------------------------------

const SOP_JSON_SHAPE = `{
  "title": "Short descriptive SOP title",
  "purpose": "One sentence: when to use this SOP and why it exists.",
  "steps": [{"step": "Short imperative instruction", "detail": "One clarifying line if needed, else empty string"}],
  "tools": ["Systems, tools, or platforms referenced in the process"],
  "exceptions": [{"case": "The edge case or exception", "handling": "What to do when it happens"}]
}`;

const DRAFT_PROMPT_NO_REFERENCE = `You are an experienced Chief of Staff turning a rambled, messy process description into a clean, numbered Standard Operating Procedure.

Respond with ONLY a JSON object, no preamble, no markdown fences, in exactly this shape:
${SOP_JSON_SHAPE}

Rules:
- Steps must be in the correct real-world order, even if the speaker mentioned them out of sequence.
- Never invent tools, steps, or exceptions not grounded in the input.
- Keep every step tight, actionable, and unambiguous, written for someone who has never done this process before.

<raw_process>
{{PROCESS}}
</raw_process>`;

const DRAFT_PROMPT_WITH_REFERENCE = `You are an experienced Chief of Staff turning a rambled, messy process description into a clean, numbered Standard Operating Procedure.

You have been given a REFERENCE SOP below from the same team's existing documentation. Use the reference ONLY to learn structural and stylistic conventions: how formal or casual the language is, how steps are phrased and numbered, how exceptions are typically framed, the general level of detail per step.

CRITICAL: Do not copy, reference, or reuse any actual steps, tools, names, or specific facts from the reference SOP in your output. It is a style guide, not a content source. The new SOP is about a completely different process and must be built only from the raw process description below.

Respond with ONLY a JSON object, no preamble, no markdown fences, in exactly this shape:
${SOP_JSON_SHAPE}

<reference_sop_style_only>
{{REFERENCE}}
</reference_sop_style_only>

<raw_process>
{{PROCESS}}
</raw_process>`;

const AUDIT_PROMPT = `You are an auditor reviewing another assistant's SOP draft against the raw process description it was built from. Your job:

1. Check whether any SIGNIFICANT step, tool, or exception mentioned in the raw process is missing from the draft.
2. Check that no step, tool, or exception was invented or distorted.
3. If a reference SOP was provided (marked reference_sop_style_only below), verify the draft did NOT copy any of its actual content (specific steps, tools, or facts), only its style. Flag it if it did.
4. Produce the corrected final SOP.

Respond with ONLY a JSON object, no preamble, no markdown fences, in exactly the same shape as the draft, plus one extra field:

"audit_flags": ["short note per correction made, e.g. 'Added missed step: confirm signed NDA before granting system access'", ...]

If the draft was already complete, accurate, and free of reference-content leakage, return it unchanged with "audit_flags": [].`;
