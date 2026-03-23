require("dotenv").config();

const http = require("node:http");

const express = require("express");
const cors = require("cors");
const { Server } = require("socket.io");
const { v4: uuidv4 } = require("uuid");
const { z } = require("zod");

const PORT = Number(process.env.PORT || 4000);
const HOST = process.env.HOST || "0.0.0.0";
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const OPENAI_TRANSCRIPTION_MODEL = process.env.OPENAI_TRANSCRIPTION_MODEL || "whisper-1";
const TAVILY_API_KEY = process.env.TAVILY_API_KEY;
const INTERVENTION_CONFIDENCE_THRESHOLD = Number(process.env.INTERVENTION_CONFIDENCE_THRESHOLD || "0.75");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: CORS_ORIGIN === "*" ? true : CORS_ORIGIN.split(",")
  }
});

const sessionStartPayloadSchema = z.object({
  deviceId: z.string().min(1),
  chunkMs: z.literal(4000),
  sampleRate: z.literal(16000)
});

const socketAudioChunkPayloadSchema = z.object({
  sessionId: z.string().min(1),
  seq: z.number().int().nonnegative(),
  startedAt: z.string(),
  endedAt: z.string(),
  pcm16Mono: z.string().min(1)
});

const sessionStopPayloadSchema = z.object({
  sessionId: z.string().min(1)
});

const sourceCitationSchema = z.object({
  title: z.string(),
  url: z.string().url(),
  snippet: z.string(),
  publishedAt: z.string().nullish(),
  sourceType: z.enum(["web", "kb", "manual"]).default("web")
});

const claimAssessmentSchema = z.object({
  isVerifiable: z.boolean(),
  claimText: z.string().default(""),
  query: z.string().default(""),
  confidence: z.number().min(0).max(1).default(0),
  rationale: z.string().default("")
});

const verificationSchema = z.object({
  verdict: z.enum(["true", "false", "misleading", "unverified"]),
  confidence: z.number().min(0).max(1),
  correction: z.string()
});

app.use(cors({ origin: CORS_ORIGIN === "*" ? true : CORS_ORIGIN.split(",") }));
app.use(express.json());

const sessions = new Map();

app.get("/health", (_request, response) => {
  response.json({
    status: "ok",
    service: "mock-ingestion",
    host: HOST,
    port: PORT,
    transcription: OPENAI_API_KEY ? "openai" : "heuristic",
    verification: OPENAI_API_KEY && TAVILY_API_KEY ? "openai+tavily" : "heuristic"
  });
});

app.post("/debug/evaluate", async (request, response) => {
  try {
    const body = z.object({
      text: z.string().min(1)
    }).parse(request.body);

    const session = createDebugSession();
    const transcript = createTranscriptSegment(session.sessionId, 1, body.text);
    const intervention = await maybeCreateIntervention(session, transcript);

    response.json({
      transcript,
      intervention
    });
  } catch (error) {
    response.status(400).json({
      error: error instanceof Error ? error.message : "Unknown error"
    });
  }
});

