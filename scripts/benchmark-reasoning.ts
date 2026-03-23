import { performance } from "node:perf_hooks";

import { config as loadEnv } from "dotenv";

import { createReasoningEngine, fetchCitations } from "../services/reasoning/src/reasoning-engine.ts";

loadEnv({
  path: ".env"
});

type BenchmarkSample = {
  run: number;
  assessMs: number;
  tavilyMs: number;
  verifyMs: number;
  totalMs: number;
  verdict: string;
  confidence: number;
  sources: number;
};

function percentile(sortedValues: number[], ratio: number) {
  if (sortedValues.length === 0) {
    return 0;
  }

  const index = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.ceil(sortedValues.length * ratio) - 1)
  );

  return sortedValues[index] ?? 0;
}

function withTimeout<T>(promise: Promise<T>, label: string, ms = 20000): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => {
        reject(new Error(`${label} timed out after ${ms}ms`));
      }, ms);
    })
  ]);
}

async function main() {
  const runs = Number(process.argv[2] ?? 3);
  console.log(`benchmark:start runs=${runs}`);

  const engine = createReasoningEngine({
    openAiApiKey: process.env.OPENAI_API_KEY,
    openAiModel: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
    tavilyApiKey: process.env.TAVILY_API_KEY
  });

  const transcriptWindow = [
    {
      segmentId: "segment-1",
      sessionId: "session-bench",
      seq: 1,
      text: "The Eiffel Tower is in Berlin.",
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      speakerLabel: "unknown" as const
    }
  ];

  const samples: BenchmarkSample[] = [];

  for (let index = 0; index < runs; index += 1) {
    console.log(`run:${index + 1}:assess:start`);
    const t0 = performance.now();
    const assessment = await withTimeout(
      engine.assessWindow("session-bench", transcriptWindow),
      "claim detection"
    );
    const t1 = performance.now();
    console.log(`run:${index + 1}:assess:done ${Math.round(t1 - t0)}ms`);

    if (!assessment) {
      throw new Error("No claim assessment returned");
    }

    console.log(`run:${index + 1}:tavily:start`);
    const citations = await withTimeout(
      fetchCitations(assessment.query, process.env.TAVILY_API_KEY),
      "tavily search"
    );
    const t2 = performance.now();
    console.log(`run:${index + 1}:tavily:done ${Math.round(t2 - t1)}ms`);

    console.log(`run:${index + 1}:verify:start`);
    const verification = await withTimeout(
      engine.verifyClaim(assessment, citations),
      "claim verification"
    );
    const t3 = performance.now();
    console.log(`run:${index + 1}:verify:done ${Math.round(t3 - t2)}ms`);

    samples.push({
      run: index + 1,
      assessMs: Math.round(t1 - t0),
      tavilyMs: Math.round(t2 - t1),
      verifyMs: Math.round(t3 - t2),
      totalMs: Math.round(t3 - t0),
      verdict: verification.verdict,
      confidence: verification.confidence,
      sources: citations.length
    });
  }

  const totals = samples.map((sample) => sample.totalMs).sort((left, right) => left - right);

  console.log(JSON.stringify({
    samples,
    medianMs: percentile(totals, 0.5),
    p95Ms: percentile(totals, 0.95)
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
