import { describe, expect, it } from "vitest";

import { mapInterventions } from "../src/queries.js";

describe("history queries", () => {
  it("groups sources under interventions", () => {
    const interventions = mapInterventions([
      {
        message_id: "msg_1",
        claim_id: "claim_1",
        verdict: "false",
        confidence: 0.9,
        correction: "Corrected.",
        issued_at: "2026-03-18T20:00:00.000Z",
        claim_text: "Claim text",
        source_title: "Source A",
        source_url: "https://example.com",
        source_snippet: "Snippet A",
        source_published_at: null,
        source_type: "web"
      }
    ]);

    expect(interventions).toHaveLength(1);
    expect(interventions[0]?.sources).toHaveLength(1);
  });
});
