export function mapSessionTranscript(rows: Array<Record<string, unknown>>) {
  return rows.map((row) => ({
    segmentId: row.segment_id,
    deviceId: row.device_id,
    userId: row.user_id,
    mode: row.mode,
    seq: row.seq,
    text: row.text,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    speakerLabel: row.speaker_label,
    speakerId: row.speaker_id,
    confidence: row.confidence
  }));
}

export function mapInterventions(rows: Array<Record<string, unknown>>) {
  const byMessageId = new Map<string, {
    messageId: string;
    claimId: string;
    userId?: string;
    mode: string;
    verdict: string;
    confidence: number;
    correction: string;
    issuedAt: string;
    claimText: string;
    sources: Array<{
      title: string;
      url: string;
      snippet: string;
      publishedAt: string | null;
      sourceType: string;
    }>;
  }>();

  for (const row of rows) {
    const messageId = row.message_id as string;

    if (!byMessageId.has(messageId)) {
      byMessageId.set(messageId, {
        messageId,
        claimId: row.claim_id as string,
        userId: row.user_id as string | undefined,
        mode: row.mode as string,
        verdict: row.verdict as string,
        confidence: Number(row.confidence),
        correction: row.correction as string,
        issuedAt: String(row.issued_at),
        claimText: row.claim_text as string,
        sources: []
      });
    }

    if (row.source_url) {
      byMessageId.get(messageId)?.sources.push({
        title: row.source_title as string,
        url: row.source_url as string,
        snippet: row.source_snippet as string,
        publishedAt: row.source_published_at ? String(row.source_published_at) : null,
        sourceType: row.source_type as string
      });
    }
  }

  return Array.from(byMessageId.values());
}
