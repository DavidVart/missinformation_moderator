import { Injectable } from "@angular/core";
import { environment } from "../../../environments/environment";

import type {
  CohortLeaderboardResponse,
  LeaderboardResponse,
  MonthlyReflection,
  TopicMisinformationPoint,
  TopicSummary
} from "@project-veritas/contracts";

function resolveAnalyticsUrl(): string {
  if (environment.analyticsUrl) {
    return environment.analyticsUrl;
  }

  const globalOverride = (globalThis as typeof globalThis & { __VERITAS_ANALYTICS_URL__?: string }).__VERITAS_ANALYTICS_URL__;
  if (globalOverride) {
    return globalOverride;
  }

  const defaultHost = globalThis.location?.hostname || "localhost";
  return `http://${defaultHost}:4006/api/analytics`;
}

@Injectable({ providedIn: "root" })
export class AnalyticsApiService {
  private readonly baseUrl = resolveAnalyticsUrl();

  async getGlobalLeaderboard(): Promise<LeaderboardResponse> {
    const response = await fetch(`${this.baseUrl}/leaderboards/global`);
    if (!response.ok) {
      throw new Error(`Leaderboard request failed with status ${response.status}`);
    }
    return response.json() as Promise<LeaderboardResponse>;
  }

  async getSchoolLeaderboard(): Promise<CohortLeaderboardResponse> {
    const response = await fetch(`${this.baseUrl}/leaderboards/schools`);
    if (!response.ok) {
      throw new Error(`School leaderboard request failed with status ${response.status}`);
    }
    return response.json() as Promise<CohortLeaderboardResponse>;
  }

  async getMajorLeaderboard(): Promise<CohortLeaderboardResponse> {
    const response = await fetch(`${this.baseUrl}/leaderboards/majors`);
    if (!response.ok) {
      throw new Error(`Major leaderboard request failed with status ${response.status}`);
    }
    return response.json() as Promise<CohortLeaderboardResponse>;
  }

  async getTopicLeaderboard(topicSlug: string): Promise<LeaderboardResponse> {
    const response = await fetch(`${this.baseUrl}/leaderboards/topics/${topicSlug}`);
    if (!response.ok) {
      throw new Error(`Topic leaderboard request failed with status ${response.status}`);
    }
    return response.json() as Promise<LeaderboardResponse>;
  }

  async getMonthlyReflection(month: string): Promise<MonthlyReflection | null> {
    const response = await fetch(`${this.baseUrl}/reflections/monthly?month=${month}`);
    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      throw new Error(`Reflection request failed with status ${response.status}`);
    }
    return response.json() as Promise<MonthlyReflection>;
  }

  async getSessionTopics(sessionId: string): Promise<TopicSummary[]> {
    const response = await fetch(`${this.baseUrl}/topics/session/${sessionId}`);
    if (!response.ok) {
      throw new Error(`Session topics request failed with status ${response.status}`);
    }
    const data = await response.json() as { topics: TopicSummary[] };
    return data.topics;
  }

  async getTopicMisinformation(topicSlug: string): Promise<TopicMisinformationPoint[]> {
    const response = await fetch(`${this.baseUrl}/topics/${topicSlug}/misinformation`);
    if (!response.ok) {
      throw new Error(`Topic misinformation request failed with status ${response.status}`);
    }
    const data = await response.json() as { points: TopicMisinformationPoint[] };
    return data.points;
  }
}
