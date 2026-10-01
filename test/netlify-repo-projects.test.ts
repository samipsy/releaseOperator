import { describe, expect, it } from "vitest";
import { netlifyProjectsForRepo, netlifyRepoKey } from "../src/netlify/repoProjects.js";

describe("netlifyProjectsForRepo", () => {
  it("maps landings, blog, quiz, and experiences to US + MX custom domains", () => {
    expect(netlifyProjectsForRepo("landings")?.us.site).toBe("landings.ipsy.com");
    expect(netlifyProjectsForRepo("landings")?.mx.site).toBe("landings.ipsy.mx");
    expect(netlifyProjectsForRepo("blog-microfrontend")?.us.site).toBe("blog.ipsy.com");
    expect(netlifyProjectsForRepo("quiz-microfrontend")?.mx.site).toBe("quiz.ipsy.mx");
    expect(netlifyProjectsForRepo("experiences")?.us.site).toBe("experiences.ipsy.com");
  });

  it("normalizes forked and microfrontend catalog names", () => {
    expect(netlifyRepoKey("landings-forked")).toBe("landings");
    expect(netlifyRepoKey("blog-microfrontend")).toBe("blog");
    expect(netlifyProjectsForRepo("landings-forked")?.mx.site).toBe("landings.ipsy.mx");
  });

  it("returns undefined for unmapped repos", () => {
    expect(netlifyProjectsForRepo("web")).toBeUndefined();
  });
});