io.on("connection", (socket) => {
  console.log(`[mock-ingestion] socket connected ${socket.id}`);

  socket.on("session:start", (rawPayload, callback) => {
    try {
      const payload = sessionStartPayloadSchema.parse(rawPayload);
      const sessionId = uuidv4();

      sessions.set(sessionId, {
        socketId: socket.id,
        deviceId: payload.deviceId,
        chunkMs: payload.chunkMs,
        sampleRate: payload.sampleRate,
        startedAt: new Date().toISOString(),
        transcriptWindow: [],
        dedupeClaims: new Set()
      });

      console.log(`[mock-ingestion] session started ${sessionId}`);
      callback?.({ ok: true, sessionId });
    } catch (error) {
      callback?.({ ok: false, error: error instanceof Error ? error.message : "Unknown error" });
    }
  });

  socket.on("audio:chunk", async (rawPayload, callback) => {
    try {
      const payload = socketAudioChunkPayloadSchema.parse(rawPayload);
      const session = sessions.get(payload.sessionId);

      if (!session) {
        throw new Error(`Unknown session ${payload.sessionId}`);
      }

      callback?.({ ok: true });

      const transcriptText = await transcribeAudioChunk(payload, session.sampleRate);
      const transcript = createTranscriptSegment(
        payload.sessionId,
        payload.seq,
        transcriptText || `Audio chunk ${payload.seq} received.`,
        payload.startedAt,
        payload.endedAt
      );

      socket.emit("transcript:update", transcript);

      const intervention = await maybeCreateIntervention(session, transcript);
      if (intervention) {
        socket.emit("intervention:created", intervention);
      }
    } catch (error) {
      console.error("[mock-ingestion] audio chunk failed", error);
      callback?.({ ok: false, error: error instanceof Error ? error.message : "Unknown error" });
    }
  });

  socket.on("session:stop", (rawPayload, callback) => {
    try {
      const payload = sessionStopPayloadSchema.parse(rawPayload);
      sessions.delete(payload.sessionId);
      console.log(`[mock-ingestion] session stopped ${payload.sessionId}`);
      callback?.({ ok: true });
    } catch (error) {
      callback?.({ ok: false, error: error instanceof Error ? error.message : "Unknown error" });
    }
  });

  socket.on("disconnect", () => {
    for (const [sessionId, session] of sessions.entries()) {
      if (session.socketId === socket.id) {
        sessions.delete(sessionId);
      }
    }

    console.log(`[mock-ingestion] socket disconnected ${socket.id}`);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`[mock-ingestion] listening on http://${HOST}:${PORT}`);
});

function createDebugSession() {
  return {
    sessionId: `debug-${uuidv4()}`,
    transcriptWindow: [],
    dedupeClaims: new Set()
  };
}

function createTranscriptSegment(sessionId, seq, text, startedAt = new Date().toISOString(), endedAt = new Date().toISOString()) {
  return {
    segmentId: uuidv4(),
    sessionId,
    seq,
    text,
    startedAt,
    endedAt,
    speakerLabel: "unknown",
    confidence: 0.65
  };
}

async function maybeCreateIntervention(session, transcript) {
  session.transcriptWindow.push(transcript);
  session.transcriptWindow = session.transcriptWindow.sort((left, right) => left.seq - right.seq).slice(-3);

  const transcriptText = session.transcriptWindow.map((segment) => segment.text).join(" ").trim();
  if (!transcriptText) {
    return null;
  }

  const knownFalseClaim = findKnownFalseClaim(transcriptText);
  if (knownFalseClaim) {
    const dedupeKey = knownFalseClaim.claimText.trim().toLowerCase();
    if (session.dedupeClaims.has(dedupeKey)) {
      return null;
    }

    session.dedupeClaims.add(dedupeKey);

    return {
      messageId: uuidv4(),
      sessionId: transcript.sessionId,
      claimId: uuidv4(),
      claimText: knownFalseClaim.claimText,
      verdict: "false",
      confidence: knownFalseClaim.confidence,
      correction: knownFalseClaim.correction,
      sources: knownFalseClaim.sources,
      issuedAt: new Date().toISOString()
    };
  }

  const assessment = await assessClaim(transcriptText);
  if (!assessment || !assessment.isVerifiable || !assessment.claimText.trim()) {
    return null;
  }

  const dedupeKey = assessment.claimText.trim().toLowerCase();
  if (session.dedupeClaims.has(dedupeKey)) {
    return null;
  }

  const citations = await fetchCitations(assessment.query || assessment.claimText);
  const verification = await verifyClaim(assessment.claimText, citations);
  if (!["false", "misleading"].includes(verification.verdict) || verification.confidence < INTERVENTION_CONFIDENCE_THRESHOLD) {
    return null;
  }

  session.dedupeClaims.add(dedupeKey);

  return {
    messageId: uuidv4(),
    sessionId: transcript.sessionId,
    claimId: uuidv4(),
    claimText: assessment.claimText,
    verdict: verification.verdict,
    confidence: verification.confidence,
    correction: verification.correction,
    sources: citations,
    issuedAt: new Date().toISOString()
  };
}

async function transcribeAudioChunk(payload, sampleRate) {
  if (!OPENAI_API_KEY) {
    return "";
  }

  const audioBlob = new Blob([pcm16ToWavBuffer(payload.pcm16Mono, sampleRate)], {
    type: "audio/wav"
  });
  const formData = new FormData();
  formData.append("file", audioBlob, `chunk-${payload.seq}.wav`);
  formData.append("model", OPENAI_TRANSCRIPTION_MODEL);

  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`
    },
    body: formData
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI transcription failed: ${response.status} ${errorText}`);
  }

  const result = await response.json();
  return String(result.text || "").trim();
}

async function assessClaim(transcriptText) {
  const heuristic = assessClaimHeuristically(transcriptText);
  if (!OPENAI_API_KEY) {
    return heuristic;
  }

  try {
    const result = await callOpenAiJson(
      [
        {
          role: "system",
          content:
            "You are a factual claim detector. Determine whether the transcript contains one clear, verifiable factual claim. " +
            "Respond as JSON with keys: isVerifiable, claimText, query, confidence, rationale."
        },
        {
          role: "user",
          content: `Transcript:\n${transcriptText}`
        }
      ],
      claimAssessmentSchema
    );

    return result;
  } catch (error) {
    console.warn("[mock-ingestion] claim assessment fell back to heuristic", error);
    return heuristic;
  }
}

function assessClaimHeuristically(transcriptText) {
  if (!/\bis\b|\bare\b|\bwas\b|\bwere\b/i.test(transcriptText)) {
    return null;
  }

  const claimText = transcriptText.split(/[.?!]/)[0]?.trim() ?? transcriptText.trim();
  if (!claimText) {
    return null;
  }

  return {
    isVerifiable: true,
    claimText,
    query: claimText,
    confidence: 0.77,
    rationale: "Heuristic detector found a declarative factual statement."
  };
}

