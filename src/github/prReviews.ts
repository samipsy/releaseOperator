import type { GithubPullRequestReview } from "./types.js";

export type GithubReviewVerdict =
  | { kind: "approve"; userLogin: string }
  | { kind: "reject"; userLogin: string }
  | { kind: "none" };

/**
 * Latest submitted review per user wins. CHANGES_REQUESTED blocks; otherwise any APPROVED
 * is enough (same bar as a single Slack approve).
 */
export function classifyPullRequestReviews(reviews: GithubPullRequestReview[]): GithubReviewVerdict {
  const latest = new Map<string, string>();
  for (const review of reviews) {
    const login = review.userLogin.trim();
    if (!login) continue;
    const state = review.state.trim().toUpperCase();
    if (state === "PENDING" || state === "COMMENTED") continue;
    latest.set(login, state);
  }
  for (const [userLogin, state] of latest) {
    if (state === "CHANGES_REQUESTED") return { kind: "reject", userLogin };
  }
  for (const [userLogin, state] of latest) {
    if (state === "APPROVED") return { kind: "approve", userLogin };
  }
  return { kind: "none" };
}