function findKnownFalseClaim(transcriptText) {
  const normalized = transcriptText
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (/\beiffel tower\b(?:\s+\w+){0,4}\s+in\s+berlin\b/.test(normalized)) {
    return {
      claimText: "The Eiffel Tower is in Berlin.",
      confidence: 0.97,
      correction: "That claim is incorrect. The Eiffel Tower is in Paris, France.",
      sources: []
    };
  }

  if (/\bearth\b(?:\s+\w+){0,4}\s+flat\b/.test(normalized)) {
    return {
      claimText: "The Earth is flat.",
      confidence: 0.97,
      correction: "That claim is incorrect. The Earth is an oblate spheroid, not flat.",
      sources: []
    };
  }

  if (/\bsun\b(?:\s+\w+){0,4}\s+around\s+the?\s*earth\b/.test(normalized)) {
    return {
      claimText: "The Sun revolves around the Earth.",
      confidence: 0.96,
      correction: "That claim is incorrect. The Earth revolves around the Sun.",
      sources: []
    };
  }

  return null;
}

async function fetchCitations(query) {
  if (!TAVILY_API_KEY) {
    return [];
  }

  try {
    const response = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        api_key: TAVILY_API_KEY,
        query,
        max_results: 5,
        include_answer: false
      })
    });

    if (!response.ok) {
      throw new Error(`Tavily search failed with status ${response.status}`);
    }

    const payload = z.object({
      results: z.array(z.object({
        title: z.string(),
        url: z.string().url(),
        content: z.string(),
        published_date: z.string().optional()
      }))
    }).parse(await response.json());

    return payload.results.map((result) =>
      sourceCitationSchema.parse({
        title: result.title,
        url: result.url,
        snippet: result.content,
        publishedAt: result.published_date ?? null,
        sourceType: "web"
      })
    );
  } catch (error) {
    console.warn("[mock-ingestion] citation lookup failed", error);
    return [];
  }
}

async function verifyClaim(claimText, citations) {
  const heuristic = verifyClaimHeuristically(claimText);
  if (!OPENAI_API_KEY || citations.length === 0) {
    return heuristic;
  }

  const evidence = citations
    .map((citation, index) => `${index + 1}. ${citation.title}\n${citation.snippet}\n${citation.url}`)
    .join("\n\n");

  try {
    return await callOpenAiJson(
      [
        {
          role: "system",
          content:
            "You are a fact verifier. Use only the supplied evidence to decide whether the claim is true, false, misleading, or unverified. " +
            "Respond as JSON with keys: verdict, confidence, correction."
        },
        {
          role: "user",
          content: `Claim:\n${claimText}\n\nEvidence:\n${evidence}`
        }
      ],
      verificationSchema
    );
  } catch (error) {
    console.warn("[mock-ingestion] claim verification fell back to heuristic", error);
    return heuristic;
  }
}

function verifyClaimHeuristically(claimText) {
  const normalized = claimText.trim().toLowerCase();

  if (normalized.includes("eiffel tower is in berlin")) {
    return {
      verdict: "false",
      confidence: 0.95,
      correction: "That claim is incorrect. The Eiffel Tower is in Paris, France."
    };
  }

  if (normalized.includes("earth is flat")) {
    return {
      verdict: "false",
      confidence: 0.96,
      correction: "That claim is incorrect. The Earth is an oblate spheroid, not flat."
    };
  }

  if (normalized.includes("sun revolves around the earth") || normalized.includes("sun revolves around earth")) {
    return {
      verdict: "false",
      confidence: 0.94,
      correction: "That claim is incorrect. The Earth revolves around the Sun."
    };
  }

  return {
    verdict: "unverified",
    confidence: 0.5,
    correction: "The local demo could not verify that claim."
  };
}

async function callOpenAiJson(messages, schema) {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      temperature: 0,
      response_format: {
        type: "json_object"
      },
      messages
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI chat completion failed: ${response.status} ${errorText}`);
  }

  const payload = await response.json();
  const content = payload.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("OpenAI response did not contain JSON content");
  }

  return schema.parse(JSON.parse(content));
}

function pcm16ToWavBuffer(base64Audio, sampleRate) {
  const pcmBuffer = Buffer.from(base64Audio, "base64");
  const wavBuffer = Buffer.alloc(44 + pcmBuffer.length);

  wavBuffer.write("RIFF", 0);
  wavBuffer.writeUInt32LE(36 + pcmBuffer.length, 4);
  wavBuffer.write("WAVE", 8);
  wavBuffer.write("fmt ", 12);
  wavBuffer.writeUInt32LE(16, 16);
  wavBuffer.writeUInt16LE(1, 20);
  wavBuffer.writeUInt16LE(1, 22);
  wavBuffer.writeUInt32LE(sampleRate, 24);
  wavBuffer.writeUInt32LE(sampleRate * 2, 28);
  wavBuffer.writeUInt16LE(2, 32);
  wavBuffer.writeUInt16LE(16, 34);
  wavBuffer.write("data", 36);
  wavBuffer.writeUInt32LE(pcmBuffer.length, 40);
  pcmBuffer.copy(wavBuffer, 44);

  return wavBuffer;
}
